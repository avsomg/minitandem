#!/bin/sh
# Daily archive of the service state and of Caddy's certificates (docs/betrieb.md, "Sichern und Wiederherstellen").
# Installed on the host as /usr/local/sbin/minitandem-backup and run by cron as the deploy user (member of the group docker).
# Keeps the newest $KEEP archives of each kind. Archives are readable by the deploy user only: the Caddy archive holds
# certificate keys. Copy them to another machine as well; a backup on the same server does not survive the server's loss.
set -eu
DIR=${BACKUP_DIR:-$HOME/backups}
KEEP=${KEEP:-14}
STAMP=$(date +%F-%H%M)
OWNER="$(id -u):$(id -g)"
mkdir -p "$DIR"
chmod 700 "$DIR"
archive() { # volume, name
  docker run --rm -v "$1":/source:ro -v "$DIR":/backup alpine \
    sh -c "umask 077 && tar czf /backup/$2 -C /source . && chown $OWNER /backup/$2"
}
archive minitandem_state "minitandem-state-$STAMP.tgz"
archive minitandem_caddy-data "minitandem-caddy-$STAMP.tgz"
for kind in state caddy; do
  ls -1t "$DIR"/minitandem-$kind-*.tgz | tail -n +$((KEEP + 1)) | xargs -r rm --
done
echo "$(date -Is) backup ok: minitandem-state-$STAMP.tgz minitandem-caddy-$STAMP.tgz"
