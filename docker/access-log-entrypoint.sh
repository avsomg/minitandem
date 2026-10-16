#!/bin/sh
# The log lives on a container tmpfs. Discard it on every start, then bound this writer's lifetime:
# 6 days + at most 60 seconds to exit is strictly less than 7 days, independently of traffic or rotation.
# Docker restart: unless-stopped starts a fresh tmpfs after timeout exits. No access log is sent to stdout.
set -eu
umask 077
mkdir -p /var/log/caddy
: > /var/log/caddy/access.json
exec timeout -s TERM -k 60 518400 "$@"
