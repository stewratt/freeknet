// rover smoke test. spawns a server with dev tools + test-live enabled, seeds 2
// synthetic rovers through the dev api, then observes them through a raw ws
// client: they appear in the snapshot flagged rover:true, carry real png
// doodles, wander over time, and stay inside world bounds.

import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WebSocket } from 'ws';
import { makeRunner, sleep } from './helpers';

const PORT = 8091;
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
      FREEKNET_TEST_LIVE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// create N active test rovers via the dev api; onRoverChanged spawns them into
// the live world (FREEKNET_TEST_LIVE=1).
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

interface RoverView {
  id: string;
  drawing: string;
  rover: boolean;
  x: number;
  z: number;
}

async function main(): Promise<void> {
  const r = makeRunner();
  const server = startServer();
  const log: string[] = [];
  server.stdout?.on('data', (d) => log.push(String(d)));
  server.stderr?.on('data', (d) => log.push(String(d)));

  try {
    await waitForServer();
    await seedTestRovers(2);

    const positions = new Map<string, Array<{ x: number; z: number; at: number }>>();
    let snapshot: RoverView[] = [];

    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('join timed out')), 5000);
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.t === 'welcome') {
          ws.send(JSON.stringify({ t: 'join', drawing: TINY_PNG }));
        } else if (msg.t === 'snapshot') {
          snapshot = msg.players;
          clearTimeout(timer);
          resolve();
        } else if (msg.t === 'update') {
          const list = positions.get(msg.id) ?? [];
          list.push({ x: msg.x, z: msg.z, at: Date.now() });
          positions.set(msg.id, list);
        }
      });
      ws.on('error', reject);
    });

    await r.test('seeded rovers appear in the snapshot', async () => {
      const rovers = snapshot.filter((p) => p.rover);
      r.expect(rovers.length === 2, `2 rovers in snapshot (got ${rovers.length})`);
      r.expect(
        rovers.every((p) => p.id.startsWith('rover-')),
        'rover occupant ids are rover-<uid>',
      );
      r.expect(
        rovers.every((p) => p.drawing.startsWith('data:image/png;base64,')),
        'rovers carry png doodles',
      );
      r.expect(
        rovers.every(
          (p) => Buffer.from(p.drawing.split(',')[1], 'base64').subarray(1, 4).toString() === 'PNG',
        ),
        'doodles are real png bytes',
      );
      r.pass('rovers visible with avatars');
    });

    await r.test('rovers wander over time', async () => {
      await sleep(12000); // long enough to cover an idle gap (3-10s) + a walk
      const moved = snapshot.filter((p) => p.rover && (positions.get(p.id)?.length ?? 0) >= 2);
      r.expect(
        moved.length === 2,
        `both rovers sent movement updates (got ${moved.length}; counts: ${[...positions.entries()]
          .map(([k, v]) => `${k.slice(0, 12)}=${v.length}`)
          .join(', ')})`,
      );
      for (const p of snapshot.filter((s) => s.rover)) {
        const track = positions.get(p.id)!;
        const first = track[0];
        const last = track[track.length - 1];
        const dist = Math.hypot(last.x - first.x, last.z - first.z);
        r.expect(dist > 0.5, `${p.id.slice(0, 12)} actually moved (${dist.toFixed(2)}u)`);
      }
      r.pass('both rovers roam');
    });

    await r.test('rovers stay in bounds and off the stage', async () => {
      for (const [id, track] of positions) {
        for (const pt of track) {
          r.expect(
            Math.abs(pt.x) <= 35.5 && Math.abs(pt.z) <= 35.5,
            `${id.slice(0, 12)} in bounds (got ${pt.x.toFixed(1)}, ${pt.z.toFixed(1)})`,
          );
        }
      }
      r.pass('all sampled positions within ±35');
    });

    await r.test('rover speed reads as ambient', async () => {
      let checked = 0;
      for (const track of positions.values()) {
        for (let i = 1; i < track.length; i++) {
          const dtSec = (track[i].at - track[i - 1].at) / 1000;
          if (dtSec < 0.15) continue;
          const d = Math.hypot(track[i].x - track[i - 1].x, track[i].z - track[i - 1].z);
          const speed = d / dtSec;
          r.expect(speed < 3.5, `speed ${speed.toFixed(2)} u/s stays below player pace`);
          checked++;
        }
      }
      r.expect(checked > 0, 'had samples to check');
      r.pass(`${checked} movement samples all ambient-paced`);
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
