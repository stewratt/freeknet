// instancing smoke test. spawns its own server (cap=2, temp db) and drives
// raw ws clients — no browser needed; the lobby logic is fully observable
// from snapshots, joins, leaves, and presence counts.

import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WebSocket } from 'ws';
import { makeRunner, sleep } from './helpers';

const PORT = 8090;
const URL_BASE = `http://localhost:${PORT}`;

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function startServer(env: Record<string, string>): ChildProcess {
  const dir = mkdtempSync(join(tmpdir(), 'freeknet-smoke-'));
  return spawn('npx', ['tsx', 'server.ts'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      FREEKNET_DB: join(dir, 'test.db'),
      FREEKNET_LLM_MOCK: '1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${URL_BASE}/healthz`);
      if (res.ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error('server did not come up');
}

interface Client {
  ws: WebSocket;
  id: string;
  snapshot: Array<{ id: string }>;
  presence: number;
  joins: string[];
  leaves: string[];
  close(): void;
}

function connect(): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    const c: Client = {
      ws,
      id: '',
      snapshot: [],
      presence: 0,
      joins: [],
      leaves: [],
      close: () => ws.close(),
    };
    const timer = setTimeout(() => reject(new Error('join timed out')), 5000);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.t === 'welcome') {
        c.id = msg.id;
        ws.send(JSON.stringify({ t: 'join', drawing: TINY_PNG }));
      } else if (msg.t === 'snapshot') {
        c.snapshot = msg.players;
        clearTimeout(timer);
        resolve(c);
      } else if (msg.t === 'presence') {
        c.presence = msg.count;
      } else if (msg.t === 'join') {
        c.joins.push(msg.id);
      } else if (msg.t === 'leave') {
        c.leaves.push(msg.id);
      }
    });
    ws.on('error', reject);
  });
}

async function stats(): Promise<Array<{ id: string; humans: number; rovers: number }>> {
  const res = await fetch(`${URL_BASE}/api/stats`);
  return (await res.json()).instances;
}

async function main(): Promise<void> {
  const r = makeRunner();
  const server = startServer({ FREEKNET_INSTANCE_CAP: '2' });
  const serverLog: string[] = [];
  server.stdout?.on('data', (d) => serverLog.push(String(d)));
  server.stderr?.on('data', (d) => serverLog.push(String(d)));

  try {
    await waitForServer();

    let c1!: Client, c2!: Client, c3!: Client;

    await r.test('first two joiners share an instance', async () => {
      c1 = await connect();
      r.expect(c1.snapshot.length === 0, 'c1 sees an empty world');
      c2 = await connect();
      r.expect(c2.snapshot.length === 1, `c2 sees c1 (got ${c2.snapshot.length})`);
      r.expect(c2.snapshot[0].id === c1.id, 'c2 snapshot contains c1');
      await sleep(300);
      r.expect(c1.joins.includes(c2.id), 'c1 received c2 join broadcast');
      r.expect(c1.presence === 2 && c2.presence === 2, 'both see presence 2');
      r.pass('instance 1 fills');
    });

    await r.test('third joiner overflows to a new instance', async () => {
      c3 = await connect();
      r.expect(c3.snapshot.length === 0, `c3 sees nobody (got ${c3.snapshot.length})`);
      await sleep(300);
      r.expect(!c1.joins.includes(c3.id), 'c1 never saw c3 join');
      r.expect(c3.presence === 1, `c3 presence is 1 (got ${c3.presence})`);
      const s = await stats();
      r.expect(s.length === 2, `two instances exist (got ${s.length})`);
      r.expect(
        s.some((i) => i.humans === 2) && s.some((i) => i.humans === 1),
        `instances hold 2+1 humans (got ${JSON.stringify(s)})`,
      );
      r.pass('overflow works');
    });

    await r.test('chat stays inside an instance', async () => {
      let c3GotChat = false;
      c3.ws.on('message', (raw) => {
        if (JSON.parse(raw.toString()).t === 'chat') c3GotChat = true;
      });
      c1.ws.send(JSON.stringify({ t: 'chat', text: 'hello instance 1' }));
      await sleep(400);
      r.expect(!c3GotChat, 'c3 (other instance) never received the chat');
      r.pass('broadcast scoped to instance');
    });

    await r.test('a freed slot is refilled before opening a new instance', async () => {
      c1.close();
      await sleep(400);
      r.expect(c2.leaves.includes(c1.id), 'c2 saw c1 leave');
      const c4 = await connect();
      r.expect(c4.snapshot.length === 1 && c4.snapshot[0].id === c2.id, 'c4 lands next to c2');
      c4.close();
      r.pass('best-fit refill works');
    });

    await r.test('empty instances are destroyed', async () => {
      c2.close();
      c3.close();
      await sleep(400);
      const s = await stats();
      r.expect(s.length === 0, `no instances remain (got ${JSON.stringify(s)})`);
      r.pass('cleanup works');
    });
  } catch (e) {
    console.error('fatal:', e);
    console.error('server log tail:', serverLog.slice(-10).join(''));
    server.kill();
    process.exit(1);
  }

  server.kill();
  process.exit(r.summary() ? 0 : 1);
}

main();
