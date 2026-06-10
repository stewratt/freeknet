// freeknet server. http + ws on the same port. the world is split into
// instances (mmo-style lobbies, FREEKNET_INSTANCE_CAP occupants each), each
// with server-authoritative ball physics. accounts/rovers persist in sqlite;
// live world state stays in memory — restart respawns everything fresh.

import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFile, stat } from 'fs/promises';
import { join, extname, normalize } from 'path';
import { fileURLToPath } from 'url';
import type { ClientMsg, ServerMsg } from './src/protocol';
import { handleApi, setRoverHooks, setStatsProvider } from './server/api';
import { abortRunningHandshakes, pruneExpiredSessions } from './server/db';
import { InstanceManager, type Occupant } from './server/instances';
import { RoverManager } from './server/rovers';
import { HandshakeScheduler } from './server/handshake';
import { seedRovers } from './server/seed';

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
  if (await handleApi(req, res)) return;
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

  const safe = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
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

// ---- world (instanced) ----------------------------------------------------

export const instanceManager = new InstanceManager();
export const roverManager = new RoverManager(instanceManager);
const handshakeScheduler = new HandshakeScheduler(roverManager, instanceManager);
setStatsProvider(() => instanceManager.stats());
setRoverHooks({ onRoverChanged: (userId) => roverManager.onRoverChanged(userId) });

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
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
  let occ: Occupant | null = null;
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

      occ = instanceManager.add({
        id,
        kind: 'human',
        ws,
        drawing: msg.drawing,
        bot: isBot,
        x: 0,
        y: 0,
        z: 0,
        rotY: 0,
        dance: false,
        lastMoveAt: Date.now(),
      });
      const inst = occ.instance;

      // snapshot of everyone else in this instance
      send(ws, { t: 'snapshot', players: inst.snapshotFor(id) });
      send(ws, inst.physics.serialize());

      inst.broadcast(
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

      inst.maybeBroadcastPresence();
      return;
    }

    // every other message requires a joined occupant.
    const p = occ;
    if (!p) return;
    const inst = p.instance;

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
      inst.physics.tryKick(p, oldX, oldZ, moveDt);
      inst.broadcast({ t: 'update', id, x: p.x, y: p.y, z: p.z, rotY: p.rotY }, id);
    } else if (msg.t === 'chat') {
      const text = String(msg.text || '').slice(0, 120);
      if (!text) return;
      inst.broadcast({ t: 'chat', id, text });
    } else if (msg.t === 'emote') {
      if (msg.name === 'dance') {
        p.dance = !!msg.on;
        inst.broadcast({ t: 'emote', id, name: 'dance', on: p.dance }, id);
      } else if (msg.name === 'bow') {
        inst.broadcast({ t: 'emote', id, name: 'bow' }, id);
      }
    }
  });

  ws.on('close', () => {
    if (!occ) return;
    const inst = occ.instance;
    instanceManager.remove(occ);
    occ = null;
    inst.broadcast({ t: 'leave', id });
    inst.maybeBroadcastPresence();
  });

  ws.on('error', () => {});
});

// ---- physics + heartbeat ticks ------------------------------------------

// step each instance's bounce world at 60Hz, broadcast its ball at ~20Hz
// while moving. empty/unwatched instances are skipped entirely; their balls
// just freeze in place until someone joins.
const BALL_TICK_MS = 1000 / 60;
let lastBallStep = Date.now();
const ballTick = setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.1, (now - lastBallStep) / 1000);
  lastBallStep = now;
  for (const inst of instanceManager.instances.values()) {
    if (inst.humanCount() === 0) continue; // nobody watching; ball freezes
    const ballMsg = inst.physics.step(dt, now);
    if (ballMsg) inst.broadcast(ballMsg);
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
  roverManager.stop();
  handshakeScheduler.stop();
  for (const client of wss.clients) {
    try {
      client.close(1001, 'server shutdown');
    } catch {}
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// any handshakes left 'running' by a crash/restart are dead; quotas were only
// written on completion so nothing leaks.
abortRunningHandshakes();
pruneExpiredSessions();
seedRovers();
roverManager.start();
handshakeScheduler.start();

httpServer.listen(PORT, HOST, () => {
  console.log(`freeknet listening on http://${HOST}:${PORT}  (ws: /ws)`);
});
