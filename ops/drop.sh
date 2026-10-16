#!/bin/sh
# Forced command of the restricted key that the editorial Mac uses to hand two things to this server:
# a small heartbeat after every cycle, and one archive of the private editorial state per day (docs/betrieb.md, "Redaktioneller Zyklus").
# Installed as /usr/local/sbin/minitandem-drop, owned by root, and named in authorized_keys only:
#   restrict,command="/usr/local/sbin/minitandem-drop" ssh-ed25519 AAAA... minitandem-drop
# sshd puts the command the Mac asked for into SSH_ORIGINAL_COMMAND. Exactly these are accepted, nothing else:
#   heartbeat                       reads at most 16 KB of one-line JSON from stdin, stores it as $WATCH_DIR/heartbeat.json
#   backup YYYY-MM-DD <sha256 hex>  reads a .tar.gz (at most 2 GB) from stdin, checks the checksum and the date (not after tomorrow), stores it as
#                                   $DROP_BACKUP_DIR/editorial-YYYY-MM-DD.tar.gz (never overwrites a different file),
#                                   keeps the newest $DROP_KEEP, writes $WATCH_DIR/backup.json
# Everything else is refused with a message on stderr and exit code 1. The key cannot read, list or delete anything.
#
# Environment (sshd passes none of it from the client; the defaults are the production paths, a test sets its own):
#   WATCH_DIR                  default /var/lib/minitandem-watch (owned by the login user; cycle-watch.sh reads it)
#   DROP_BACKUP_DIR            default $HOME/editorial-backups
#   DROP_KEEP                  archives to keep, default 14
#   DROP_MAX_BACKUP_BYTES      default 2147483648
#   DROP_MAX_HEARTBEAT_BYTES   default 16384
#   DROP_TOTAL_BACKUP_BYTES    default 2147483648 (stored files plus the incoming archive)
#   DROP_READ_SECONDS          default 300
#   DROP_GZIP_SECONDS          default 30
set -eu
LC_ALL=C
export LC_ALL
umask 077

WATCH_DIR=${WATCH_DIR:-/var/lib/minitandem-watch}
BACKUP_DIR=${DROP_BACKUP_DIR:-${HOME:?HOME is not set}/editorial-backups}
KEEP=${DROP_KEEP:-14}
MAX_BACKUP=${DROP_MAX_BACKUP_BYTES:-2147483648}
MAX_HEARTBEAT=${DROP_MAX_HEARTBEAT_BYTES:-16384}
TOTAL_BACKUP=${DROP_TOTAL_BACKUP_BYTES:-2147483648}
READ_SECONDS=${DROP_READ_SECONDS:-300}
GZIP_SECONDS=${DROP_GZIP_SECONDS:-30}
tmp= receipt= limit_child= limit_guard= lock_token=
UPLOAD_LOCK=$WATCH_DIR/.upload-lock

refuse() { echo "minitandem-drop: $*" >&2; exit 1; }

cleanup() {
  drop_status=$?
  # Cleanup runs to its end: a second signal while it removes temporary files is ignored.
  trap - EXIT; trap '' HUP INT TERM
  [ -z "$limit_child" ] || { kill "$limit_child" 2>/dev/null || true; wait "$limit_child" 2>/dev/null || true; }
  [ -z "$limit_guard" ] || { kill -KILL "$limit_guard" 2>/dev/null || true; wait "$limit_guard" 2>/dev/null || true; }
  [ -z "$tmp" ] || rm -f "$tmp"
  [ -z "$receipt" ] || rm -f "$receipt"
  if [ -n "$lock_token" ] && [ "$(cat "$UPLOAD_LOCK/owner" 2>/dev/null)" = "$lock_token" ]; then
    rm -f "$UPLOAD_LOCK/owner"; rmdir "$UPLOAD_LOCK" 2>/dev/null || true
  fi
  exit "$drop_status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

take_upload_lock() {
  for number in "$MAX_BACKUP" "$MAX_HEARTBEAT" "$TOTAL_BACKUP" "$READ_SECONDS" "$GZIP_SECONDS"; do
    case $number in ''|*[!0-9]*) refuse 'limits must be positive integers' ;; esac
    [ "$number" -gt 0 ] || refuse 'limits must be positive integers'
  done
  mkdir -p "$WATCH_DIR"
  mkdir "$UPLOAD_LOCK" 2>/dev/null || refuse 'another upload is active, or its interrupted lock needs inspection'
  lock_token="$$-$(date -u '+%s')"
  printf '%s\n' "$lock_token" > "$UPLOAD_LOCK/owner"
}

# POSIX watchdog: the receiver needs no timeout utility on macOS. Commands here are the single-process head and gzip readers.
limited() {
  seconds=$1; shift
  exec 8<&0
  "$@" <&8 8<&- &
  limit_child=$!
  exec 8<&-
  # The guard is stopped with KILL once the reader is done: a trapped TERM could stay pending in dash while it waits (a race seen on Linux),
  # and the guard would then sit out its whole deadline. Killed, it can never act on a reader that has gone; its sleep has no open
  # descriptors besides /dev/null and simply runs out.
  (
    sleep "$seconds"
    kill -TERM "$limit_child" 2>/dev/null || exit 0
    sleep 1
    kill -KILL "$limit_child" 2>/dev/null || true
  ) </dev/null >/dev/null 2>&1 &
  limit_guard=$!
  if wait "$limit_child"; then limited_status=0; else limited_status=$?; fi
  limit_child=
  kill -KILL "$limit_guard" 2>/dev/null || true
  wait "$limit_guard" 2>/dev/null || true
  limit_guard=
  return "$limited_status"
}

# sha256 of a file, as lowercase hex, with whichever tool the system has
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d ' ' -f 1
  else shasum -a 256 "$1" | cut -d ' ' -f 1; fi
}
size_of() { wc -c < "$1" | tr -d ' '; }
now_utc() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

# Writes $1 (a finished file) over $2 in one step, so a reader never sees half of it
publish_file() { mv -f "$1" "$2"; }

cmd=${SSH_ORIGINAL_COMMAND-}
[ -n "$cmd" ] || refuse "no command given"
# Letters, digits, spaces and hyphens only: no quoting, no separators, no newline can get past this line.
case $cmd in *[!A-Za-z0-9\ -]*) refuse "unexpected characters in the command" ;; esac
set -f
# shellcheck disable=SC2086
set -- $cmd
[ $# -ge 1 ] || refuse "no command given"

heartbeat() {
  [ $# -eq 0 ] || refuse "heartbeat takes no arguments"
  take_upload_lock
  mkdir -p "$WATCH_DIR"
  find "$WATCH_DIR" -maxdepth 1 -name '.heartbeat.*' -mmin +60 -exec rm -f {} + 2>/dev/null || true
  tmp=$WATCH_DIR/.heartbeat.$$
  limited "$READ_SECONDS" head -c $((MAX_HEARTBEAT + 1)) > "$tmp" || refuse "heartbeat read deadline or write failure"
  size=$(size_of "$tmp")
  [ "$size" -gt 0 ] || refuse "empty heartbeat"
  [ "$size" -le "$MAX_HEARTBEAT" ] || refuse "heartbeat larger than $MAX_HEARTBEAT bytes"
  # Printable ASCII and the final newline only; the watcher reads it with grep and sed and puts parts of it into a mail.
  [ "$(tr -d '[:print:]\n' < "$tmp" | wc -c | tr -d ' ')" -eq 0 ] || refuse "heartbeat holds control or non-ASCII characters"
  [ "$(wc -l < "$tmp" | tr -d ' ')" -le 1 ] || refuse "heartbeat must be a single line"
  [ "$(head -c 1 "$tmp")" = "{" ] && [ "$(tr -d '\n' < "$tmp" | tail -c 1)" = "}" ] || refuse "heartbeat is not a JSON object"
  publish_file "$tmp" "$WATCH_DIR/heartbeat.json"
  echo "heartbeat stored ($size bytes)"
}

backup() {
  [ $# -eq 2 ] || refuse "usage: backup YYYY-MM-DD SHA256"
  day=$1
  want=$2
  case $day in
    20[2-9][0-9]-0[1-9]-0[1-9] | 20[2-9][0-9]-0[1-9]-[12][0-9] | 20[2-9][0-9]-0[1-9]-3[01] | \
    20[2-9][0-9]-1[0-2]-0[1-9] | 20[2-9][0-9]-1[0-2]-[12][0-9] | 20[2-9][0-9]-1[0-2]-3[01]) ;;
    *) refuse "not a date (YYYY-MM-DD): $day" ;;
  esac
  # Not after tomorrow (UTC): a key in the wrong hands cannot push the real archives out with a far-future name, because the newest names are kept
  tomorrow=$(date -u -d tomorrow '+%Y-%m-%d' 2>/dev/null || date -u -v+1d '+%Y-%m-%d')
  [ "$(printf '%s\n%s\n' "$day" "$tomorrow" | sort | tail -n 1)" = "$tomorrow" ] || refuse "date is in the future: $day"
  case $want in *[!0-9a-f]*) refuse "checksum must be lowercase hex" ;; esac
  [ "${#want}" -eq 64 ] || refuse "checksum must be 64 hex characters"
  case $KEEP in '' | *[!0-9]*) refuse "DROP_KEEP is not a number" ;; esac

  take_upload_lock

  mkdir -p "$BACKUP_DIR" "$WATCH_DIR"
  chmod 700 "$BACKUP_DIR"
  # Leftovers of uploads that were cut off
  find "$BACKUP_DIR" -maxdepth 1 -name '.incoming-*' -mmin +1440 -exec rm -f {} + 2>/dev/null || true
  final=$BACKUP_DIR/editorial-$day.tar.gz
  tmp=$BACKUP_DIR/.incoming-$day.$$
  used=$(find "$BACKUP_DIR" -type f -exec sh -c 'wc -c < "$1"' sh {} \; | awk '{sum+=$1} END {printf "%.0f",sum+0}')
  remaining=$((TOTAL_BACKUP - used))
  [ "$remaining" -gt 0 ] || refuse 'aggregate backup budget exhausted'
  read_limit=$MAX_BACKUP
  [ "$remaining" -ge "$read_limit" ] || read_limit=$remaining
  limited "$READ_SECONDS" head -c $((read_limit + 1)) > "$tmp" || refuse "upload read deadline or write failure"
  size=$(size_of "$tmp")
  [ "$size" -gt 0 ] || refuse "empty archive"
  [ "$size" -le "$MAX_BACKUP" ] || refuse "archive larger than $MAX_BACKUP bytes"
  [ "$size" -le "$remaining" ] || refuse "aggregate backup budget exceeded"
  got=$(sha256 "$tmp")
  [ "$got" = "$want" ] || refuse "checksum mismatch (received $got)"
  limited "$GZIP_SECONDS" gzip -t "$tmp" 2>/dev/null || refuse "not a gzip file or gzip validation deadline"

  # ln fails when the name is taken, which makes "never overwrite" race-free. The same bytes again (a retry after a cut connection) is fine.
  if ln "$tmp" "$final" 2>/dev/null; then
    stored="stored"
  elif [ -f "$final" ] && cmp -s "$tmp" "$final"; then
    stored="already stored"
  else
    refuse "an archive for $day exists with different content; it is never overwritten"
  fi
  rm -f "$tmp"

  # Keep the newest $KEEP by name (the name carries the date)
  ls -1 "$BACKUP_DIR" | grep -E '^editorial-[0-9]{4}-[0-9]{2}-[0-9]{2}\.tar\.gz$' | sort -r | tail -n +$((KEEP + 1)) |
    while IFS= read -r old; do rm -f -- "$BACKUP_DIR/$old"; done

  receipt=$WATCH_DIR/.backup.$$
  printf '{"at":"%s","name":"%s","bytes":%s}\n' "$(now_utc)" "editorial-$day.tar.gz" "$size" > "$receipt"
  publish_file "$receipt" "$WATCH_DIR/backup.json"
  echo "$stored: editorial-$day.tar.gz ($size bytes); newest $KEEP kept"
}

case $1 in
  heartbeat) shift; heartbeat "$@" ;;
  backup) shift; backup "$@" ;;
  *) refuse "unknown command" ;;
esac
