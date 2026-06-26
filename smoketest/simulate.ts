// simulation smoke test. spawns a server with dev tools + mock llm (NO
// test-live), seeds 3 synthetic rovers via the dev api, then:
//   - confirms test rovers stay OUT of the live world (the cost firewall)
//   - runs a batch simulation and checks the report: handshakes ran, every
//     conversation produced a 6-line transcript, tokens were counted
//   - runs again with a tiny token budget and checks it stops early

import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WebSocket } from 'ws';
import { makeRunner, sleep } from './helpers';

const PORT = 8093;
const BASE = `http://localhost:${PORT}`;

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function startServer(): ChildProcess {
  const dir = mkdtempSync(join(tmpdir(), 'freeknet-smoke-'));
  return spawn('npx', ['tsx', 'server.ts'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      FREEKNET_DB: join(dir, 'test.db'),
      FREEKNET_LLM_MOCK: '1',
      FREEKNET_DEV_TOOLS: '1',
      // note: FREEKNET_TEST_LIVE is intentionally unset
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error('server did not come up');
}

async function seedTestRovers(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const created = await fetch(`${BASE}/api/dev/testers`, { method: 'POST' });
    const { id } = (await created.json()) as { id: number };
    await fetch(`${BASE}/api/dev/testers/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ drawing: TINY_PNG, personality: `test subject ${i}`, active: true }),
    });
  }
}

interface SimReport {
  candidates: number;
  pairsRun: number;
  turnsTotal: number;
  totalTokens: number;
  stoppedEarly: boolean;
  conversations: Array<{ status: string; turns: number; transcript: unknown[] }>;
}

async function simulate(body: Record<string, unknown>): Promise<SimReport> {
  const res = await fetch(`${BASE}/api/dev/simulate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as SimReport;
}

async function main(): Promise<void> {
  const r = makeRunner();
  const server = startServer();
  const log: string[] = [];
  server.stdout?.on('data', (d) => log.push(String(d)));
  server.stderr?.on('data', (d) => log.push(String(d)));

  try {
    await waitForServer();
    await seedTestRovers(3);

    await r.test('test rovers stay out of the live world', async () => {
      let snapshot: Array<{ rover?: boolean }> = [];
      const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('join timed out')), 5000);
        ws.on('message', (raw) => {
          const msg = JSON.parse(raw.toString());
          if (msg.t === 'welcome') ws.send(JSON.stringify({ t: 'join', drawing: TINY_PNG }));
          else if (msg.t === 'snapshot') {
            snapshot = msg.players;
            clearTimeout(timer);
            resolve();
          }
        });
        ws.on('error', reject);
      });
      ws.close();
      const rovers = snapshot.filter((p) => p.rover);
      r.expect(rovers.length === 0, `no test rovers spawned live (got ${rovers.length})`);
      r.pass('firewall holds: synthetic rovers absent from the world');
    });

    await r.test('a batch run produces transcripts and counts tokens', async () => {
      const rep = await simulate({ pairs: 3 });
      r.expect(rep.candidates === 3, `3 candidates (got ${rep.candidates})`);
      r.expect(rep.pairsRun === 3, `3 handshakes ran (got ${rep.pairsRun})`);
      r.expect(rep.turnsTotal === 18, `6 turns x 3 pairs = 18 (got ${rep.turnsTotal})`);
      r.expect(rep.totalTokens > 0, `tokens counted (got ${rep.totalTokens})`);
      r.expect(
        rep.conversations.every((c) => c.status === 'done' && c.transcript.length === 6),
        'every conversation completed with a 6-line transcript',
      );
      r.pass(`${rep.pairsRun} handshakes, ${rep.totalTokens} tokens`);
    });

    await r.test('a tiny token budget stops the run early', async () => {
      // concurrency 1 so the budget is checked between each launch (with higher
      // concurrency up to concurrency-1 conversations can overshoot the cap).
      const rep = await simulate({ pairs: 3, tokenBudget: 1, concurrency: 1 });
      r.expect(rep.stoppedEarly, 'run flagged stoppedEarly');
      r.expect(rep.pairsRun === 1, `stopped after the first pair (got ${rep.pairsRun})`);
      r.pass(`budget honored: ${rep.pairsRun} pair before stopping`);
    });
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
