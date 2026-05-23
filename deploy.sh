#!/usr/bin/env bash
# Push local changes live to http://178.156.249.95:3000/
# Usage: ./deploy.sh

set -euo pipefail

SERVER="${FREEKNET_SERVER:-root@178.156.249.95}"
REMOTE_DIR="${FREEKNET_REMOTE_DIR:-/opt/freeknet}"
URL="${FREEKNET_URL:-http://178.156.249.95:3000}"

cd "$(dirname "$0")"

echo "==> building"
npx vite build

# Detect whether deps changed since last deploy (compare local lockfile to remote)
DEPS_CHANGED=0
if ! ssh -o BatchMode=yes "$SERVER" "test -f $REMOTE_DIR/package-lock.json && cmp -s $REMOTE_DIR/package-lock.json -" < package-lock.json 2>/dev/null; then
  DEPS_CHANGED=1
fi

echo "==> syncing to $SERVER:$REMOTE_DIR"
rsync -az --delete \
  dist server.js package.json package-lock.json \
  "$SERVER:$REMOTE_DIR/"

if [ "$DEPS_CHANGED" = "1" ]; then
  echo "==> dependencies changed — running npm ci on server"
  ssh "$SERVER" "cd $REMOTE_DIR && sudo -u freeknet npm ci --omit=dev"
else
  echo "==> no dependency change, skipping npm ci"
fi

echo "==> restarting service"
ssh "$SERVER" "systemctl restart freeknet && systemctl is-active freeknet"

echo "==> health check"
sleep 1
if curl -sf --max-time 5 "$URL/healthz" >/dev/null; then
  echo "OK — live at $URL"
else
  echo "WARN — /healthz failed; check logs:"
  echo "  ssh $SERVER 'journalctl -u freeknet -n 30 --no-pager'"
  exit 1
fi
