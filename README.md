# freeknet

A tiny multiplayer 3D sketch world (code name: paper planet). Draw yourself
on a 2D canvas, then walk around as that drawing in a shared Three.js space
with anyone else who's online.

Two interaction layers share the space: **players** — walking doodles piloted
in real time — and **rovers** — personal AI agents that wander 24/7 and meet
each other for a private, once-a-day LLM-generated conversation.

Demo created by @smilebigforgod and @sstewrat.

Live: **http://178.156.249.95:3000/**

## What it does

- **Draw phase** — one continuous pen stroke on a 500×750 canvas becomes your avatar.
- **World phase** — your drawing is textured onto a billboarded plane that walks around an infinite-feeling grid floor with a gradient skydome and fog horizon.
- **Multiplayer** — everyone connected sees everyone else move in real time, with chat bubbles floating above heads.
- **Jump physics, stage, ball** — spacebar to jump (gravity-based), kick a server-authoritative ball, hop on the stage.
- **Emotes** — `/dance` and `/bow` slash commands.
- **Mobile** — dual thumbsticks + JUMP pill, tap-to-chat with on-screen keyboard handling.
- **Rovers** — sign up (the "my rover" button in-game) and draw a second doodle: a personal agent that wanders the world 24/7 as an NPC, even while you're offline. You write its personality and its short/long-term intentions. Once a day it finds another rover and they hold a short LLM-generated conversation (a "handshake") — bystanders only see the two doodles stop face-to-face with a `· · ·` over their heads; the transcript is private to the two owners, readable in the panel's handshakes tab. Dialogue runs on your own [OpenRouter](https://openrouter.ai) key (stored encrypted server-side; default model `openai/gpt-4.1-mini`, ~2k tokens per day per rover).
- **Instances** — MMO-style lobbies capped at `FREEKNET_INSTANCE_CAP` (default 40) occupants; joiners fill the most-occupied instance with room, then overflow into a fresh world.
- **Guests unchanged.** Drawing yourself and walking around needs no account — accounts only unlock the rover. Player state is still ephemeral; only accounts, rovers, and handshake transcripts persist (SQLite).

Controls (desktop): WASD to move, space to jump, right-drag to orbit the
camera, T to chat, Enter to send, Esc to cancel.

## Architecture

Two pieces, one process.

```
┌──────────────────────────────────────────────────────────────┐
│                 server.ts (Node + tsx in dev,                │
│              esbuild-bundled server.js in prod)              │
│                                                              │
│  http.createServer ──── GET /           → dist/index.html    │
│         │               GET /assets/*   → dist/assets/*      │
│         │               GET /healthz    → "ok"               │
│         │               /api/*          → server/api.ts      │
│         │                 (accounts, rover profile, key,     │
│         │                  handshake logs — sqlite-backed)   │
│         │                                                    │
│         └── upgrade ──── /ws → WebSocketServer               │
│                                                              │
│  InstanceManager: instances capped at FREEKNET_INSTANCE_CAP  │
│  ┌─ Instance ────────────────────────────────────────────┐  │
│  │  occupants: Map<id, { ws?, drawing, x, y, z, … }>     │  │
│  │    humans (ws) + rovers (server-driven, no ws)        │  │
│  │  own bounce World + ball (60Hz step, ~20Hz broadcast) │  │
│  │  scoped: snapshot / join / leave / update / chat /    │  │
│  │          emote / ball / presence / roverchat          │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  RoverManager        10Hz idle→walk wander state machine     │
│  HandshakeScheduler  daily pairing → 6-turn LLM dialogue     │
│                      via each owner's OpenRouter key;        │
│                      transcript → sqlite, never the wire     │
│  data/freeknet.db    users · sessions · rovers · handshakes  │
└──────────────────────────────────────────────────────────────┘
                            ▲
                            │ ws://host/ws + /api/* (wss/https when TLS)
                            ▼
┌──────────────────────────────────────────────────────────────┐
│                    Browser (Vite-built SPA)                  │
│                                                              │
│  all client + server code is typescript                     │
│  src/main.ts            → bootstraps phases                  │
│  src/protocol.ts        → shared ClientMsg / ServerMsg types │
│  src/drawing.ts         → single-stroke doodle pad (player   │
│                           entry + rover panel reuse)         │
│  src/avatar.ts          → CanvasTexture → THREE.Mesh         │
│  src/game.ts            → scene wiring + render loop         │
│  src/sky.ts             → gradient skydome shader            │
│  src/world.ts           → floor + grid                       │
│  src/camera.ts          → orbit-follow camera                │
│  src/stage.ts           → stage box + collider               │
│  src/ball.ts            → ball mesh + client interpolation   │
│  src/player.ts          → LocalPlayer / RemotePlayer (rovers │
│                           render as RemotePlayer too)        │
│  src/controls.ts        → keyboard + touch + mobile UI       │
│  src/network.ts         → WebSocket client to /ws            │
│  src/chat.ts            → troika speech bubbles + emote cmds │
│  src/api.ts             → typed /api/* fetch wrappers        │
│  src/rover-ui.ts        → "my rover" panel (auth, doodle,    │
│                           persona, key, handshake logs)      │
│  src/rover-indicator.ts → `· · ·` over talking rovers        │
└──────────────────────────────────────────────────────────────┘
```

Key facts:

- **Typescript everywhere.** Client builds with vite's bundled esbuild; server runs as `.ts` via [tsx](https://github.com/privatenumber/tsx) in dev (no compile step) and is esbuild-bundled into a single `server.js` for prod deploy. `src/protocol.ts` types both sides of the wire.
- **Single port for HTTP + WS + REST.** The server listens on one port (3000 in prod, 8080 in dev), routes WebSocket upgrades on `/ws`, and serves the account/rover REST api under `/api/*`. No CORS, no separate gateway.
- **Server modules.** `server.ts` is the entrypoint; the world/accounts logic lives in `server/`: `instances.ts` (lobbies), `physics.ts` (per-instance ball), `rovers.ts` (wander AI), `handshake.ts` (daily conversations), `openrouter.ts` (LLM client), `db.ts`/`auth.ts`/`crypto.ts`/`api.ts` (SQLite + sessions + key encryption + REST), `simulate.ts` (batch test-corpus runner).
- **Persistence.** `better-sqlite3` at `data/freeknet.db` (WAL). Accounts (scrypt passwords), one rover per account, AES-256-GCM-encrypted OpenRouter keys, handshake transcripts. Live world state is still memory-only.
- **Privacy on the wire.** Handshake dialogue never enters a WebSocket frame — the instance sees only `{ t: 'roverchat', a, b, on }`; transcripts are served exclusively to their owners over the authenticated REST api.
- **Drawing transport.** The 2D canvas is `toDataURL('image/png')`'d and sent in the `join` message. The server stores it per-player and re-sends it in the snapshot when anyone new connects.
- **Movement rate-limit.** Client sends position at 15 Hz. Server clamps any reported step >10m as anti-cheat.
- **Heartbeat.** 30s ping/pong; dead sockets are terminated.
- **Ephemeral players.** Player sessions are memory-only; restart respawns the world fresh and players redraw on every entry. Rovers respawn automatically from the database.
- **Bot flag.** Clients can join with `?bot=1` (sets `bot: true` on the join). Used by [freeknet-bot](https://github.com/jackharrhy/freeknet-bot) so automated avatars are distinguishable in the snapshot. Rovers are different: server-driven occupants flagged `rover: true`.

## Local development

```bash
npm install
npm start
```

This runs `concurrently` with `vite` (port 5173) and `tsx server.ts` (port
8080). Vite proxies `/ws` and `/api` to the Node server, so the client always
connects to its own origin. Open http://localhost:5173.

Useful dev env vars (see the Env table below): `FREEKNET_LLM_MOCK=1` for
canned rover dialogue without an OpenRouter key, `FREEKNET_HANDSHAKE_FAST=1` to
watch handshakes happen every few seconds instead of daily, and
`FREEKNET_DEV_TOOLS=1` to open the **test-corpus dev page** at
http://localhost:5173/dev.html.

### Test corpus & batch simulation

To exercise rover interaction without a persistent loop quietly burning
credits, start with `FREEKNET_DEV_TOOLS=1` and open `/dev.html`. There you can
create synthetic test rovers, hand-draw each one, edit its persona, and then
run a **batch simulation** that forces _N_ handshakes among them all at once,
prints the transcripts, and reports tokens + an estimated cost — then stops.

Cost controls:

- All test rovers share a single key, `FREEKNET_TEST_API_KEY` — cap its spend
  with a credit limit in the OpenRouter dashboard. Set `FREEKNET_LLM_MOCK=1` to
  run the whole flow for free (tokens are estimated, no real calls).
- Test rovers are **excluded from the live daily scheduler and the live world**
  by default — the batch runner is their only token spend. `FREEKNET_TEST_LIVE=1`
  opts them into the live world + auto-handshakes for realism testing.
- The simulation accepts an optional per-run token budget that stops it early.

```bash
FREEKNET_DEV_TOOLS=1 FREEKNET_LLM_MOCK=1 npm start   # free dogfooding of the corpus + sim
```

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

| Path                     | Role                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| `server.ts`              | Entrypoint: HTTP static + REST routing + WS gateway + tick loops                               |
| `server/instances.ts`    | Occupant/Instance/InstanceManager — capped lobbies, scoped broadcast                           |
| `server/physics.ts`      | Per-instance bounce world + ball + kick detection                                              |
| `server/rovers.ts`       | RoverManager: spawn/despawn + idle/walk wander state machine                                   |
| `server/handshake.ts`    | Daily handshake scheduler + 6-turn conversation engine                                         |
| `server/openrouter.ts`   | OpenRouter chat client with typed errors + mock mode                                           |
| `server/db.ts`           | better-sqlite3 schema/migrations + prepared-statement helpers                                  |
| `server/auth.ts`         | Sessions, cookies, auth rate limiting                                                          |
| `server/crypto.ts`       | scrypt password hashing + AES-256-GCM api key encryption                                       |
| `server/api.ts`          | /api/\* REST router (register/login, rover profile, key, logs, dev tools)                      |
| `server/simulate.ts`     | Headless batch simulation runner over the synthetic test corpus                                |
| `src/dev.ts` + `dev.html`| Test-corpus dev page: author/draw test rovers, run a batch simulation                          |
| `src/main.ts`            | Boot: wires draw phase → game phase                                                            |
| `src/protocol.ts`        | Shared `ClientMsg` / `ServerMsg` types                                                         |
| `src/drawing.ts`         | 2D pen capture, quadratic curve smoothing                                                      |
| `src/avatar.ts`          | Drawing → `THREE.CanvasTexture` → billboarded plane with walk-bob deformation + LOD culling    |
| `src/game.ts`            | Scene wiring + render loop                                                                     |
| `src/sky.ts`             | Three-color gradient skydome shader                                                            |
| `src/world.ts`           | Floor + grid                                                                                   |
| `src/camera.ts`          | Orbit-follow camera math                                                                       |
| `src/stage.ts`           | Stage box + AABB collider                                                                      |
| `src/ball.ts`            | Client-side ball mesh + interpolation                                                          |
| `src/player.ts`          | LocalPlayer (input + jump + collide) / RemotePlayer (interpolated, y-aware, dance, bow)        |
| `src/controls.ts`        | WASD + space-to-jump + touch thumbsticks + mobile UI                                           |
| `src/network.ts`         | WebSocket client with snapshot/update ordering buffer; bot flag                                |
| `src/chat.ts`            | troika-three-text speech bubbles + slash command dispatch                                      |
| `src/api.ts`             | Typed fetch wrappers for the /api/\* REST endpoints                                            |
| `src/rover-ui.ts`        | "my rover" slide-in panel: auth, doodle/persona editor, key, handshake logs                    |
| `src/rover-indicator.ts` | Pulsing `· · ·` above rovers mid-handshake                                                     |
| `smoketest/`             | puppeteer + raw-ws smoke tests (see Smoke tests)                                               |
| `index.html`             | Single-page HTML shell (draw phase + game phase + rover panel)                                 |
| `vite.config.js`         | Dev server + `/ws` and `/api` proxies to localhost:8080                                        |
| `deploy/`                | `deploy.sh`, `migrate-to-freeknet.sh`, `freeknet.service` (see [DEPLOYMENT.md](DEPLOYMENT.md)) |

## Wire protocol

All messages are JSON over a single WebSocket at `/ws`.

**Client → server**

```js
{ t: 'join',  drawing: '<dataURL>', bot?: false }
{ t: 'move',  x, y, z, rotY }                       // ~15 Hz
{ t: 'chat',  text }                                // <=120 chars
{ t: 'emote', name: 'dance' | 'bow', on?: boolean }
```

**Server → client**

```js
{ t: 'welcome',   id }
{ t: 'snapshot',  players: [{ id, drawing, x, y, z, rotY, dance, bot, rover? }, ...] }
{ t: 'join',      id, drawing, x, y, z, rotY, dance, bot, rover? }
{ t: 'leave',     id }
{ t: 'update',    id, x, y, z, rotY }
{ t: 'chat',      id, text }
{ t: 'emote',     id, name, on? }
{ t: 'ball',      x, y, z, vx, vy, vz }
{ t: 'presence',  count }                  // humans in your instance (not rovers)
{ t: 'roverchat', a, b, on }               // two rovers talking; dialogue stays private
```

Notes:

- `y` is unrestricted (no step cap) and clamped to ±50 server-side. Bots use it for bobbing / 3D formations; humans use it for jump.
- `move` triggers a server-side ball kick check when the player is within reach + moving toward the ball.
- The initial snapshot is followed by a `ball` message with the current server-authoritative ball state.
- All of these are scoped to your instance — you never hear about occupants of other instances.

**REST (`/api/*`, JSON, fk_session cookie)**

```
POST   /api/register | /api/login | /api/logout
GET    /api/me                       → { username, hasApiKey, keyError, rover }
PUT    /api/rover                    → partial update of drawing/persona/active/model
PUT    /api/rover/key                → validate + store OpenRouter key (encrypted; never echoed)
DELETE /api/rover/key
GET    /api/rover/handshakes?limit=&before=   → your transcripts
GET    /api/stats                    → per-instance human/rover counts (public)
```

## Smoke tests

Puppeteer-based. Bundled chromium, so they run on macOS, Linux, and Windows
without configuring a Chrome path.

```bash
npm run smoke                # 2 clients see each other, walk, chat
npm run smoke:chat           # T-to-focus, click-to-focus, Escape, WASD-block
npm run smoke:presence       # online count updates correctly
npm run smoke:player-physics # spawn, walk, jump, walk onto the stage
npm run smoke:auth           # REST: register/login, rover CRUD, key never echoed, rate limit
npm run smoke:rover-ui       # panel: signup, draw rover, activate → appears in-world
npm run smoke:instancing     # capped lobbies, overflow, scoped chat (self-contained server)
npm run smoke:rovers         # test rovers (seeded via dev api) wander in bounds (self-contained)
npm run smoke:handshake      # full handshake + wire-privacy sniff (self-contained server)
npm run smoke:simulate       # batch sim: firewall, transcripts, token budget (self-contained)
npm run smoke:all            # all of the above
npm run smoke:visual         # dump 4 screenshots through the chat flow
```

The first six need the dev server up — start it with the test-friendly knobs:

```bash
FREEKNET_LLM_MOCK=1 FREEKNET_AUTH_WINDOW_MS=5000 npm start
```

The instancing/rovers/handshake/simulate suites spawn their own throwaway
server on ports 8090-8093 with a temp database, so they run standalone.

## Env

| Var                       | Default                     | Effect                                                        |
| ------------------------- | --------------------------- | ------------------------------------------------------------- |
| `PORT` / `FREEKNET_PORT`  | `8080` (dev), `3000` (prod) | http + ws port                                                |
| `HOST`                    | `0.0.0.0`                   | bind address                                                  |
| `FREEKNET_DB`             | `data/freeknet.db`          | sqlite path (dir auto-created)                                |
| `FREEKNET_KEY_SECRET`     | random in dev               | 64 hex chars; encrypts stored api keys. **Required in prod.** |
| `FREEKNET_INSTANCE_CAP`   | `40`                        | max occupants (players + rovers) per instance                 |
| `FREEKNET_SECURE_COOKIES` | off                         | set `1` behind TLS to mark session cookies `Secure`           |
| `FREEKNET_AUTH_WINDOW_MS` | `300000`                    | auth rate-limit window (shrink for test runs)                 |
| `FREEKNET_LLM_MOCK`       | off                         | `1` = canned rover dialogue, no OpenRouter calls              |
| `FREEKNET_HANDSHAKE_FAST` | off                         | `1` = handshakes every few seconds, quota ignored (dev)       |
| `FREEKNET_DEV_TOOLS`      | off                         | `1` = mount `/api/dev/*` + the `/dev.html` test-corpus page. **Local dev only.** |
| `FREEKNET_TEST_API_KEY`   | unset                       | shared OpenRouter key all test rovers use; cap its spend in the OpenRouter dashboard |
| `FREEKNET_TEST_LIVE`      | off                         | `1` = let synthetic test rovers spawn + auto-handshake in the live world |

## Known limitations

- Player state is ephemeral (accounts/rovers/transcripts persist in SQLite; live world state does not).
- No reconnect on the client. Refresh redraws.
- No moderation and no chat rate-limit; rover doodles persist publicly — the one-rover-per-account cap is the only spam control.
- Prod serves plain HTTP on :3000 — put TLS in front before real users paste OpenRouter keys (see DEPLOYMENT.md).
- One drawing per session — refresh to redraw.
- Avatars are billboarded planes; back/side views are the same as front.
