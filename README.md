# freeknet

A tiny multiplayer 3D sketch world. Draw yourself on a 2D canvas, then walk
around as that drawing in a shared Three.js space with anyone else who's
online.

Demo created by @smilebigforgod and @sstewrat.

Live: **http://178.156.249.95:3000/**

## What it does

- **Draw phase** — one continuous pen stroke on a 500×750 canvas becomes your avatar.
- **World phase** — your drawing is textured onto a billboarded plane that walks around an infinite-feeling grid floor with a gradient skydome and fog horizon.
- **Multiplayer** — everyone connected sees everyone else move in real time, with chat bubbles floating above heads.
- **Jump physics, stage, ball** — spacebar to jump (gravity-based), kick a server-authoritative ball, hop on the stage.
- **Emotes** — `/dance` and `/bow` slash commands.
- **Mobile** — dual thumbsticks + JUMP pill, tap-to-chat with on-screen keyboard handling.
- **Proximity voice chat** — click the mic button to enable. Audio is HRTF-spatialized, WebRTC peer-to-peer, with hysteresis on the proximity gate.
- **One big world.** No rooms, no persistence — every join is a fresh drawing and you spawn at the origin. Restart wipes everything. That's the vibe.

Controls (desktop): WASD to move, space to jump, right-drag to orbit the
camera, T to chat, Enter to send, Esc to cancel.

## Architecture

Two pieces, one process.

```
┌─────────────────────────────────────────────────────────┐
│              server.ts (Node + tsx in dev,              │
│            esbuild-bundled server.js in prod)           │
│                                                         │
│  http.createServer ──── GET /          → dist/index.html│
│         │               GET /assets/*  → dist/assets/*  │
│         │               GET /healthz   → "ok"           │
│         │                                               │
│         └── upgrade ──── /ws → WebSocketServer          │
│                                                         │
│   players: Map<id, { ws, drawing, x, y, z, rotY, … }>   │
│   ball:    { x, y, z, vx, vy, vz, dirty, restAccum }    │
│   ─ welcome + snapshot + initial ball state on connect  │
│   ─ broadcast join / leave / update / chat / emote /    │
│     ball / presence / rtc                               │
└─────────────────────────────────────────────────────────┘
                            ▲
                            │ ws://host/ws  (wss:// when TLS)
                            ▼
┌─────────────────────────────────────────────────────────┐
│                  Browser (Vite-built SPA)               │
│                                                         │
│  all client + server code is typescript                 │
│  src/main.ts       → bootstraps phases                  │
│  src/protocol.ts   → shared ClientMsg / ServerMsg types │
│  src/drawing.ts    → 2D canvas pen capture              │
│  src/avatar.ts     → CanvasTexture → THREE.Mesh         │
│  src/game.ts       → scene wiring + render loop         │
│  src/sky.ts        → gradient skydome shader            │
│  src/world.ts      → floor + grid                       │
│  src/camera.ts     → orbit-follow camera                │
│  src/stage.ts      → stage box + collider               │
│  src/ball.ts       → ball mesh + client interpolation   │
│  src/player.ts     → LocalPlayer / RemotePlayer         │
│  src/controls.ts   → keyboard + touch + mobile UI       │
│  src/network.ts    → WebSocket client to /ws            │
│  src/chat.ts       → troika speech bubbles + emote cmds │
│  src/voice.ts      → webrtc proximity voice (spatial)   │
└─────────────────────────────────────────────────────────┘
```

Key facts:

- **Typescript everywhere.** Client builds with vite's bundled esbuild; server runs as `.ts` via [tsx](https://github.com/privatenumber/tsx) in dev (no compile step) and is esbuild-bundled into a single `server.js` for prod deploy. `src/protocol.ts` types both sides of the wire.
- **Single port for HTTP + WS.** The server listens on one port (3000 in prod, 8080 in dev) and routes WebSocket upgrades on `/ws`. No CORS, no separate gateway.
- **Drawing transport.** The 2D canvas is `toDataURL('image/png')`'d and sent in the `join` message. The server stores it per-player and re-sends it in the snapshot when anyone new connects.
- **Movement rate-limit.** Client sends position at 15 Hz. Server clamps any reported step >10m as anti-cheat.
- **Heartbeat.** 30s ping/pong; dead sockets are terminated.
- **Ephemeral by design.** No persistence, no rooms, one global world. State lives in memory. Restart wipes everyone; players redraw on every entry.
- **Bot flag.** Clients can join with `?bot=1` (sets `bot: true` on the join). Used by [freeknet-bot](https://github.com/jackharrhy/freeknet-bot) so automated avatars are distinguishable in the snapshot; bots also skip voice chat UI by default.

## Local development

```bash
npm install
npm start
```

This runs `concurrently` with `vite` (port 5173) and `tsx server.ts` (port
8080). Vite proxies `/ws` to the Node server, so the client always connects
to its own origin. Open http://localhost:5173.

If you only want one piece:

```bash
npm run server     # WS + static via tsx (uses dist/ if built; otherwise no HTML)
npm run dev        # vite dev server only
npm run build      # vite build + esbuild bundle server.ts → server.js
npm run typecheck  # tsc --noEmit
```

## Deployment

Production lives at port 3000 on a Hetzner box, behind systemd. See
[DEPLOYMENT.md](DEPLOYMENT.md) for the layout on the server, the
`deploy/` scripts, operating notes, and initial-setup recipe.

The short version:

```bash
npm run deploy
```

## Files

| Path | Role |
| --- | --- |
| `server.ts` | HTTP static + WS gateway + ball physics |
| `src/main.ts` | Boot: wires draw phase → game phase |
| `src/protocol.ts` | Shared `ClientMsg` / `ServerMsg` types |
| `src/drawing.ts` | 2D pen capture, quadratic curve smoothing |
| `src/avatar.ts` | Drawing → `THREE.CanvasTexture` → billboarded plane with walk-bob deformation + LOD culling |
| `src/game.ts` | Scene wiring + render loop |
| `src/sky.ts` | Three-color gradient skydome shader |
| `src/world.ts` | Floor + grid |
| `src/camera.ts` | Orbit-follow camera math |
| `src/stage.ts` | Stage box + AABB collider |
| `src/ball.ts` | Client-side ball mesh + interpolation |
| `src/player.ts` | LocalPlayer (input + jump + collide) / RemotePlayer (interpolated, y-aware, dance, bow) |
| `src/controls.ts` | WASD + space-to-jump + touch thumbsticks + mobile UI |
| `src/network.ts` | WebSocket client with snapshot/update ordering buffer; bot flag |
| `src/chat.ts` | troika-three-text speech bubbles + slash command dispatch |
| `src/voice.ts` | WebRTC proximity voice with HRTF spatial audio |
| `smoketest/` | puppeteer-based smoke tests (multiplayer, chat, presence, voice) |
| `index.html` | Single-page HTML shell (draw phase + game phase) |
| `vite.config.js` | Dev server + `/ws` proxy to localhost:8080 |
| `deploy/` | `deploy.sh`, `migrate-to-freeknet.sh`, `freeknet.service` (see [DEPLOYMENT.md](DEPLOYMENT.md)) |

## Wire protocol

All messages are JSON over a single WebSocket at `/ws`.

**Client → server**

```js
{ t: 'join',  drawing: '<dataURL>', bot?: false }
{ t: 'move',  x, y, z, rotY }                       // ~15 Hz
{ t: 'chat',  text }                                // <=120 chars
{ t: 'emote', name: 'dance' | 'bow', on?: boolean }
{ t: 'rtc',   to: id, payload: { sdp | ice } }      // voice signaling
```

**Server → client**

```js
{ t: 'welcome',  id }
{ t: 'snapshot', players: [{ id, drawing, x, y, z, rotY, dance, bot }, ...] }
{ t: 'join',     id, drawing, x, y, z, rotY, dance, bot }
{ t: 'leave',    id }
{ t: 'update',   id, x, y, z, rotY }
{ t: 'chat',     id, text }
{ t: 'emote',    id, name, on? }
{ t: 'ball',     x, y, z, vx, vy, vz }
{ t: 'presence', count }
{ t: 'rtc',      from: id, payload: { sdp | ice } }
```

Notes:

- `y` is unrestricted (no step cap) and clamped to ±50 server-side. Bots use it for bobbing / 3D formations; humans use it for jump.
- `move` triggers a server-side ball kick check when the player is within reach + moving toward the ball.
- `rtc` payloads are passed through opaquely. The server forwards `{ from, payload }` to the addressed peer. No inspection, no rewriting.
- The initial snapshot is followed by a `ball` message with the current server-authoritative ball state.

## Smoke tests

Puppeteer-based. Bundled chromium, so they run on macOS, Linux, and Windows
without configuring a Chrome path.

```bash
npm run smoke              # 2 clients see each other, walk, chat
npm run smoke:chat         # T-to-focus, click-to-focus, Escape, WASD-block
npm run smoke:presence     # online count updates correctly
npm run smoke:voice        # WebRTC offer/answer + proximity gate (longer; needs STUN)
npm run smoke:all          # all of the above except voice
npm run smoke:visual       # dump 4 screenshots through the chat flow
```

The dev server has to be up (`npm start`) before running them.

## Env

| Var | Default | Effect |
| --- | --- | --- |
| `PORT` / `FREEKNET_PORT` | `8080` (dev), `3000` (prod) | http + ws port |
| `HOST` | `0.0.0.0` | bind address |
| `VITE_DISABLE_VOICE` | unset | build-time flag to hide the voice mic button |

## Known limitations

- World restart wipes everything. No persistence.
- No reconnect on the client. Refresh redraws.
- No moderation, no rate-limit on chat, no auth. Don't share with strangers.
- One drawing per session — refresh to redraw.
- Avatars are billboarded planes; back/side views are the same as front.
- Voice is mesh — fine up to ~10 simultaneous nearby speakers, falls over beyond. No TURN, so cross-NAT voice may fail (LAN works without it).
