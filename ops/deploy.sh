#!/usr/bin/env bash
# Deploys one commit to the Minitandem server, from the Mac: ops/deploy.sh <full 40-character commit sha>   (docs/betrieb.md, "Update").
# There is no default commit and nothing calls this script but the owner; the editorial cycle must never run it.
# What it does, in this order, and where it stops:
#   1. refuses unless GitHub CI succeeded for exactly that commit;
#   2. over ssh: remembers the live tag (.env), the checkout and the live record count (/healthz);
#   3. fetches and checks out the commit, builds the image under its own tag (the live container is untouched);
#   4. starts the new image once as a preview on 127.0.0.1 of the server, with a throw-away state, never the live volume;
#   5. refuses when the preview has more than 15 % fewer records than the live site;
#   6. only then sets the tag in .env and recreates the app from the image it previewed, waits until it is healthy,
#      and checks that the public /healthz shows the previewed revision and commit;
#   7. any failure after step 3 removes the preview and puts the previous checkout and tag back.
# It prints the previous tag and the rollback command at the end.
#
# Environment, for tests and for a second server (default in brackets):
#   DEPLOY_HOST [ubuntu@179.237.77.144]   DEPLOY_KEY [~/.ssh/minitandem_ed25519]   DEPLOY_DIR [/opt/minitandem]
#   DEPLOY_URL [https://minitandem.ch]    DEPLOY_REPO [avsomg/minitandem]          DEPLOY_PORT [18788] (preview, server side)
#   DEPLOY_MAX_DROP [15] percent          DEPLOY_TRIES [45] x DEPLOY_POLL [2] seconds: how long to wait for a health answer
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
PREVIEW=minitandem-preview
# How far the run has got, so that the exit trap knows what to undo: none, checkout, switched, done.
STAGE=none
PREVIEW_UP=0

say() { printf '%s\n' "$*"; }
die() { printf 'deploy: %s\n' "$*" >&2; exit 1; }
# A command in the checkout on the server.
remote() { ssh -i "$KEY" -o IdentitiesOnly=yes "$HOST" "cd '$DIR' && { $1; }"; }
# Repeats a shell test on the server until it passes (its output is the answer) or the tries are used up.
remote_until() { remote "for i in \$(seq $TRIES); do $1 && exit 0; sleep $POLL; done; exit 1"; }
# Number of matches of an extended regex in stdin; no match is 0, not an error.
count() { { grep -Eo "$1" || true; } | wc -l | tr -d ' '; }
# One field of the flat /healthz JSON (records, revision, commit); a missing field or null is empty.
field() { sed -n "s/.*\"$1\":\"\{0,1\}\([^\",}]*\).*/\1/p" | sed 's/^null$//'; }
# The shell text that writes a tag into .env on the server. It copies instead of using sed -i, which differs between systems.
set_tag() { printf "sed 's/^MINITANDEM_TAG=.*/MINITANDEM_TAG=%s/' .env > .env.new && cat .env.new > .env && rm -f .env.new" "$1"; }
# True when the app container reports healthy (its Dockerfile HEALTHCHECK asks /healthz).
APP_HEALTHY='[ "$(docker inspect --format "{{.State.Health.Status}}" "$(docker compose ps -q app)")" = healthy ]'

usage() { say "usage: ops/deploy.sh <commit>   (the full 40-character sha; there is no default, see docs/betrieb.md)" >&2; exit 2; }

# 1. CI must be green for this exact commit: at least one run, and every run of it succeeded (a run still going has no conclusion yet).
check_ci() {
  local runs total green
  runs=$(gh run list --repo "$REPO" --commit "$SHA" --json conclusion,status) || die "cannot ask GitHub about $SHA (is gh logged in?)"
  total=$(printf '%s' "$runs" | count '"status": ?"[a-z_]*"')
  green=$(printf '%s' "$runs" | count '"conclusion": ?"success"')
  [ "$total" -ge 1 ] || die "GitHub has no CI run for $SHA: push it and wait for the tests"
  [ "$green" -eq "$total" ] || die "CI is not green for $SHA ($green of $total runs succeeded)"
  say "CI: $green of $total runs succeeded for $SHA"
}

# 2. What is live now: the tag in .env, the checkout (branch or commit) to go back to, the record count and revision.
read_live() {
  PREV_TAG=$(remote "sed -n 's/^MINITANDEM_TAG=//p' .env")
  [ -n "$PREV_TAG" ] || die "no MINITANDEM_TAG in .env on the server; without it there is no way back (docs/betrieb.md, first deployment)"
  PREV_REF=$(remote "git symbolic-ref -q --short HEAD || git rev-parse HEAD")
  [ -z "$(remote "git status --porcelain --untracked-files=no")" ] || die "the checkout $DIR on the server has uncommitted changes"
  LIVE=$(curl -fsS --max-time 10 "$URL/healthz") || die "$URL/healthz does not answer; repair the live service first (manual steps: docs/betrieb.md)"
  LIVE_RECORDS=$(printf '%s' "$LIVE" | field records)
  [[ $LIVE_RECORDS =~ ^[0-9]+$ ]] || die "the live /healthz has no record count: $LIVE"
  LIVE_REVISION=$(printf '%s' "$LIVE" | field revision)
  say "Live now: tag $PREV_TAG on $PREV_REF, $LIVE_RECORDS records, revision ${LIVE_REVISION:-none (an image from before build-info.json)}"
  remote "docker image inspect minitandem-app:$PREV_TAG >/dev/null 2>&1" || say "Warning: the image minitandem-app:$PREV_TAG is gone; a rollback has to rebuild it."
}

# 3a. The commit must reach the server. A commit that is already live needs nothing.
fetch_commit() {
  remote "git fetch --tags --quiet && git cat-file -e '$SHA^{commit}'" || die "the server cannot fetch $SHA (is it pushed to GitHub?)"
  NEW_TAG=$(remote "git rev-parse --short '$SHA'")
  if [ "$NEW_TAG" = "$PREV_TAG" ]; then say "Tag $NEW_TAG is already live; nothing to deploy."; exit 0; fi
}

# 3b. Switch the checkout (compose.yaml, Dockerfile and the sources of the build come from it) and build under the new tag.
checkout_and_build() {
  STAGE=checkout
  remote "git checkout --quiet --detach '$SHA'"
  say "Building minitandem-app:$NEW_TAG on the server (the live service keeps running) ..."
  remote "MINITANDEM_TAG=$NEW_TAG docker compose build app"
}

# 4. The new image once, on 127.0.0.1 of the server only, with the live container's limits. Its /state is a tmpfs: the live volume
# is not mounted, so the preview can neither read family data nor write to it (the entrypoint makes its own demo family, gone with it).
start_preview() {
  PREVIEW_UP=1
  remote "docker rm -f $PREVIEW >/dev/null 2>&1; docker run -d --name $PREVIEW -p 127.0.0.1:$PORT:8787 --read-only --tmpfs /tmp \
    --tmpfs /state:rw,uid=1000,gid=1000,mode=0700,size=16m --cap-drop ALL --security-opt no-new-privileges:true --memory 512m --pids-limit 200 \
    -e MINITANDEM_COMMIT=$NEW_TAG minitandem-app:$NEW_TAG >/dev/null"
  PREVIEW_JSON=$(remote_until "curl -fsS --max-time 3 http://127.0.0.1:$PORT/healthz 2>/dev/null") || die "the preview does not answer on port $PORT (on the server: docker logs $PREVIEW)"
  PREVIEW_RECORDS=$(printf '%s' "$PREVIEW_JSON" | field records)
  PREVIEW_REVISION=$(printf '%s' "$PREVIEW_JSON" | field revision)
  PREVIEW_COMMIT=$(printf '%s' "$PREVIEW_JSON" | field commit)
}

# 5. The shrink guard: a catalogue that lost more than MAX_DROP percent of its records is a broken build, not an edit.
guard_records() {
  [[ $PREVIEW_RECORDS =~ ^[0-9]+$ && -n $PREVIEW_REVISION ]] || die "the preview's /healthz has no record count or no revision (a commit from before build-info.json?): $PREVIEW_JSON"
  say "Preview: $PREVIEW_RECORDS records (live: $LIVE_RECORDS), revision $PREVIEW_REVISION, commit ${PREVIEW_COMMIT:-none}"
  if [ $((PREVIEW_RECORDS * 100)) -lt $((LIVE_RECORDS * (100 - MAX_DROP))) ]; then
    die "refusing: $PREVIEW_RECORDS records is more than $MAX_DROP % below the $LIVE_RECORDS records that are live"
  fi
}

# 6a. The switch: the tag into .env, then the app is recreated from the image that was previewed (no new build).
switch_live() {
  STAGE=switched
  remote "docker rm -f $PREVIEW >/dev/null 2>&1; $(set_tag "$NEW_TAG") && docker compose up -d --no-build"
  PREVIEW_UP=0
  remote_until "$APP_HEALTHY" || die "the new app container did not become healthy"
}

# 6b. What the public sees must be what was previewed. Caddy needs a moment (its own health check) to send traffic to the new container.
verify_public() {
  local i answer=
  for i in $(seq "$TRIES"); do
    answer=$(curl -fsS --max-time 10 "$URL/healthz" 2>/dev/null) || answer=
    [ "$(printf '%s' "$answer" | field revision)" = "$PREVIEW_REVISION" ] && [ "$(printf '%s' "$answer" | field commit)" = "$PREVIEW_COMMIT" ] && return 0
    sleep "$POLL"
  done
  die "$URL/healthz does not show the previewed build (wanted revision $PREVIEW_REVISION, commit ${PREVIEW_COMMIT:-none}; last answer: ${answer:-none})"
}

# The way back, as shell text for the server: the old checkout, the old tag in .env, the old image (rebuilt if it was pruned).
rollback_command() {
  printf "git checkout --quiet '%s' && %s && { docker compose up -d --no-build || docker compose up -d --build; }" "$PREV_REF" "$(set_tag "$PREV_TAG")"
}

finish() {
  STAGE=done
  say ""
  say "Deployed $SHA as tag $NEW_TAG. $URL/healthz shows revision $PREVIEW_REVISION and commit $PREVIEW_COMMIT."
  say "Previous tag: $PREV_TAG (checkout $PREV_REF)"
  say "Rollback:  ssh -i $KEY -o IdentitiesOnly=yes $HOST \"cd $DIR && $(rollback_command)\""
}

# 7. Runs on every exit. Whatever failed, the preview goes away and the server is left on the previous version.
on_exit() {
  local status=$?
  trap - EXIT
  set +e
  if [ "$PREVIEW_UP" = 1 ]; then
    [ "$status" -ne 0 ] && remote "docker logs --tail 15 $PREVIEW"
    remote "docker rm -f $PREVIEW >/dev/null 2>&1"
  fi
  case $STAGE in
    checkout)
      remote "git checkout --quiet '$PREV_REF'" && say "Deploy failed before the switch: the checkout is back on $PREV_REF, the live service was not touched." ;;
    switched)
      say "Deploy failed after the switch: putting tag $PREV_TAG back ..."
      if remote "$(rollback_command)" && remote_until "$APP_HEALTHY"; then say "Rolled back to tag $PREV_TAG ($PREV_REF); it is healthy."
      else say "ROLLBACK FAILED. By hand on the server: cd $DIR && $(rollback_command)"; fi ;;
  esac
  exit "$status"
}

main() {
  [ "$#" -eq 1 ] || usage
  SHA=$1
  [[ $SHA =~ ^[0-9a-f]{40}$ ]] || die "'$SHA' is not a full commit sha; use git rev-parse <ref>"
  trap on_exit EXIT
  trap 'exit 130' INT TERM
  check_ci
  read_live
  fetch_commit
  checkout_and_build
  start_preview
  guard_records
  switch_live
  verify_public
  finish
}
main "$@"
