import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';

const PORT = 8080;
const wss = new WebSocketServer({ port: PORT });

const players = new Map();

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
    snapshot.push({ id: pid, drawing: p.drawing, x: p.x, z: p.z, rotY: p.rotY });
  }
  send(ws, { t: 'snapshot', players: snapshot });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.t === 'join') {
      const p = {
        ws,
        drawing: msg.drawing,
        x: 0,
        z: 0,
        rotY: 0,
        joined: true,
      };
      players.set(id, p);
      broadcast({ t: 'join', id, drawing: msg.drawing, x: 0, z: 0, rotY: 0 }, id);
    } else if (msg.t === 'move') {
      const p = players.get(id);
      if (!p) return;
      const dx = msg.x - p.x;
      const dz = msg.z - p.z;
      if (dx * dx + dz * dz > 100) return;
      p.x = msg.x; p.z = msg.z; p.rotY = msg.rotY;
      broadcast({ t: 'update', id, x: p.x, z: p.z, rotY: p.rotY }, id);
    } else if (msg.t === 'chat') {
      const p = players.get(id);
      if (!p) return;
      const text = String(msg.text || '').slice(0, 120);
      if (!text) return;
      broadcast({ t: 'chat', id, text });
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

const heartbeat = setInterval(() => {
  for (const client of wss.clients) {
    if (!client.isAlive) { client.terminate(); continue; }
    client.isAlive = false;
    try { client.ping(); } catch {}
  }
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

console.log(`WS server listening on :${PORT}`);
