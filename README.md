# freeknet

A tiny multiplayer 3D sketch world. Draw yourself on a 2D canvas, then walk around as that drawing in a shared Three.js space with anyone else who's online.

Live: **http://178.156.249.95:3000/**

## What it does

- **Draw phase** — one continuous pen stroke on a 500×750 canvas becomes your avatar.
- **World phase** — your drawing is textured onto a billboarded plane that walks around an infinite-feeling grid floor with a gradient skydome and fog horizon.
- **Multiplayer** — everyone connected sees everyone else move in real time, with chat bubbles floating above heads.

Controls: WASD to move, right-drag to orbit the camera, T to chat, Enter to send, Esc to cancel.

## Architecture

Two pieces, one process.

```
┌─────────────────────────────────────────────────────────┐
│                     server.js (Node)                    │
│                                                         │
│  http.createServer ──── GET /          → dist/index.html│
│         │               GET /assets/*  → dist/assets/*  │
│         │               GET /healthz   → "ok"           │
│         │                                               │
│         └── upgrade ──── /ws → WebSocketServer          │
│                                                         │
│   players: Map<id, { ws, drawing, x, z, rotY }>         │
│   ─ welcome / snapshot on connect                       │
│   ─ broadcast join / leave / update / chat              │
└─────────────────────────────────────────────────────────┘
                            ▲
                            │ ws://host/ws  (wss:// when TLS)
                            ▼
┌─────────────────────────────────────────────────────────┐
│                  Browser (Vite-built SPA)               │
│                                                         │
│  src/main.js       → bootstraps phases                  │
│  src/drawing.js    → 2D canvas pen capture              │
│  src/avatar.js     → CanvasTexture → THREE.Mesh         │
│  src/game.js       → scene, camera, render loop         │
│  src/player.js     → LocalPlayer / RemotePlayer         │
│  src/controls.js   → keyboard + mouse                   │
│  src/network.js    → WebSocket client to /ws            │
│  src/chat.js       → floating speech bubbles            │
└─────────────────────────────────────────────────────────┘
```

Key facts:

- **Single port for HTTP + WS.** `server.js` listens on one port (3000 in prod, 8080 in dev) and routes WebSocket upgrades on `/ws`. No CORS, no separate gateway.
- **Drawing transport.** The 2D canvas is `toDataURL('image/png')`'d and sent in the `join` message. The server stores it per-player and re-sends it in the snapshot when anyone new connects.
- **Movement rate-limit.** Client sends position at 15 Hz. Server clamps any reported step >10m as anti-cheat.
- **Heartbeat.** 30s ping/pong; dead sockets are terminated.
- **State is in memory.** Restarting the server drops all sessions. That's fine for now.

## Local development

```bash
npm install
npm start
```

This runs `concurrently` with `vite` (port 5173) and `node server.js` (port 8080). Vite proxies `/ws` to the Node server, so the client always connects to its own origin. Open http://localhost:5173.

If you only want one piece:

```bash
npm run server   # WS + static (uses dist/ if built; otherwise no HTML)
npm run dev      # vite dev server only
```

## Production deployment

Currently deployed to a Hetzner box at `178.156.249.95` (Ubuntu 24.04). The box also runs an unrelated `zyme-gallery` Flask app behind nginx on port 80, which is why freeknet lives on **port 3000** instead.

### Layout on the server

```
/opt/freeknet/
├── dist/                  # built frontend (output of `vite build`)
├── server.js              # serves dist/ + WS on PORT (3000)
├── package.json
├── package-lock.json
└── node_modules/          # production deps only (ws)

/etc/systemd/system/freeknet.service   # systemd unit, runs as user `freeknet`
```

The `freeknet` system user owns `/opt/freeknet` and runs the process. The systemd unit:

- `Type=simple`, restarts on failure, `WantedBy=multi-user.target`
- `Environment=PORT=3000 HOST=0.0.0.0`
- Hardening: `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=full`, `ProtectHome`
- `AmbientCapabilities=CAP_NET_BIND_SERVICE` (unused at port 3000, but lets us drop to 80 later without changing the unit)

Source for the unit lives in [`deploy/freeknet.service`](deploy/freeknet.service).

### Pushing updates

After editing anything in `src/`, `index.html`, `server.js`, or `package.json`:

```bash
./deploy.sh
```

`deploy.sh` does:

1. `vite build` locally → `dist/`
2. Compares local `package-lock.json` to the remote; flags `DEPS_CHANGED` if different
3. `rsync -az --delete` of `dist/ server.js package.json package-lock.json` → `root@178.156.249.95:/opt/freeknet/`
4. If deps changed, runs `sudo -u freeknet npm ci --omit=dev` on the box
5. `systemctl restart freeknet`
6. Hits `/healthz` to verify

Override the target via env if you ever move the deployment:

```bash
FREEKNET_SERVER=root@new-host \
FREEKNET_REMOTE_DIR=/srv/freeknet \
FREEKNET_URL=https://freeknet.example.com \
./deploy.sh
```

### Operating the live server

```bash
ssh root@178.156.249.95

systemctl status freeknet        # is it running?
journalctl -u freeknet -f        # tail logs live
journalctl -u freeknet -n 100    # last 100 lines
systemctl restart freeknet       # restart (e.g. after manual edits)
ss -tlnp | grep :3000           # confirm bound to 3000

ufw status                      # firewall rules
```

Player count is whatever's in `players` Map — peek at it via `journalctl` or add a `/stats` endpoint to `server.js` if you want a real dashboard.

### Firewall

UFW allows: 22 (ssh), 80 (nginx → zyme), 443 (reserved), 3000 (freeknet), 25565 (minecraft). Don't `ufw reset` without re-adding these.

### Initial setup (already done — keep for redeploy from scratch)

If you ever rebuild the box:

```bash
ssh root@<new-ip>
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
useradd --system --home /opt/freeknet --shell /usr/sbin/nologin freeknet
mkdir -p /opt/freeknet && chown -R freeknet:freeknet /opt/freeknet

# from local
scp deploy/freeknet.service root@<new-ip>:/etc/systemd/system/freeknet.service
./deploy.sh   # after pointing FREEKNET_SERVER at the new host
ssh root@<new-ip> 'systemctl daemon-reload && systemctl enable --now freeknet && ufw allow 3000/tcp'
```

## Files

| Path | Role |
| --- | --- |
| `server.js` | HTTP static + WS gateway in one process |
| `src/main.js` | Boot: wires draw phase → game phase |
| `src/drawing.js` | 2D pen capture, quadratic curve smoothing |
| `src/avatar.js` | Drawing → `THREE.CanvasTexture` → billboarded plane with walk-bob deformation |
| `src/game.js` | Scene, fog, skydome shader, render loop, network wiring |
| `src/player.js` | LocalPlayer (input-driven) / RemotePlayer (interpolated) |
| `src/controls.js` | WASD + mouse-orbit camera |
| `src/network.js` | WebSocket client; reconnect logic is *intentionally* not here yet |
| `src/chat.js` | troika-three-text speech bubbles |
| `index.html` | Single-page HTML shell (draw phase + game phase) |
| `multiplayer.html` | Standalone design/spec page describing the protocol |
| `vite.config.js` | Dev server + `/ws` proxy to localhost:8080 |
| `deploy.sh` | Local → production push |
| `deploy/freeknet.service` | systemd unit (source of truth for the live one) |

## Wire protocol

All messages are JSON over a single WebSocket at `/ws`.

**Client → server**

```js
{ t: 'join',  drawing: '<dataURL>' }            // sent after `welcome`
{ t: 'move',  x: number, z: number, rotY: num } // ~15 Hz
{ t: 'chat',  text: string }                    // <=120 chars
```

**Server → client**

```js
{ t: 'welcome',  id: string }
{ t: 'snapshot', players: [{ id, drawing, x, z, rotY }, ...] }
{ t: 'join',     id, drawing, x, z, rotY }
{ t: 'leave',    id }
{ t: 'update',   id, x, z, rotY }
{ t: 'chat',     id, text }
```

## Known limitations

- No persistence — server restart wipes the world.
- No reconnect on the client. Refresh redraws.
- No moderation, no rate-limit on chat, no auth. Don't share with strangers.
- One drawing per session — refresh to redraw.
- Avatars are billboarded planes; back/side views are the same as front.
