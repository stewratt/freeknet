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
├── node_modules/          # production deps only (ws, better-sqlite3, ...)
├── data/                  # sqlite database (accounts/rovers/handshakes) — NEVER touched by deploy.sh
└── freeknet.env           # secrets (FREEKNET_KEY_SECRET); chmod 600 freeknet:freeknet

/etc/systemd/system/freeknet.service   # systemd unit, runs as user `freeknet`
```

The `freeknet` system user owns `/opt/freeknet` and runs the process. The
systemd unit:

- `Type=simple`, restarts on failure, `WantedBy=multi-user.target`
- `Environment=PORT=3000 HOST=0.0.0.0`
- `EnvironmentFile=-/opt/freeknet/freeknet.env` (secrets; see below)
- Hardening: `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=full`, `ProtectHome`
- `AmbientCapabilities=CAP_NET_BIND_SERVICE` (unused at port 3000, but lets us drop to 80 later without changing the unit)

## secrets (one-time per box)

The server encrypts users' OpenRouter api keys at rest with
`FREEKNET_KEY_SECRET` (AES-256-GCM). In production the process refuses to
boot without it. Generate it once and keep it stable — rotating it orphans
every stored key (users would re-paste theirs):

```bash
ssh root@178.156.249.95
umask 077
echo "FREEKNET_KEY_SECRET=$(openssl rand -hex 32)" > /opt/freeknet/freeknet.env
chown freeknet:freeknet /opt/freeknet/freeknet.env
systemctl restart freeknet
```

> **Never set `FREEKNET_DEV_TOOLS=1` in production.** It mounts the unauthenticated
> `/api/dev/*` routes (and `/dev.html`), which let anyone create test accounts and
> trigger `POST /api/dev/simulate` — spending the shared `FREEKNET_TEST_API_KEY`.
> The dev tools, the shared test key, and `FREEKNET_TEST_LIVE` are all local-dev
> knobs and should be absent from `freeknet.env`.

## database

SQLite (WAL) at `/opt/freeknet/data/freeknet.db`, created on first boot.
`deploy.sh` rsyncs only `dist server.js package.json package-lock.json`, so
the database survives every deploy untouched. Backup one-liner:

```bash
ssh root@178.156.249.95 "sqlite3 /opt/freeknet/data/freeknet.db '.backup /tmp/freeknet-backup.db'" \
  && scp root@178.156.249.95:/tmp/freeknet-backup.db ./backups/freeknet-$(date +%F).db
```

Ad-hoc moderation (no admin UI yet): `sudo -u freeknet sqlite3
/opt/freeknet/data/freeknet.db` and update/delete rows in `users`/`rovers`.

> **TLS note:** the site is plain HTTP on :3000 today. Before real users
> paste OpenRouter keys, front it with nginx/Caddy + Let's Encrypt and set
> `FREEKNET_SECURE_COOKIES=1` in `freeknet.env`.

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

Live occupancy: `curl http://178.156.249.95:3000/api/stats` returns
per-instance human/rover counts.

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

# secrets (see "secrets" section above)
ssh root@<new-ip> 'umask 077 && echo "FREEKNET_KEY_SECRET=$(openssl rand -hex 32)" > /opt/freeknet/freeknet.env && chown freeknet:freeknet /opt/freeknet/freeknet.env'

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
