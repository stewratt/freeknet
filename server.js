import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import { createServer } from 'http';
import { readFile, stat } from 'fs/promises';
import { join, extname, normalize } from 'path';
import { fileURLToPath } from 'url';

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const STATIC_DIR = join(__dirname, 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.map':  'application/json; charset=utf-8',
};

async function tryServe(filePath, res) {
  try {
    const st = await stat(filePath);
    if (!st.isFile()) return false;
    const body = await readFile(filePath);
    const type = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-cache',
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

const httpServer = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); res.end('method not allowed'); return;
  }

  if (req.url === '/healthz') { res.writeHead(200); res.end('ok'); return; }

  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  const safe = normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
  const filePath = join(STATIC_DIR, safe);

  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403); res.end('forbidden'); return;
  }

  if (await tryServe(filePath, res)) return;

  // SPA-ish fallback: serve index.html for unknown paths without extension
  if (!extname(urlPath)) {
    if (await tryServe(join(STATIC_DIR, 'index.html'), res)) return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  const path = (req.url || '').split('?')[0];
  if (path !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

const players = new Map();

// ---- world physics (must match client colliders in src/stage.js) ----
const COLLIDERS = [
  { x: 12.5, y: 0.35, z: 0, sx: 6, sy: 0.7, sz: 5 },  // stage
];

const BALL_RADIUS = 0.25;
const PLAYER_RADIUS = 0.45;
const PLAYER_HEIGHT = 1.8;
const BALL_SPAWN = { x: -5, y: BALL_RADIUS, z: 0 };
const ball = {
  x: BALL_SPAWN.x, y: BALL_SPAWN.y, z: BALL_SPAWN.z,
  vx: 0, vy: 0, vz: 0,
  dirty: true,
  restAccum: 0,
};

function ballSerialize() {
  return { t: 'ball', x: ball.x, y: ball.y, z: ball.z, vx: ball.vx, vy: ball.vy, vz: ball.vz };
}

function stepBall(dt) {
  ball.vy -= 22 * dt;

  let nx = ball.x + ball.vx * dt;
  let ny = ball.y + ball.vy * dt;
  let nz = ball.z + ball.vz * dt;

  // sphere vs each AABB collider
  for (const c of COLLIDERS) {
    const minX = c.x - c.sx / 2, maxX = c.x + c.sx / 2;
    const minY = c.y - c.sy / 2, maxY = c.y + c.sy / 2;
    const minZ = c.z - c.sz / 2, maxZ = c.z + c.sz / 2;
    const cx = Math.max(minX, Math.min(nx, maxX));
    const cy = Math.max(minY, Math.min(ny, maxY));
    const cz = Math.max(minZ, Math.min(nz, maxZ));
    const dx = nx - cx, dy = ny - cy, dz = nz - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < BALL_RADIUS * BALL_RADIUS) {
      let nrx, nry, nrz, pen;
      const d = Math.sqrt(d2);
      if (d > 0.0001) {
        nrx = dx / d; nry = dy / d; nrz = dz / d;
        pen = BALL_RADIUS - d;
      } else {
        // center inside box; eject along smallest face axis
        const overTop = Math.abs(maxY - ny), overBot = Math.abs(ny - minY);
        const overR = Math.abs(maxX - nx), overL = Math.abs(nx - minX);
        const overF = Math.abs(maxZ - nz), overB = Math.abs(nz - minZ);
        const m = Math.min(overTop, overBot, overR, overL, overF, overB);
        nrx = nry = nrz = 0;
        if (m === overTop) { nry = 1; pen = m + BALL_RADIUS; }
        else if (m === overBot) { nry = -1; pen = m + BALL_RADIUS; }
        else if (m === overR) { nrx = 1; pen = m + BALL_RADIUS; }
        else if (m === overL) { nrx = -1; pen = m + BALL_RADIUS; }
        else if (m === overF) { nrz = 1; pen = m + BALL_RADIUS; }
        else { nrz = -1; pen = m + BALL_RADIUS; }
      }
      nx += nrx * pen; ny += nry * pen; nz += nrz * pen;
      const vDotN = ball.vx * nrx + ball.vy * nry + ball.vz * nrz;
      if (vDotN < 0) {
        const rest = 0.45;
        ball.vx -= (1 + rest) * vDotN * nrx;
        ball.vy -= (1 + rest) * vDotN * nry;
        ball.vz -= (1 + rest) * vDotN * nrz;
      }
    }
  }

  // ground
  if (ny < BALL_RADIUS) {
    ny = BALL_RADIUS;
    if (ball.vy < 0) ball.vy = -ball.vy * 0.45;
    if (Math.abs(ball.vy) < 0.5) ball.vy = 0;
    const fric = Math.pow(0.15, dt);
    ball.vx *= fric;
    ball.vz *= fric;
  } else {
    const drag = Math.pow(0.6, dt);
    ball.vx *= drag;
    ball.vz *= drag;
  }

  ball.x = nx; ball.y = ny; ball.z = nz;

  if (Math.abs(ball.vx) < 0.04) ball.vx = 0;
  if (Math.abs(ball.vz) < 0.04) ball.vz = 0;
  if (Math.abs(ball.vy) < 0.04 && ball.y <= BALL_RADIUS + 0.01) ball.vy = 0;

  const speed2 = ball.vx*ball.vx + ball.vy*ball.vy + ball.vz*ball.vz;
  if (speed2 < 0.001) {
    ball.restAccum += dt;
  } else {
    ball.restAccum = 0;
    ball.dirty = true;
  }

  // if ball ends up somewhere absurd, respawn
  if (ball.y < -5 || Math.abs(ball.x) > 80 || Math.abs(ball.z) > 80) {
    ball.x = BALL_SPAWN.x; ball.y = BALL_SPAWN.y; ball.z = BALL_SPAWN.z;
    ball.vx = ball.vy = ball.vz = 0;
    ball.dirty = true;
  }
}

function tryKick(p, oldX, oldZ, dt) {
  // horizontal proximity
  const dx = ball.x - p.x;
  const dz = ball.z - p.z;
  const dist = Math.hypot(dx, dz);
  const reach = PLAYER_RADIUS + BALL_RADIUS + 0.1;
  if (dist >= reach) return;
  // vertical overlap (player feet at p.y, head at p.y + PLAYER_HEIGHT)
  if (ball.y - BALL_RADIUS > p.y + PLAYER_HEIGHT) return;
  if (ball.y + BALL_RADIUS < p.y) return;

  const len = dist || 0.0001;
  const nrx = dx / len;
  const nrz = dz / len;
  const vx = (p.x - oldX) / dt;
  const vz = (p.z - oldZ) / dt;
  const vTowardBall = vx * nrx + vz * nrz;
  if (vTowardBall <= 0.1) {
    // standing on/in ball — just push it out
    const pen = reach - dist;
    if (pen > 0) {
      ball.x += nrx * pen;
      ball.z += nrz * pen;
      ball.dirty = true;
    }
    return;
  }
  const kickK = 1.7;
  ball.vx += nrx * vTowardBall * kickK;
  ball.vz += nrz * vTowardBall * kickK;
  // small upward arc when grounded
  if (ball.y <= BALL_RADIUS + 0.02) {
    ball.vy = Math.max(ball.vy, vTowardBall * 0.35);
  }
  // separate immediately
  const pen = reach - dist;
  if (pen > 0) {
    ball.x += nrx * pen;
    ball.z += nrz * pen;
  }
  ball.dirty = true;
  ball.restAccum = 0;
}

function broadcast(msg, exceptId = null) {
  const json = JSON.stringify(msg);
  for (const [id, p] of players) {
    if (id === exceptId) continue;
    if (p.ws.readyState === 1) p.ws.send(json);
  }
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws) => {
  const id = randomUUID();
  ws.id = id;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  send(ws, { t: 'welcome', id });

  const snapshot = [];
  for (const [pid, p] of players) {
    snapshot.push({ id: pid, drawing: p.drawing, x: p.x, y: p.y ?? 0, z: p.z, rotY: p.rotY, dance: !!p.dance });
  }
  send(ws, { t: 'snapshot', players: snapshot });
  send(ws, ballSerialize());

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.t === 'join') {
      const p = {
        ws,
        drawing: msg.drawing,
        x: 0,
        y: 0,
        z: 0,
        rotY: 0,
        dance: false,
        lastMoveAt: Date.now(),
        joined: true,
      };
      players.set(id, p);
      broadcast({ t: 'join', id, drawing: msg.drawing, x: 0, y: 0, z: 0, rotY: 0, dance: false }, id);
    } else if (msg.t === 'move') {
      const p = players.get(id);
      if (!p) return;
      const dx = msg.x - p.x;
      const dz = msg.z - p.z;
      if (dx * dx + dz * dz > 100) return;
      const y = typeof msg.y === 'number' ? msg.y : 0;
      if (y < -2 || y > 20) return;
      const now = Date.now();
      const moveDt = Math.max(0.016, Math.min(0.5, (now - (p.lastMoveAt || now)) / 1000));
      const oldX = p.x, oldZ = p.z;
      p.x = msg.x; p.y = y; p.z = msg.z; p.rotY = msg.rotY;
      p.lastMoveAt = now;
      tryKick(p, oldX, oldZ, moveDt);
      broadcast({ t: 'update', id, x: p.x, y: p.y, z: p.z, rotY: p.rotY }, id);
    } else if (msg.t === 'chat') {
      const p = players.get(id);
      if (!p) return;
      const text = String(msg.text || '').slice(0, 120);
      if (!text) return;
      broadcast({ t: 'chat', id, text });
    } else if (msg.t === 'emote') {
      const p = players.get(id);
      if (!p) return;
      if (msg.name === 'dance') {
        p.dance = !!msg.on;
        broadcast({ t: 'emote', id, name: 'dance', on: p.dance }, id);
      } else if (msg.name === 'bow') {
        broadcast({ t: 'emote', id, name: 'bow' }, id);
      }
    }
  });

  ws.on('close', () => {
    if (players.has(id)) {
      players.delete(id);
      broadcast({ t: 'leave', id });
    }
  });

  ws.on('error', () => {});
});

// ball physics: step at 60Hz, broadcast at ~20Hz while moving
const BALL_TICK_MS = 1000 / 60;
const BALL_BROADCAST_MS = 50;
let lastBallBroadcast = 0;
let lastBallStep = Date.now();
const ballTick = setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.1, (now - lastBallStep) / 1000);
  lastBallStep = now;
  stepBall(dt);
  if (ball.dirty && now - lastBallBroadcast >= BALL_BROADCAST_MS) {
    broadcast(ballSerialize());
    lastBallBroadcast = now;
    // once it has rested for a beat, stop broadcasting until kicked again
    if (ball.restAccum > 0.3) ball.dirty = false;
  }
}, BALL_TICK_MS);

const heartbeat = setInterval(() => {
  for (const client of wss.clients) {
    if (!client.isAlive) { client.terminate(); continue; }
    client.isAlive = false;
    try { client.ping(); } catch {}
  }
}, 30000);

wss.on('close', () => {
  clearInterval(heartbeat);
  clearInterval(ballTick);
});

httpServer.listen(PORT, HOST, () => {
  console.log(`freeknet listening on http://${HOST}:${PORT}  (ws path: /ws)`);
});
