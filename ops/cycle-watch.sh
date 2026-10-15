#!/bin/sh
# Watches the editorial cycle on the owner's Mac from this server and sends one e-mail whenever one of three states changes
# (a problem begins, a problem ends). Run it from a systemd timer every 30 minutes (ops/systemd/minitandem-cycle-watch.*, docs/betrieb.md).
# The mail goes through any sendmail-compatible program, like ops/healthcheck.sh; the same HEALTH_MAIL_* settings apply.
#
# What it reads (written by ops/drop.sh when the Mac calls in):
#   $WATCH_DIR/heartbeat.json   one line of JSON after every cycle (ops/cycle-run.mjs)
#   $WATCH_DIR/backup.json      {"at","name","bytes"} after every stored daily archive (ops/editorial-offsite.mjs)
# The age of a file is the age of the file itself on this server, so a wrong clock on the Mac cannot hide a silence.
#
# The three checks, each with its own remembered state in $WATCH_STATE_DIR:
#   silent  no heartbeat for more than WATCH_SILENT_HOURS (cycle silent / cycle is running again)
#   failed  the last heartbeat says ok:false and not paused (cycle failed / cycle works again). Its "reason" is named in the mail:
#             exit        the cycle exited with a non-zero code
#             no-receipt  the cycle exited with 0 but left no receipt of that very run (a run id from ops/cycle-run.mjs), so nothing is known about its work
#             needs-owner the cycle finished and itself says it needs the owner
#   backup  no archive for more than WATCH_BACKUP_HOURS (off-site copy missing / off-site copy is back)
# A file that does not exist yet counts from the watcher's first run, so installing the watcher before the Mac sends anything stays quiet
# until the period has passed. A pause (paused:true) and a skipped run (skipped:"another cycle is still running") count as alive and leave the
# failed state as it was: neither is work that succeeded, neither is a failure.
# A mail that cannot be sent is not remembered as sent: the next run tries again.
#
# Environment:
#   HEALTH_MAIL_TO       recipient (required)
#   HEALTH_MAIL_FROM     sender address the relay accepts (default: the recipient)
#   HEALTH_SENDMAIL      sendmail-compatible command, read as "sendmail -t" (default sendmail)
#   WATCH_DIR            default /var/lib/minitandem-watch
#   WATCH_STATE_DIR      default /var/lib/minitandem-cycle-watch
#   WATCH_SILENT_HOURS   default 10 (the cycle runs 07:30 to 22:30 every three hours: the night gap is nine hours)
#   WATCH_BACKUP_HOURS   default 36 (one missed day is tolerated)
#   WATCH_NOW            seconds since 1970, for tests (default: now)
# Exit code: 0 all fine, 1 at least one problem is open, 2 a mail could not be sent.
set -u
LC_ALL=C
export LC_ALL
MAIL_TO="${HEALTH_MAIL_TO:?HEALTH_MAIL_TO is not set}"
MAIL_FROM="${HEALTH_MAIL_FROM:-$MAIL_TO}"
SENDMAIL="${HEALTH_SENDMAIL:-sendmail}"
WATCH_DIR="${WATCH_DIR:-/var/lib/minitandem-watch}"
STATE_DIR="${WATCH_STATE_DIR:-/var/lib/minitandem-cycle-watch}"
SILENT_HOURS="${WATCH_SILENT_HOURS:-10}"
BACKUP_HOURS="${WATCH_BACKUP_HOURS:-36}"
NOW="${WATCH_NOW:-$(date +%s)}"
PREFIX="Minitandem editorial:"
HEARTBEAT="$WATCH_DIR/heartbeat.json"
BACKUP="$WATCH_DIR/backup.json"
mail_failed=0

mkdir -p "$STATE_DIR" || { echo "cannot create $STATE_DIR" >&2; exit 2; }

mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; } # GNU stat, then BSD stat
fmt() { date -u -d "@$1" '+%Y-%m-%d %H:%M UTC' 2>/dev/null || date -u -r "$1" '+%Y-%m-%d %H:%M UTC'; }
hours() { echo $(( $1 / 3600 )); }
# Parts of a file the Mac wrote are data: printable characters only, whatever it holds
printable() { tr -cd '[:print:]\n' | head -c "${1:-300}"; }
field() { printf '%s' "$2" | sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | printable; }       # string field
number() { printf '%s' "$2" | sed -n "s/.*\"$1\":\(-\{0,1\}[0-9]\{1,9\}\).*/\1/p" | printable 12; }

# The moment the watcher first ran: the starting point for files that do not exist yet
if [ -f "$STATE_DIR/first-run" ]; then first=$(cat "$STATE_DIR/first-run"); else first=$NOW; printf '%s\n' "$NOW" > "$STATE_DIR/first-run"; fi

state_of() { if [ -f "$STATE_DIR/$1" ]; then cat "$STATE_DIR/$1"; else echo ok; fi; }

# send SUBJECT BODY: one mail through sendmail -t
send() {
  {
    printf 'To: %s\nFrom: %s\nSubject: %s %s\n\n' "$MAIL_TO" "$MAIL_FROM" "$PREFIX" "$1"
    printf '%s\n' "$2"
  } | $SENDMAIL -t
}

# change NAME NEWSTATE PROBLEM_SUBJECT PROBLEM_BODY RECOVERY_SUBJECT RECOVERY_BODY
# Mails only when NEWSTATE differs from the remembered state, and remembers the new state only after the mail went out.
change() {
  [ "$2" = "$(state_of "$1")" ] && return 0
  if [ "$2" = problem ]; then send "$3" "$4"; else send "$5" "$6"; fi || { mail_failed=1; return 0; }
  printf '%s\n' "$2" > "$STATE_DIR/$1"
}

# ---- 1. silent
if [ -f "$HEARTBEAT" ]; then last_hb=$(mtime "$HEARTBEAT"); else last_hb=$first; fi
age=$(( NOW - last_hb ))
if [ -f "$HEARTBEAT" ]; then seen="Last heartbeat: $(fmt "$last_hb")."; else seen="No heartbeat has arrived since the watcher started ($(fmt "$first"))."; fi
if [ "$age" -gt $(( SILENT_HOURS * 3600 )) ]; then silent=problem; else silent=ok; fi
change silent "$silent" \
  "cycle silent" \
  "The editorial cycle on the Mac has sent no heartbeat for $(hours "$age") hours (limit: $SILENT_HOURS).
$seen
It normally runs every three hours from 07:30 to 22:30 Zurich time. Likely causes: the Mac is asleep or off, the launchd agent
ch.minitandem.editorial-cycle is not loaded, the Mac has no network, or the drop key no longer works.
On the Mac: tail ~/Library/Logs/minitandem-editorial-cycle.log and launchctl list | grep minitandem." \
  "cycle is running again" \
  "The editorial cycle on the Mac has sent a heartbeat again. $seen"

# ---- 2. failed (judged on the last heartbeat; a silent Mac leaves this state as it was)
if [ -f "$HEARTBEAT" ]; then
  hb=$(head -c 16384 "$HEARTBEAT")
  failed=""
  if printf '%s' "$hb" | grep -q '"paused":true'; then failed=""            # paused: alive, no judgement
  elif printf '%s' "$hb" | grep -q '"skipped":"'; then failed=""             # skipped (another cycle is running): alive, no judgement
  elif printf '%s' "$hb" | grep -q '"ok":false'; then failed=problem
  elif printf '%s' "$hb" | grep -q '"ok":true'; then failed=ok
  fi
  if [ -n "$failed" ]; then
    steps=$(printf '%s' "$hb" | sed -n 's/.*"failedSteps":\[\([^]]*\)\].*/\1/p' | tr -d '"' | printable)
    owner=$(printf '%s' "$hb" | sed -n 's/.*"needsOwner":{[^}]*"text":"\([^"]*\)".*/\1/p' | printable)
    code=$(number exit "$hb")
    reason=$(field reason "$hb" | tr -cd 'a-z-')
    case "$reason" in
      exit) why="exit: the cycle exited with a non-zero code" ;;
      no-receipt) why="no-receipt: the cycle exited with 0 but left no receipt of this run (editorial/workflow-state/cycle/latest.json was missing, unreadable or written by another run), so it is not known what it did" ;;
      needs-owner) why="needs-owner: the cycle finished and says itself that something needs the owner (see below)" ;;
      "") why="not stated (heartbeat from an older version)" ;;
      *) why="$reason" ;;
    esac
    change failed "$failed" \
      "cycle failed" \
      "The editorial cycle on the Mac failed or needs the owner.
Heartbeat received: $(fmt "$last_hb")
Exit code: ${code:-unknown}
Reason: $why
Failed steps: ${steps:-none named}
Needs the owner: ${owner:-nothing named}
On the Mac: node editorial/cycle.mjs --status shows the last record; the log is ~/Library/Logs/minitandem-editorial-cycle.log." \
      "cycle works again" \
      "The editorial cycle on the Mac reported a clean run again (heartbeat received $(fmt "$last_hb"))."
  fi
fi

# ---- 3. backup
if [ -f "$BACKUP" ]; then last_bk=$(mtime "$BACKUP"); else last_bk=$first; fi
bk_age=$(( NOW - last_bk ))
if [ -f "$BACKUP" ]; then
  info=$(head -c 2000 "$BACKUP")
  bk_seen="Last archive: $(field name "$info") ($(number bytes "$info") bytes) stored $(fmt "$last_bk")."
else
  bk_seen="No archive has arrived since the watcher started ($(fmt "$first"))."
fi
if [ "$bk_age" -gt $(( BACKUP_HOURS * 3600 )) ]; then backup=problem; else backup=ok; fi
change backup "$backup" \
  "off-site copy missing" \
  "No daily copy of the private editorial state has reached this server for $(hours "$bk_age") hours (limit: $BACKUP_HOURS).
$bk_seen
The Mac sends it at 06:50 (launchd agent ch.minitandem.editorial-offsite). Until it works again the editorial state exists only on the Mac.
On the Mac: tail ~/Library/Logs/minitandem-editorial-offsite.log." \
  "off-site copy is back" \
  "A daily copy of the private editorial state has reached this server again. $bk_seen"

echo "cycle-watch: silent=$(state_of silent) failed=$(state_of failed) backup=$(state_of backup)"
[ "$mail_failed" -eq 0 ] || exit 2
if [ "$(state_of silent)" = ok ] && [ "$(state_of failed)" = ok ] && [ "$(state_of backup)" = ok ]; then exit 0; fi
exit 1
