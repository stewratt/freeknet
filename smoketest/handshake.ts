// handshake smoke test. spawns a server with 2 seeded rovers, mock llm, and
// fast scheduling, then watches the wire and the db:
//   - a `roverchat on` arrives naming both rovers
//   - the rovers converge to ~1.5u apart and freeze facing each other
//   - NO ws frame ever contains conversation text (privacy on the wire)
//   - a `roverchat off` arrives
//   - the db row is status=done with a 6-line alternating transcript

import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WebSocket } from 'ws';
import Database from 'better-sqlite3';
import { makeRunner, sleep } from './helpers';

const PORT = 8092;
const DB_PATH = join(mkdtempSync(join(tmpdir(), 'freeknet-smoke-')), 'test.db');

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function startServer(): ChildProcess {
  return spawn('npx', ['tsx', 'server.ts'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      FREEKNET_DB: DB_PATH,
      FREEKNET_LLM_MOCK: '1',
      FREEKNET_HANDSHAKE_FAST: '1',
      FREEKNET_SEED_ROVERS: '2',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://localhost:${PORT}/healthz`);
      if (res.ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error('server did not come up');
}

// poll until a ws-handler-driven condition flips (loop body can't see the
// mutation, so a plain while-loop trips the lint's unmodified-condition rule)
async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(250);
  }
  return cond();
}

async function main(): Promise<void> {
  const r = makeRunner();
  const server = startServer();
  const log: string[] = [];
  server.stdout?.on('data', (d) => log.push(String(d)));
  server.stderr?.on('data', (d) => log.push(String(d)));

  try {
    await waitForServer();

    const frames: string[] = [];
    const positions = new Map<string, { x: number; z: number; at: number }>();
    let chatOn: { a: string; b: string } | null = null;
    let chatOff = false;
    let frozenGap: number | null = null;

    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    ws.on('message', (raw) => {
      const frame = raw.toString();
      frames.push(frame);
      const msg = JSON.parse(frame);
      if (msg.t === 'welcome') {
        ws.send(JSON.stringify({ t: 'join', drawing: TINY_PNG }));
      } else if (msg.t === 'update') {
        positions.set(msg.id, { x: msg.x, z: msg.z, at: Date.now() });
      } else if (msg.t === 'snapshot') {
        for (const p of msg.players) positions.set(p.id, { x: p.x, z: p.z, at: Date.now() });
      } else if (msg.t === 'roverchat') {
        if (msg.on && !chatOn) {
          chatOn = { a: msg.a, b: msg.b };
        } else if (!msg.on && chatOn && msg.a === chatOn.a) {
          // sample the gap at the moment the conversation ends
          const pa = positions.get(chatOn.a);
          const pb = positions.get(chatOn.b);
          if (pa && pb) frozenGap = Math.hypot(pa.x - pb.x, pa.z - pb.z);
          chatOff = true;
        }
      }
    });

    await r.test('a handshake starts within 30s', async () => {
      await waitFor(() => !!chatOn, 30000);
      r.expect(!!chatOn, 'roverchat on received');
      r.expect(
        chatOn!.a.startsWith('rover-') && chatOn!.b.startsWith('rover-'),
        `participants are rovers (${chatOn!.a}, ${chatOn!.b})`,
      );
      r.pass(`talking: ${chatOn!.a} ↔ ${chatOn!.b}`);
    });

    await r.test('the conversation ends with roverchat off', async () => {
      await waitFor(() => chatOff, 30000);
      r.expect(chatOff, 'roverchat off received');
      r.pass('indicator lifecycle complete');
    });

    await r.test('rovers stood face to face while talking', async () => {
      r.expect(frozenGap !== null, 'had positions for both talkers');
      r.expect(
        frozenGap! > 0.5 && frozenGap! < 3.0,
        `gap ${frozenGap?.toFixed(2)}u is conversational (want ~1.5)`,
      );
      r.pass(`gap ${frozenGap!.toFixed(2)}u`);
    });

    await r.test('no conversation text ever crossed the wire', async () => {
      const leaks = frames.filter((f) => f.includes('mockline'));
      r.expect(leaks.length === 0, `no frame contains transcript text (got ${leaks.length})`);
      const chatFrames = frames.filter((f) => JSON.parse(f).t === 'chat');
      r.expect(chatFrames.length === 0, 'no chat messages broadcast at all');
      r.pass(`${frames.length} frames sniffed, zero leaks`);
    });

    await r.test('transcript persisted privately in the db', async () => {
      const db = new Database(DB_PATH, { readonly: true });
      const row = db
        .prepare("SELECT * FROM handshakes WHERE status = 'done' ORDER BY id LIMIT 1")
        .get() as { transcript: string; rover_a: number; rover_b: number } | undefined;
      db.close();
      r.expect(!!row, 'a done handshake row exists');
      const transcript = JSON.parse(row!.transcript) as Array<{ speaker: string; text: string }>;
      r.expect(transcript.length === 6, `6 turns recorded (got ${transcript.length})`);
      const order = transcript.map((line) => line.speaker).join('');
      r.expect(order === 'ababab', `turns alternate a/b (got ${order})`);
      r.expect(
        transcript.every((line) => line.text.length > 0 && line.text.length <= 240),
        'every line non-empty and capped',
      );
      r.pass('transcript complete and well-formed');
    });

    ws.close();
  } catch (e) {
    console.error('fatal:', e);
    console.error('server log tail:', log.slice(-10).join(''));
    server.kill();
    process.exit(1);
  }

  server.kill();
  process.exit(r.summary() ? 0 : 1);
}

main();
