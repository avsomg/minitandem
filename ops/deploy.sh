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
umask 077
LOCK=.deploy-lock
if ! mkdir "$LOCK" 2>/dev/null; then
  echo 'deploy: another operation owns the lock, or an interrupted operation needs recovery' >&2
  [ ! -f "$LOCK/owner" ] || cat "$LOCK/owner" >&2
  exit 1
fi
printf '%s\n' "$OP" > "$LOCK/id"
printf 'operation=%s\npid=%s\n' "$OP" "$$" > "$LOCK/owner"
mkdir -p .deployments
STATE=.deployments/$OP
PREV_TAG= PREV_REF= NEW_TAG= STAGE=locked PREVIEW_UP=0
PREVIEW=minitandem-preview-$OP
say() { printf '%s\n' "$*"; }
die() { say "deploy: $*" >&2; exit 1; }
field() { sed -n "s/.*\"$1\":\"\{0,1\}\([^\",}]*\).*/\1/p" | sed 's/^null$//'; }
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
cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  set +e
  if ! owns; then say "deploy: ownership changed; no cleanup or rollback of another operation ($OP)" >&2; exit "$status"; fi
  if [ "$PREVIEW_UP" = 1 ]; then docker rm -f "$PREVIEW" >/dev/null 2>&1; fi
  case "$STAGE" in
    checkout)
      if git checkout --quiet "$PREV_REF"; then record rolled-back; else record recovery-needed; fi ;;
    switched)
      if [ "$(sed -n 's/^MINITANDEM_TAG=//p' .env)" != "$NEW_TAG" ]; then
        record recovery-needed; say 'deploy: live tag changed externally; rollback refused' >&2
      elif git checkout --quiet "$PREV_REF" && set_tag "$PREV_TAG" && { docker compose up -d --no-build || docker compose up -d --build; } && wait_healthy; then
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
LIVE_RECORDS=$(printf '%s' "$LIVE" | field records)
[[ $LIVE_RECORDS =~ ^[0-9]+$ ]] || die 'live /healthz has no record count'
say "Live now: tag $PREV_TAG on $PREV_REF, $LIVE_RECORDS records"
git fetch --tags --quiet
git cat-file -e "$SHA^{commit}"
NEW_TAG=$(git rev-parse --short "$SHA")
if [ "$NEW_TAG" = "$PREV_TAG" ]; then record done; say 'Tag is already live; nothing to deploy.'; exit 0; fi
record checkout
git checkout --quiet --detach "$SHA"
MINITANDEM_TAG=$NEW_TAG docker compose build app
PREVIEW_UP=1
docker run -d --name "$PREVIEW" -p "127.0.0.1:$PORT:8787" --read-only --tmpfs /tmp \
  --tmpfs /state:rw,uid=1000,gid=1000,mode=0700,size=16m --cap-drop ALL --security-opt no-new-privileges:true --memory 512m --pids-limit 200 \
  -e MINITANDEM_COMMIT="$NEW_TAG" "minitandem-app:$NEW_TAG" >/dev/null
PREVIEW_JSON=
for i in $(seq "$TRIES"); do PREVIEW_JSON=$(curl -fsS --max-time 3 "http://127.0.0.1:$PORT/healthz") && break; sleep "$POLL"; done
PREVIEW_RECORDS=$(printf '%s' "$PREVIEW_JSON" | field records)
PREVIEW_REVISION=$(printf '%s' "$PREVIEW_JSON" | field revision)
PREVIEW_COMMIT=$(printf '%s' "$PREVIEW_JSON" | field commit)
[[ $PREVIEW_RECORDS =~ ^[0-9]+$ && -n $PREVIEW_REVISION ]] || die 'preview has no record count or no revision'
say "Preview: $PREVIEW_RECORDS records (live: $LIVE_RECORDS), revision $PREVIEW_REVISION, commit $PREVIEW_COMMIT"
[ $((PREVIEW_RECORDS * 100)) -ge $((LIVE_RECORDS * (100 - MAX_DROP))) ] || die "$PREVIEW_RECORDS records is more than $MAX_DROP % below the $LIVE_RECORDS records that are live"
record switched
owns || die 'operation ownership lost before switch'
set_tag "$NEW_TAG"
docker compose up -d --no-build
wait_healthy || die 'the new app container did not become healthy'
verified=0
for i in $(seq "$TRIES"); do
  answer=$(curl -fsS --max-time 10 "$URL/healthz" 2>/dev/null) || answer=
  if [ "$(printf '%s' "$answer" | field revision)" = "$PREVIEW_REVISION" ] && [ "$(printf '%s' "$answer" | field commit)" = "$PREVIEW_COMMIT" ]; then verified=1; break; fi
  sleep "$POLL"
done
[ "$verified" = 1 ] || die 'public /healthz does not show the previewed build'
record done
say "Deployed $SHA as tag $NEW_TAG. Previous tag: $PREV_TAG (checkout $PREV_REF)"
say "Recovery record: $STATE"
say "Rollback: inspect $STATE and follow docs/betrieb.md under the deployment lock."
REMOTE
