#!/usr/bin/env bash
# The owner deploys one full commit. All server work, including rollback, holds one lock in one SSH session.
# Normal exits and handled signals attempt rollback. Power loss/SIGKILL can leave a recovery record and a stale lock.
set -euo pipefail
HOST=${DEPLOY_HOST:-ubuntu@179.237.77.144}
KEY=${DEPLOY_KEY:-$HOME/.ssh/minitandem_ed25519}
DIR=${DEPLOY_DIR:-/opt/minitandem}
URL=${DEPLOY_URL:-https://minitandem.ch}
REPO=${DEPLOY_REPO:-avsomg/minitandem}
PORT=${DEPLOY_PORT:-18788}
MAX_DROP=${DEPLOY_MAX_DROP:-15}
TRIES=${DEPLOY_TRIES:-45}
POLL=${DEPLOY_POLL:-2}
[ "$#" -eq 1 ] || { echo 'usage: ops/deploy.sh <full commit sha>' >&2; exit 2; }
SHA=$1
[[ $SHA =~ ^[0-9a-f]{40}$ ]] || { echo 'not a full commit sha' >&2; exit 2; }
[[ $PORT =~ ^[0-9]+$ && $MAX_DROP =~ ^[0-9]+$ && $TRIES =~ ^[0-9]+$ && $POLL =~ ^[0-9]+([.][0-9]+)?$ ]] || exit 2
# Filter by the required workflow, then check its exact head and latest run. An unrelated green workflow is insufficient.
runs=$(gh run list --repo "$REPO" --workflow test.yml --commit "$SHA" --limit 1 --json conclusion,status,headSha)
printf '%s' "$runs" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const r=JSON.parse(s);if(!r.length)throw Error("no CI run for test.yml");if(r[0].headSha!==process.argv[1]||r[0].status!=="completed"||r[0].conclusion!=="success")throw Error("test.yml is not green for the exact commit");}catch(e){console.error(e.message);process.exitCode=1;}})' "$SHA"
OP=$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')
printf 'CI: test.yml succeeded for %s; operation %s\n' "$SHA" "$OP"
# Shell-quote the arguments for the remote login shell; the program itself arrives on stdin.
quote() { printf "'%s'" "${1//\'/\'\\\'\'}"; }
command='bash -s --'
for arg in "$DIR" "$SHA" "$URL" "$MAX_DROP" "$TRIES" "$POLL" "$PORT" "$OP"; do command="$command $(quote "$arg")"; done
ssh -i "$KEY" -o IdentitiesOnly=yes "$HOST" "$command" <<'REMOTE'
set -euo pipefail
DIR=$1 SHA=$2 URL=$3 MAX_DROP=$4 TRIES=$5 POLL=$6 PORT=$7 OP=$8
cd "$DIR"
# Only the lock and the operation records are private (their folders are 700). The checkout keeps the normal umask: the image is built
# from it, and a file the container user cannot read stops the app (16 October 2026: umask 077 here made the preview fail with EACCES).
LOCK=.deploy-lock
if ! mkdir -m 700 "$LOCK" 2>/dev/null; then
  echo 'deploy: another operation owns the lock, or an interrupted operation needs recovery' >&2
  [ ! -f "$LOCK/owner" ] || cat "$LOCK/owner" >&2
  exit 1
fi
printf '%s\n' "$OP" > "$LOCK/id"
printf 'operation=%s\npid=%s\n' "$OP" "$$" > "$LOCK/owner"
mkdir -p .deployments && chmod 700 .deployments
STATE=.deployments/$OP
PREV_TAG= PREV_REF= NEW_TAG= STAGE=locked PREVIEW_UP=0 EDGE_CHANGED=0 EDGE_RELEASE=0
LIVE= LIVE_FILES= LIVE_RECORDS= LIVE_STATIC_REVISION= LIVE_STATIC_COMMIT=
# A release with Caddy images has a preview of two containers (Caddy serving the files, the API behind it) on a private network;
# a release from before that (compose.yaml still runs the stock Caddy image) is previewed as one container, as it always was.
PREVIEW=minitandem-preview-$OP
PREVIEW_API=minitandem-preview-api-$OP
PREVIEW_NETWORK=minitandem-preview-net-$OP
say() { printf '%s\n' "$*"; }
die() {
  say "deploy: $*" >&2
  # A preview that failed to start or answered wrongly: its own messages are the first thing to read. They hold only this script's test requests.
  if [ "$PREVIEW_UP" = 1 ]; then docker logs --tail 20 "$PREVIEW" >&2 2>&1 || true; docker logs --tail 20 "$PREVIEW_API" >&2 2>&1 || true; fi
  exit 1
}
# A value of a JSON answer. /healthz is one line, build-info.json is indented: both are read by key, with or without a space after the colon.
field() { sed -n "s/.*\"$1\":[[:space:]]*\"\{0,1\}\([^\",}]*\).*/\1/p" | sed 's/^null$//'; }
owns() { [ "$(cat "$LOCK/id" 2>/dev/null)" = "$OP" ]; }
record() {
  STAGE=$1
  printf 'operation=%s\nstage=%s\nprevious_ref=%s\nprevious_tag=%s\ntarget_commit=%s\ntarget_tag=%s\nat=%s\n' \
    "$OP" "$STAGE" "$PREV_REF" "$PREV_TAG" "$SHA" "$NEW_TAG" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$STATE.tmp"
  mv "$STATE.tmp" "$STATE"
}
set_tag() { sed "s/^MINITANDEM_TAG=.*/MINITANDEM_TAG=$1/" .env > .env.new; cat .env.new > .env; rm -f .env.new; }
healthy() { [ "$(docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q app)")" = healthy ]; }
wait_healthy() { local i; for i in $(seq "$TRIES"); do healthy && return 0; sleep "$POLL"; done; return 1; }
# After a rollback the public site must be the one that was live before: the same API (records, revision, commit) and, where that site
# published them, the same files. A healthy container alone does not show that the files came back with it.
wait_previous() {
  local i answer files
  for i in $(seq "$TRIES"); do
    answer=$(curl -fsS --max-time 10 "$URL/healthz" 2>/dev/null) || answer=
    files=$(curl -fsS --max-time 10 "$URL/build-info.json" 2>/dev/null) || files=
    if [ "$(printf '%s' "$answer" | field records)" = "$LIVE_RECORDS" ] \
      && [ "$(printf '%s' "$answer" | field revision)" = "$(printf '%s' "$LIVE" | field revision)" ] \
      && [ "$(printf '%s' "$answer" | field commit)" = "$(printf '%s' "$LIVE" | field commit)" ] \
      && { [ -z "$LIVE_STATIC_REVISION" ] || { [ "$(printf '%s' "$files" | field revision)" = "$LIVE_STATIC_REVISION" ] \
        && [ "$(printf '%s' "$files" | field commit)" = "$LIVE_STATIC_COMMIT" ]; }; }; then return 0; fi
    sleep "$POLL"
  done
  return 1
}
# What a visitor and a browser get from Caddy's own files: the pages and files named below answer with the type they had, each with
# the security headers the service sent for them before Caddy served them (server.mjs staticFile and the edge), and without Via or
# Server; a folder without its slash is redirected; the API paths reach the service; the editor paths are refused. $1 is the base URL.
smoke() {
  local base=$1 pair path type head name code
  for pair in '/ text/html' '/projekt/ text/html' '/impressum/ text/html' '/datenschutz/ text/html' '/places/ text/html' '/sitemap.xml application/xml' \
    '/robots.txt text/plain' '/manifest.webmanifest application/manifest+json' '/sw.js text/javascript'; do
    path=${pair% *} type=${pair#* }
    head=$(curl -fsS --max-time 10 -o /dev/null -D - "$base$path" | tr -d '\r') || die "$base$path does not answer"
    printf '%s\n' "$head" | grep -qi "^content-type: *$type" || die "$base$path is not served as $type"
    for name in content-security-policy strict-transport-security x-content-type-options x-frame-options referrer-policy permissions-policy \
      cross-origin-opener-policy cross-origin-resource-policy cache-control; do
      printf '%s\n' "$head" | grep -qi "^$name:" || die "$base$path is served without $name"
    done
    ! printf '%s\n' "$head" | grep -qi '^via:' || die "$base$path is served with a Via header"
  done
  code=$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "$base/projekt" 2>/dev/null || true)
  [ "$code" = 301 ] || die "$base/projekt is not redirected with 301 (answer $code)"
  # The family routes answer 503 while family sync is off and 401 without a key once it is on; 404 or 502 would mean they do not reach the service.
  code=$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "$base/api/v1/family" 2>/dev/null || true)
  case "$code" in 401|503) ;; *) die "$base/api/v1/family does not reach the service (answer $code)" ;; esac
  for path in /admin /admin.js /admin.css /admin-icons.js /api/v1/admin/queue; do
    [ "$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "$base$path" 2>/dev/null || true)" = 404 ] || die "$base$path is not refused with 404"
  done
}
cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  set +e
  if ! owns; then say "deploy: ownership changed; no cleanup or rollback of another operation ($OP)" >&2; exit "$status"; fi
  if [ "$PREVIEW_UP" = 1 ]; then docker rm -f "$PREVIEW" "$PREVIEW_API" >/dev/null 2>&1; docker network rm "$PREVIEW_NETWORK" >/dev/null 2>&1; fi
  case "$STAGE" in
    checkout)
      if git checkout --quiet "$PREV_REF"; then record rolled-back; else record recovery-needed; fi ;;
    switched)
      if [ "$(sed -n 's/^MINITANDEM_TAG=//p' .env)" != "$NEW_TAG" ]; then
        record recovery-needed; say 'deploy: live tag changed externally; rollback refused' >&2
      elif git checkout --quiet "$PREV_REF" && set_tag "$PREV_TAG" && { docker compose up -d --no-build || docker compose up -d --build; } \
        && { [ "$EDGE_CHANGED" != 1 ] || docker compose up -d --no-build --force-recreate caddy; } && wait_healthy && wait_previous; then
        record rolled-back; say "Rolled back to tag $PREV_TAG ($PREV_REF); it is healthy."
      else record recovery-needed; say "ROLLBACK FAILED; recovery record: $STATE" >&2; fi ;;
  esac
  if [ "$status" -ne 0 ] && [[ $STAGE = locked || $STAGE = inspected ]]; then record failed; fi
  # A failed recovery stays locked for an explicit investigation. A completed operation releases only its own token.
  if [ "$STAGE" != recovery-needed ] && owns; then rm -f "$LOCK/id" "$LOCK/owner"; rmdir "$LOCK"; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
record locked
PREV_TAG=$(sed -n 's/^MINITANDEM_TAG=//p' .env)
[ -n "$PREV_TAG" ] || die 'no MINITANDEM_TAG in .env'
[[ $PREV_TAG =~ ^[A-Za-z0-9._-]+$ ]] || die 'invalid live tag'
PREV_REF=$(git symbolic-ref -q --short HEAD || git rev-parse HEAD)
record inspected
[ -z "$(git status --porcelain --untracked-files=no)" ] || die 'the server checkout has uncommitted changes'
LIVE=$(curl -fsS --max-time 10 "$URL/healthz") || die 'live /healthz does not answer'
# The files of the live site, if it publishes them (build-info.json): a rollback has to bring these back too, not only the API.
LIVE_FILES=$(curl -fsS --max-time 10 "$URL/build-info.json" 2>/dev/null) || LIVE_FILES=
LIVE_STATIC_REVISION=$(printf '%s' "$LIVE_FILES" | field revision)
LIVE_STATIC_COMMIT=$(printf '%s' "$LIVE_FILES" | field commit)
LIVE_RECORDS=$(printf '%s' "$LIVE" | field records)
[[ $LIVE_RECORDS =~ ^[0-9]+$ ]] || die 'live /healthz has no record count'
LIVE_PUBLISHED=$(printf '%s' "$LIVE" | field published)
LIVE_ARCHIVED=$(printf '%s' "$LIVE" | field archived)
if [ -z "$LIVE_PUBLISHED" ]; then
  LIVE_PUBLISHED=$LIVE_RECORDS
  say 'Warning: live image has no published count; using records for this transition.'
fi
[[ $LIVE_PUBLISHED =~ ^[0-9]+$ ]] || die 'invalid live published count'
say "Live now: tag $PREV_TAG on $PREV_REF, $LIVE_RECORDS records"
git fetch --tags --quiet
git cat-file -e "$SHA^{commit}"
NEW_TAG=$(git rev-parse --short "$SHA")
if [ "$NEW_TAG" = "$PREV_TAG" ]; then record done; say 'Tag is already live; nothing to deploy.'; exit 0; fi
record checkout
git checkout --quiet --detach "$SHA"
# A release with Caddy images (compose.yaml builds minitandem-caddy) has the public files, the Caddyfile and the log script inside the
# Caddy image: the files, the API and the configuration of one tag. An earlier release mounts the Caddyfile and the script from the checkout.
if grep -q '^[[:space:]]*image: minitandem-caddy:' compose.yaml; then EDGE_RELEASE=1; fi
# What Caddy reads from the checkout (bind mounts, earlier releases) or bakes into its image (the files below are the ones of this release).
# A checkout replaces the files, but a running container keeps the old ones and compose only recreates it when compose.yaml changes
# (18 October 2026: new headers were live only after a Caddy restart). So when they differ between the two commits, Caddy is validated
# and recreated with the switch.
git diff --quiet "$PREV_REF" "$SHA" -- docker/Caddyfile docker/site.caddy docker/preview.Caddyfile docker/access-log-entrypoint.sh || EDGE_CHANGED=1
if [ "$EDGE_RELEASE" = 1 ]; then MINITANDEM_TAG=$NEW_TAG docker compose build app caddy; else MINITANDEM_TAG=$NEW_TAG docker compose build app; fi
PREVIEW_UP=1
if [ "$EDGE_RELEASE" = 1 ]; then
  # The very images of the release, on a private network. The API runs without the public files in its way (MINITANDEM_API_ONLY=1), so
  # every file the preview answers comes from Caddy's own image. Only Caddy publishes a port, on the loopback of the server.
  docker network create "$PREVIEW_NETWORK" >/dev/null
  docker run -d --name "$PREVIEW_API" --network "$PREVIEW_NETWORK" --network-alias app --read-only --tmpfs /tmp \
    --tmpfs /state:rw,uid=1000,gid=1000,mode=0700,size=16m --cap-drop ALL --security-opt no-new-privileges:true --memory 512m --pids-limit 200 \
    -e MINITANDEM_API_ONLY=1 -e MINITANDEM_COMMIT="$NEW_TAG" "minitandem-app:$NEW_TAG" >/dev/null
  # The preview Caddyfile imports the same routes as the real one, on plain HTTP without certificates, an admin endpoint or an access log.
  docker run -d --name "$PREVIEW" --network "$PREVIEW_NETWORK" -p "127.0.0.1:$PORT:8080" --read-only \
    --tmpfs /tmp --tmpfs /data --tmpfs /config --cap-drop ALL --security-opt no-new-privileges:true --memory 256m --pids-limit 200 \
    "minitandem-caddy:$NEW_TAG" caddy run --config /etc/caddy/preview.Caddyfile --adapter caddyfile >/dev/null
else
  docker run -d --name "$PREVIEW" -p "127.0.0.1:$PORT:8787" --read-only --tmpfs /tmp \
    --tmpfs /state:rw,uid=1000,gid=1000,mode=0700,size=16m --cap-drop ALL --security-opt no-new-privileges:true --memory 512m --pids-limit 200 \
    -e MINITANDEM_COMMIT="$NEW_TAG" "minitandem-app:$NEW_TAG" >/dev/null
fi
PREVIEW_JSON=
for i in $(seq "$TRIES"); do PREVIEW_JSON=$(curl -fsS --max-time 3 "http://127.0.0.1:$PORT/healthz") && break; sleep "$POLL"; done
PREVIEW_RECORDS=$(printf '%s' "$PREVIEW_JSON" | field records)
PREVIEW_REVISION=$(printf '%s' "$PREVIEW_JSON" | field revision)
PREVIEW_COMMIT=$(printf '%s' "$PREVIEW_JSON" | field commit)
PREVIEW_PUBLISHED=$(printf '%s' "$PREVIEW_JSON" | field published)
PREVIEW_ARCHIVED=$(printf '%s' "$PREVIEW_JSON" | field archived)
[[ $PREVIEW_RECORDS =~ ^[0-9]+$ && -n $PREVIEW_REVISION ]] || die 'preview has no record count or no revision'
[[ $PREVIEW_PUBLISHED =~ ^[0-9]+$ && $PREVIEW_ARCHIVED =~ ^[0-9]+$ ]] || die 'preview has no valid published/archived counts'
[ $((PREVIEW_PUBLISHED + PREVIEW_ARCHIVED)) -eq "$PREVIEW_RECORDS" ] || die 'preview status counts do not sum to records'
say "Preview: $PREVIEW_RECORDS records (live: $LIVE_RECORDS), revision $PREVIEW_REVISION, commit $PREVIEW_COMMIT"
say "Status changes: published $LIVE_PUBLISHED -> $PREVIEW_PUBLISHED; archived ${LIVE_ARCHIVED:-unknown} -> $PREVIEW_ARCHIVED"
[ $((PREVIEW_PUBLISHED * 100)) -ge $((LIVE_PUBLISHED * (100 - MAX_DROP))) ] || die "$PREVIEW_PUBLISHED published cards is more than $MAX_DROP % below the $LIVE_PUBLISHED that are live"
if [ "$EDGE_RELEASE" = 1 ]; then
  # The files of this very release and the API of this very release: the same commit, the same catalogue, the same counts.
  [ "$PREVIEW_COMMIT" = "$NEW_TAG" ] || die 'the preview API reports another commit than the one being deployed'
  PREVIEW_FILES=$(curl -fsS --max-time 10 "http://127.0.0.1:$PORT/build-info.json") || die 'the preview does not serve build-info.json'
  for key in revision records published archived commit; do
    value=$(printf '%s' "$PREVIEW_FILES" | field "$key")
    [ -n "$value" ] && [ "$value" = "$(printf '%s' "$PREVIEW_JSON" | field "$key")" ] || die "the files of the preview disagree with its API: $key"
  done
  # The files Caddy answers are byte for byte the ones inside the API image of the same tag (both come from one build).
  for file in index.html app.js sw.js styles.css sitemap.xml; do
    served=$(curl -fsS --max-time 30 "http://127.0.0.1:$PORT/$file" | sha256sum | cut -d' ' -f1) || served=
    built=$(docker run --rm --network none --read-only --cap-drop ALL --entrypoint sha256sum "minitandem-app:$NEW_TAG" ".publish/$file" | cut -d' ' -f1) || built=
    [ -n "$served" ] && [ "$served" = "$built" ] || die "the preview serves another $file than the image of the API"
  done
  smoke "http://127.0.0.1:$PORT"
  say 'Preview files: same build and commit as the API; headers and editor paths as on the live site.'
fi
if [ "$EDGE_RELEASE" = 1 ] || [ "$EDGE_CHANGED" = 1 ]; then
  # The real Caddyfile (certificates, access log) cannot run in the preview; the Caddy image of the release has to accept it.
  if ! checked=$(MINITANDEM_TAG=$NEW_TAG docker compose run --rm --no-deps --entrypoint caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1); then
    printf '%s\n' "$checked" | tail -n 20 >&2
    die 'the new Caddyfile does not validate with the Caddy image'
  fi
  say 'Caddy configuration validates with the image of the release; Caddy is recreated with the switch.'
fi
record switched
owns || die 'operation ownership lost before switch'
set_tag "$NEW_TAG"
docker compose up -d --no-build
# A release with Caddy images gets a new Caddy from the new image tag anyway; an earlier one reads the files it was started with.
if [ "$EDGE_CHANGED" = 1 ] && [ "$EDGE_RELEASE" = 0 ]; then docker compose up -d --no-build --force-recreate caddy; fi
wait_healthy || die 'the new app container did not become healthy'
verified=0
for i in $(seq "$TRIES"); do
  answer=$(curl -fsS --max-time 10 "$URL/healthz" 2>/dev/null) || answer=
  files=
  if [ "$EDGE_RELEASE" = 1 ]; then files=$(curl -fsS --max-time 10 "$URL/build-info.json" 2>/dev/null) || files=; fi
  if [ "$(printf '%s' "$answer" | field revision)" = "$PREVIEW_REVISION" ] && [ "$(printf '%s' "$answer" | field commit)" = "$PREVIEW_COMMIT" ] \
    && { [ "$EDGE_RELEASE" = 0 ] || { [ "$(printf '%s' "$files" | field revision)" = "$PREVIEW_REVISION" ] && [ "$(printf '%s' "$files" | field commit)" = "$NEW_TAG" ]; }; }; then verified=1; break; fi
  sleep "$POLL"
done
[ "$verified" = 1 ] || die 'public /healthz (or, with Caddy images, the public files) does not show the previewed build'
# The public edge adds only certificates and the access log to what the preview answered; its headers and refused paths are checked once more here.
if [ "$EDGE_RELEASE" = 1 ]; then smoke "$URL"; fi
record done
say "Deployed $SHA as tag $NEW_TAG. Previous tag: $PREV_TAG (checkout $PREV_REF)"
say "Recovery record: $STATE"
say "Rollback: inspect $STATE and follow docs/betrieb.md under the deployment lock."
REMOTE
