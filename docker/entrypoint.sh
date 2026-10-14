#!/bin/sh
# Starts the service. On the first start it creates exactly one demo family key. It never creates an editor key
# (server.mjs new-admin): without one, every editor route of the service answers 401.
set -eu
cd "$(dirname "$0")/.."
: "${MINITANDEM_STATE_DIR:?MINITANDEM_STATE_DIR is not set}"
mkdir -p "$MINITANDEM_STATE_DIR" "${MINITANDEM_CORRECTION_DIR:-$MINITANDEM_STATE_DIR/corrections}"
if [ ! -f "$MINITANDEM_STATE_DIR/families.json" ]; then
  umask 077
  node --disable-warning=ExperimentalWarning server.mjs new-family > "$MINITANDEM_STATE_DIR/demo-family-key.txt"
  echo "Created one demo family. Its key is in $MINITANDEM_STATE_DIR/demo-family-key.txt; no editor key exists on this server."
fi
exec node --disable-warning=ExperimentalWarning server.mjs start
