# deploying freeknet

Currently deployed to a Hetzner box at `178.156.249.95` (Ubuntu 24.04). The
box also runs an unrelated `zyme-gallery` Flask app behind nginx on port 80,
which is why freeknet lives on **port 3000** instead.

## layout on the server

```
/opt/freeknet/
├── dist/                  # built frontend (output of `vite build`)
├── server.js              # esbuild-bundled server (output of `npm run build:server`)
├── package.json
├── package-lock.json
└── node_modules/          # production deps only (ws)

/etc/systemd/system/freeknet.service   # systemd unit, runs as user `freeknet`
```

The `freeknet` system user owns `/opt/freeknet` and runs the process. The
systemd unit:

- `Type=simple`, restarts on failure, `WantedBy=multi-user.target`
- `Environment=PORT=3000 HOST=0.0.0.0`
- Hardening: `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=full`, `ProtectHome`
- `AmbientCapabilities=CAP_NET_BIND_SERVICE` (unused at port 3000, but lets us drop to 80 later without changing the unit)

Source for the unit lives in [`deploy/freeknet.service`](deploy/freeknet.service).

## pushing updates

After editing anything in `src/`, `index.html`, `server.ts`, or
`package.json`:

```bash
npm run deploy
# or directly:
./deploy/deploy.sh
```

`deploy.sh` does:

1. `vite build` locally → `dist/`
2. `esbuild` bundle of `server.ts` → `server.js`
3. Compares local `package-lock.json` to the remote; flags `DEPS_CHANGED` if different
4. `rsync -az --delete` of `dist/ server.js package.json package-lock.json` → `root@178.156.249.95:/opt/freeknet/`
5. If deps changed, runs `sudo -u freeknet npm ci --omit=dev` on the box
6. `systemctl restart freeknet`
7. Hits `/healthz` to verify

Override the target via env if you ever move the deployment:

```bash
FREEKNET_SERVER=root@new-host \
FREEKNET_REMOTE_DIR=/srv/freeknet \
FREEKNET_URL=https://freeknet.example.com \
npm run deploy
```

## operating the live server

```bash
ssh root@178.156.249.95

systemctl status freeknet        # is it running?
journalctl -u freeknet -f        # tail logs live
journalctl -u freeknet -n 100    # last 100 lines
systemctl restart freeknet       # restart (e.g. after manual edits)
ss -tlnp | grep :3000            # confirm bound to 3000

ufw status                       # firewall rules
```

Player count is whatever's in the server's `players` Map — peek at it via
`journalctl` or add a `/stats` endpoint to `server.ts` if you want a real
dashboard.

## firewall

UFW allows: 22 (ssh), 80 (nginx → zyme), 443 (reserved), 3000 (freeknet),
25565 (minecraft). Don't `ufw reset` without re-adding these.

## initial setup (already done — keep for redeploy from scratch)

If you ever rebuild the box:

```bash
ssh root@<new-ip>
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
useradd --system --home /opt/freeknet --shell /usr/sbin/nologin freeknet
mkdir -p /opt/freeknet && chown -R freeknet:freeknet /opt/freeknet

# from local
scp deploy/freeknet.service root@<new-ip>:/etc/systemd/system/freeknet.service
FREEKNET_SERVER=root@<new-ip> npm run deploy
ssh root@<new-ip> 'systemctl daemon-reload && systemctl enable --now freeknet && ufw allow 3000/tcp'
```

## one-shot scripts in deploy/

- [`deploy/deploy.sh`](deploy/deploy.sh) — local → production push. Documented above.
- [`deploy/migrate-to-freeknet.sh`](deploy/migrate-to-freeknet.sh) — historical
  rename script that renamed the unix user, install dir, and systemd unit
  from `doodler` → `freeknet`. Already run on the live box; kept around as
  a recipe in case anyone forks this and wants to do a similar rename.
- [`deploy/freeknet.service`](deploy/freeknet.service) — systemd unit. Source of
  truth for the live one at `/etc/systemd/system/freeknet.service`.
