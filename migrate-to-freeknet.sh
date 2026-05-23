#!/usr/bin/env bash
# One-shot server-side rename: doodler -> freeknet.
# Stops the old service, renames the unix user/group/home/install-dir,
# installs the new systemd unit, and starts the freeknet service.
#
# This WILL cause ~30s of downtime and disconnect everyone in the room.
#
# Idempotent: safe to re-run if it half-completes.

set -euo pipefail

SERVER="${FREEKNET_SERVER:-root@178.156.249.95}"
cd "$(dirname "$0")"

echo "==> uploading new systemd unit"
scp deploy/freeknet.service "$SERVER:/etc/systemd/system/freeknet.service"

echo "==> running migration on $SERVER"
ssh "$SERVER" "bash -s" <<'REMOTE'
set -euo pipefail

echo "  stopping + disabling doodler service (if present)"
systemctl stop doodler 2>/dev/null || true
systemctl disable doodler 2>/dev/null || true

echo "  renaming unix user/group doodler -> freeknet"
if id doodler &>/dev/null && ! id freeknet &>/dev/null; then
  usermod -l freeknet doodler
fi
if getent group doodler >/dev/null && ! getent group freeknet >/dev/null; then
  groupmod -n freeknet doodler
fi

echo "  moving /opt/doodler -> /opt/freeknet"
if [ -d /opt/doodler ] && [ ! -d /opt/freeknet ]; then
  mv /opt/doodler /opt/freeknet
elif [ -d /opt/doodler ] && [ -d /opt/freeknet ]; then
  echo "  WARN: both dirs exist; leaving /opt/doodler in place for manual inspection"
fi

echo "  pointing freeknet user home at /opt/freeknet"
usermod -d /opt/freeknet freeknet 2>/dev/null || true
chown -R freeknet:freeknet /opt/freeknet

echo "  removing old systemd unit file"
rm -f /etc/systemd/system/doodler.service

echo "  reloading systemd"
systemctl daemon-reload

echo "  enabling + starting freeknet"
systemctl enable freeknet
systemctl restart freeknet

sleep 1
systemctl is-active freeknet
REMOTE

echo "==> migration done. running deploy.sh to push current build"
./deploy.sh
