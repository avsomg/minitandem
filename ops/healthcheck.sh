#!/bin/sh
# Checks the public health URL and sends one e-mail when the state changes (up to down, down to up).
# The mail goes through any sendmail-compatible program that talks to an authenticated relay on port 587 (for example msmtp);
# the server cannot send on port 25. Run it from a systemd timer or cron every few minutes (see docs/betrieb.md).
#
# Environment:
#   HEALTH_MAIL_TO     recipient (required)
#   HEALTH_MAIL_FROM   sender address the relay accepts (default: the recipient)
#   HEALTH_URL         default https://minitandem.ch/healthz
#   HEALTH_STATE       file that remembers the last state (default /var/lib/minitandem-health/state)
#   HEALTH_SENDMAIL    sendmail-compatible command, read as "sendmail -t" (default sendmail)
#   HEALTH_RETRY_SECONDS  wait before the one second try after a failed check (default 20, whole seconds)
#
# A failed check is tried once more before it counts as down. Caddy's container ends itself every six days so its access log
# never reaches seven days (docker/access-log-entrypoint.sh), and Docker starts it again within a second. On 19 November 2026
# the five-minute timer hit that second and mailed "down" for a site that was back before the mail went out.
set -u
MAIL_TO="${HEALTH_MAIL_TO:?HEALTH_MAIL_TO is not set}"
MAIL_FROM="${HEALTH_MAIL_FROM:-$MAIL_TO}"
URL="${HEALTH_URL:-https://minitandem.ch/healthz}"
STATE="${HEALTH_STATE:-/var/lib/minitandem-health/state}"
SENDMAIL="${HEALTH_SENDMAIL:-sendmail}"
RETRY="${HEALTH_RETRY_SECONDS:-20}"
case "$RETRY" in ''|*[!0-9]*) RETRY=20 ;; esac

probe() { reply=$(curl -fsS --max-time 10 "$URL" 2>&1) && printf '%s' "$reply" | grep -q '"status":"ok"'; }
if probe; then
  now=up
else
  sleep "$RETRY"
  if probe; then now=up; else now=down; fi
fi
last=up
[ -f "$STATE" ] && last=$(cat "$STATE")
mkdir -p "$(dirname "$STATE")"
printf '%s\n' "$now" > "$STATE"

if [ "$now" != "$last" ]; then
  if [ "$now" = down ]; then subject="Minitandem is DOWN"; else subject="Minitandem is back up"; fi
  {
    printf 'To: %s\nFrom: %s\nSubject: %s\n\n' "$MAIL_TO" "$MAIL_FROM" "$subject"
    printf 'Check of %s at %s\nResult: %s\nLast answer: %s\n' "$URL" "$(date -u '+%Y-%m-%d %H:%M:%S UTC')" "$now" "$reply"
  } | $SENDMAIL -t
fi
[ "$now" = up ]
