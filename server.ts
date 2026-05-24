// freeknet server. http + ws on the same port, one big world (no rooms, no
// persistence — every join is a fresh draw), server-authoritative ball
// physics, and a webrtc signaling relay for proximity voice.
//
// state lives in memory. restart wipes everything. that's the vibe.

import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFile, stat } from 'fs/promises';
import { join, extname, normalize } from 'path';
import { fileURLToPath } from 'url';
import { World, Vec3, type Body } from '@perplexdotgg/bounce';
import type { ClientMsg, ServerMsg, SnapshotPlayer, BallMsg } from './src/protocol';

const PORT = Number(process.env.PORT ?? process.env.FREEKNET_PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const STATIC_DIR = join(__dirname, 'dist');

// ---- static file server -------------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

async function tryServe(filePath: string, res: ServerResponse): Promise<boolean> {
  try {
    const st = await stat(filePath);
    if (!st.isFile()) return false;
    const body = await readFile(filePath);
    const type = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end('method not allowed');
    return;
  }
  if (req.url === '/healthz') {
    res.writeHead(200);
    res.end('ok');
    return;
  }

  let urlPath = (req.url ?? '/').split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  const safe = normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
  const filePath = join(STATIC_DIR, safe);
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  if (await tryServe(filePath, res)) return;
  if (!extname(urlPath)) {
    if (await tryServe(join(STATIC_DIR, 'index.html'), res)) return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

// ---- world physics (bounce-driven) --------------------------------------
//
// the ball's collision response, gravity, friction, and restitution are
// owned by @perplexdotgg/bounce. we still own player↔ball kick detection
// (a velocity-based reach test) and we still apply our own sleep + broadcast
// throttling on top, because the on-the-wire protocol is { x, y, z, vx, vy,
// vz } at ~20Hz and we don't want to send updates when the ball is at rest.
//
// the COLLIDERS array is the single source of truth for world geometry.
// each entry becomes a bounce static box body at server start. the client
// constructs visually-equivalent boxes from src/stage.ts; both must agree on
// position + size. (a future TrenchBroom-style map pipeline would replace
// this hardcoded array with a loaded scene, server-side.)

interface Collider {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
}

const COLLIDERS: Collider[] = [
  { x: 12.5, y: 0.35, z: 0, sx: 6, sy: 0.7, sz: 5 }, // stage
];

const BALL_RADIUS = 0.25;
const BALL_MASS = 0.5;
const PLAYER_RADIUS = 0.45;
const PLAYER_HEIGHT = 1.8;
const BALL_SPAWN = { x: -5, y: BALL_RADIUS + 0.5, z: 0 };
// matches the snappier-than-real-world feel of the previous hand-rolled
// physics. bounce defaults to -9.81 (real gravity).
const WORLD_GRAVITY = -22;
// kick scaling: an impulse along the player's horizontal velocity-toward-ball
// vector. units are mass·velocity; tuned by direct comparison against the
// old hand-rolled kick (which gave the ball peak ~15 m/s after a walk-in
// kick from a standing start).
const KICK_IMPULSE_K = 1.7;
// small upward arc on a grounded kick.
const KICK_UP_K = 0.35;
// threshold below which we consider the ball "at rest" for broadcast
// throttling. squared linear speed; covers x+y+z.
const REST_SPEED2 = 0.04 * 0.04 * 3;

const physicsWorld = new World({
  gravity: [0, WORLD_GRAVITY, 0],
  timeStepSizeSeconds: 1 / 60,
});

// add static colliders (the stage, etc.). high friction on the ground +
// stage so the ball doesn't keep rolling forever the way it does with
// bounce's default Coulomb friction.
for (const c of COLLIDERS) {
  const shape = physicsWorld.createBox({ width: c.sx, height: c.sy, depth: c.sz });
  physicsWorld.createStaticBody({
    shape,
    position: [c.x, c.y, c.z],
    friction: 0.95,
    restitution: 0.3,
  });
}

// a ground plane at y=0 so the ball doesn't fall forever. an enormous thin
// box centered at y=-0.5 means the ball lands when its center is at y=0.5
// (which, with radius=0.25, means rest at y=0.25 — matching the old
// `if (ny < BALL_RADIUS)` ground clamp).
{
  const groundShape = physicsWorld.createBox({ width: 200, height: 1, depth: 200 });
  physicsWorld.createStaticBody({
    shape: groundShape,
    position: [0, -0.5, 0],
    friction: 0.95,
    restitution: 0.4,
  });
}

const ballShape = physicsWorld.createSphere({ radius: BALL_RADIUS });
const ballBody: Body = physicsWorld.createDynamicBody({
  shape: ballShape,
  position: [BALL_SPAWN.x, BALL_SPAWN.y, BALL_SPAWN.z],
  mass: BALL_MASS,
  friction: 0.9,
  restitution: 0.45,
  // bounce's default world linearDamping (0.05) is way too low for the
  // playful "ball stops rolling pretty quickly" feel we want. these match
  // the old hand-rolled drag/friction much more closely:
  //   - linearDamping=0.5 is the airborne drag (old `Math.pow(0.6, dt)`)
  //   - high friction on ball + ground (0.9 * 0.95) does the ground-rolling
  //     deceleration via Coulomb friction proportional to gravity
  //   - angularDamping=2.0 kills the spin once linear motion stops
  linearDamping: 0.5,
  angularDamping: 2.0,
});

// broadcast-throttling memo (separate from bounce's internal sleeping).
let ballDirty = true;
let ballRestAccum = 0;

function ballSerialize(): BallMsg {
  return {
    t: 'ball',
    x: ballBody.position.x,
    y: ballBody.position.y,
    z: ballBody.position.z,
    vx: ballBody.linearVelocity.x,
    vy: ballBody.linearVelocity.y,
    vz: ballBody.linearVelocity.z,
  };
}

function respawnBallIfStrayed(): void {
  const p = ballBody.position;
  if (p.y < -5 || Math.abs(p.x) > 80 || Math.abs(p.z) > 80) {
    ballBody.position.set([BALL_SPAWN.x, BALL_SPAWN.y, BALL_SPAWN.z]);
    ballBody.linearVelocity.set([0, 0, 0]);
    ballBody.angularVelocity.set([0, 0, 0]);
    ballBody.commitChanges();
    ballDirty = true;
    ballRestAccum = 0;
  }
}

interface Player {
  ws: WebSocket;
  drawing: string;
  bot: boolean;
  x: number;
  y: number;
  z: number;
  rotY: number;
  dance: boolean;
  lastMoveAt: number;
}

function tryKick(p: Player, oldX: number, oldZ: number, dt: number): void {
  const ballPos = ballBody.position;
  const dx = ballPos.x - p.x;
  const dz = ballPos.z - p.z;
  const dist = Math.hypot(dx, dz);
  const reach = PLAYER_RADIUS + BALL_RADIUS + 0.1;
  if (dist >= reach) return;
  // vertical overlap (player feet at p.y, head at p.y + PLAYER_HEIGHT)
  if (ballPos.y - BALL_RADIUS > p.y + PLAYER_HEIGHT) return;
  if (ballPos.y + BALL_RADIUS < p.y) return;

  const len = dist || 0.0001;
  const nrx = dx / len;
  const nrz = dz / len;
  const vx = (p.x - oldX) / dt;
  const vz = (p.z - oldZ) / dt;
  const vTowardBall = vx * nrx + vz * nrz;

  if (vTowardBall <= 0.1) {
    // standing on/in the ball — gently push it out so they don't tunnel.
    const pen = reach - dist;
    if (pen > 0.001) {
      ballBody.position.set([ballPos.x + nrx * pen, ballPos.y, ballPos.z + nrz * pen]);
      ballBody.commitChanges();
      ballDirty = true;
    }
    return;
  }

  // active kick: apply an impulse (mass · velocity). small upward component
  // when the ball is roughly on the ground so kicks pop up.
  const ix = nrx * vTowardBall * KICK_IMPULSE_K * BALL_MASS;
  const iz = nrz * vTowardBall * KICK_IMPULSE_K * BALL_MASS;
  let iy = 0;
  if (ballPos.y <= BALL_RADIUS + 0.05) {
    iy = vTowardBall * KICK_UP_K * BALL_MASS;
  }
  ballBody.applyLinearImpulse(new Vec3([ix, iy, iz]));
  ballDirty = true;
  ballRestAccum = 0;
}

// ---- world (one global player map) --------------------------------------

const players = new Map<string, Player>();
let lastPresenceCount = -1;

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(msg: ServerMsg, exceptId: string | null = null): void {
  const json = JSON.stringify(msg);
  for (const [id, p] of players) {
    if (id === exceptId) continue;
    if (p.ws.readyState === 1) p.ws.send(json);
  }
}

function maybeBroadcastPresence(): void {
  const count = players.size;
  if (count === lastPresenceCount) return;
  lastPresenceCount = count;
  broadcast({ t: 'presence', count });
}

// ---- ws server ----------------------------------------------------------

interface AliveWS extends WebSocket {
  id?: string;
  isAlive?: boolean;
  joined?: boolean;
}

const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  const path = (req.url ?? '').split('?')[0];
  if (path !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (rawWs: WebSocket) => {
  const ws = rawWs as AliveWS;
  const id = randomUUID();
  ws.id = id;
  ws.isAlive = true;
  ws.joined = false;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  send(ws, { t: 'welcome', id });

  ws.on('message', (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw.toString()) as ClientMsg;
    } catch {
      return;
    }

    if (msg.t === 'join') {
      if (ws.joined) return; // ignore re-joins on the same socket
      ws.joined = true;
      const isBot = msg.bot === true;

      const p: Player = {
        ws,
        drawing: msg.drawing,
        bot: isBot,
        x: 0,
        y: 0,
        z: 0,
        rotY: 0,
        dance: false,
        lastMoveAt: Date.now(),
      };
      players.set(id, p);

      // snapshot of everyone else
      const snapshot: SnapshotPlayer[] = [];
      for (const [pid, other] of players) {
        if (pid === id) continue;
        snapshot.push({
          id: pid,
          drawing: other.drawing,
          x: other.x,
          y: other.y,
          z: other.z,
          rotY: other.rotY,
          dance: !!other.dance,
          bot: !!other.bot,
        });
      }
      send(ws, { t: 'snapshot', players: snapshot });
      send(ws, ballSerialize());

      broadcast(
        {
          t: 'join',
          id,
          drawing: msg.drawing,
          x: 0,
          y: 0,
          z: 0,
          rotY: 0,
          dance: false,
          bot: isBot,
        },
        id,
      );

      maybeBroadcastPresence();
      return;
    }

    // every other message requires a joined player.
    const p = players.get(id);
    if (!p) return;

    if (msg.t === 'move') {
      const dx = msg.x - p.x;
      const dz = msg.z - p.z;
      if (dx * dx + dz * dz > 100) return;
      const yIn = typeof msg.y === 'number' && Number.isFinite(msg.y) ? msg.y : p.y;
      // y is unrestricted (no step cap) and clamped to a sane range so a
      // malicious client can't push their avatar up into the skybox. bots
      // need wide vertical range for bobbing / sphere formations, so the
      // clamp is generous.
      const y = Math.max(-50, Math.min(50, yIn));

      const now = Date.now();
      const moveDt = Math.max(0.016, Math.min(0.5, (now - (p.lastMoveAt || now)) / 1000));
      const oldX = p.x,
        oldZ = p.z;
      p.x = msg.x;
      p.y = y;
      p.z = msg.z;
      p.rotY = msg.rotY;
      p.lastMoveAt = now;
      tryKick(p, oldX, oldZ, moveDt);
      broadcast({ t: 'update', id, x: p.x, y: p.y, z: p.z, rotY: p.rotY }, id);
    } else if (msg.t === 'chat') {
      const text = String(msg.text || '').slice(0, 120);
      if (!text) return;
      broadcast({ t: 'chat', id, text });
    } else if (msg.t === 'emote') {
      if (msg.name === 'dance') {
        p.dance = !!msg.on;
        broadcast({ t: 'emote', id, name: 'dance', on: p.dance }, id);
      } else if (msg.name === 'bow') {
        broadcast({ t: 'emote', id, name: 'bow' }, id);
      }
    } else if (msg.t === 'rtc') {
      // signaling-only relay for webrtc proximity voice. forward the payload
      // to a single target. payload size is small (SDP or a single ICE
      // candidate); we don't inspect or rewrite it.
      const target = players.get(msg.to);
      if (!target) return;
      const out: ServerMsg = { t: 'rtc', from: id, payload: msg.payload };
      if (target.ws.readyState === 1) target.ws.send(JSON.stringify(out));
    }
  });

  ws.on('close', () => {
    if (!players.has(id)) return;
    players.delete(id);
    broadcast({ t: 'leave', id });
    maybeBroadcastPresence();
  });

  ws.on('error', () => {});
});

// ---- physics + heartbeat ticks ------------------------------------------

// step the bounce world at 60Hz, broadcast ball state at ~20Hz while moving.
// when nobody's connected we skip stepping entirely; the ball just freezes
// in place until the next player joins.
const BALL_TICK_MS = 1000 / 60;
const BALL_BROADCAST_MS = 50;
let lastBallBroadcast = 0;
let lastBallStep = Date.now();
const ballTick = setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.1, (now - lastBallStep) / 1000);
  lastBallStep = now;
  if (players.size === 0) return;

  physicsWorld.takeOneStep(dt);

  // low-speed cutoff: bounce decays smoothly toward zero but the ball will
  // coast at 0.1 m/s for a long time before truly stopping, which doesn't
  // feel right. snap velocity to zero below a threshold (matches the old
  // `if Math.abs(ball.vx) < 0.04 then 0` cutoffs).
  const v = ballBody.linearVelocity;
  const av = ballBody.angularVelocity;
  let touched = false;
  if (Math.abs(v.x) < 0.15) {
    v.x = 0;
    touched = true;
  }
  if (Math.abs(v.z) < 0.15) {
    v.z = 0;
    touched = true;
  }
  if (Math.abs(v.y) < 0.15 && ballBody.position.y <= BALL_RADIUS + 0.05) {
    v.y = 0;
    touched = true;
  }
  // dampen residual spin too once linear motion is dead
  if (touched && v.x === 0 && v.z === 0 && v.y === 0) {
    av.x = av.y = av.z = 0;
  }
  if (touched) ballBody.commitChanges();

  // update dirty + rest tracking from the body's velocity. bounce has its
  // own sleeping but the on-the-wire protocol still wants us to throttle.
  const speed2 = v.x * v.x + v.y * v.y + v.z * v.z;
  if (speed2 < REST_SPEED2) {
    ballRestAccum += dt;
  } else {
    ballRestAccum = 0;
    ballDirty = true;
  }

  respawnBallIfStrayed();

  if (ballDirty && now - lastBallBroadcast >= BALL_BROADCAST_MS) {
    broadcast(ballSerialize());
    lastBallBroadcast = now;
    if (ballRestAccum > 0.3) ballDirty = false;
  }
}, BALL_TICK_MS);

const heartbeat = setInterval(() => {
  for (const rawClient of wss.clients) {
    const client = rawClient as AliveWS;
    if (!client.isAlive) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    try {
      client.ping();
    } catch {}
  }
}, 30000);

wss.on('close', () => {
  clearInterval(heartbeat);
  clearInterval(ballTick);
});

// ---- shutdown ----------------------------------------------------------

function shutdown(): void {
  console.log('shutting down...');
  clearInterval(heartbeat);
  clearInterval(ballTick);
  for (const client of wss.clients) {
    try {
      client.close(1001, 'server shutdown');
    } catch {}
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

httpServer.listen(PORT, HOST, () => {
  console.log(`freeknet listening on http://${HOST}:${PORT}  (ws: /ws)`);
});
