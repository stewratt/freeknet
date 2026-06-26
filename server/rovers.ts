// rovers: server-driven npc agents, one per account. each active rover is an
// Occupant with no websocket, wandering its instance on a simple state
// machine: idle a few seconds → pick a waypoint → walk there → idle. rovers
// stay on flat ground (y=0, waypoints rejected inside collider footprints) so
// they need no physics. they never chat and never kick the ball — the
// player-facing interaction layer is the once-a-day rover↔rover handshake.

import type { Occupant, Instance, InstanceManager } from './instances';
import { COLLIDERS } from './physics';
import * as dbq from './db';
import type { RoverRow } from './db';

const WANDER_TICK_MS = 100; // 10 Hz
const WALK_SPEED = 1.5; // u/s — ambient, vs the player's 4.5
const UPDATE_INTERVAL_MS = 200; // ≤5 Hz on the wire; client interp smooths it
const WANDER_RADIUS = 30;
const WORLD_CLAMP = 35;
const ARRIVE_DIST = 0.3;
const COLLIDER_PAD = 0.6;

export type RoverPhase = 'idle' | 'walk' | 'handshake';

export interface RoverState {
  userId: number;
  occ: Occupant;
  phase: RoverPhase;
  idleUntil: number;
  target: { x: number; z: number } | null;
  lastUpdateSent: number;
  // set while a handshake conversation owns this rover (M5)
  busy: boolean;
}

function insideCollider(x: number, z: number): boolean {
  for (const c of COLLIDERS) {
    if (
      Math.abs(x - c.x) < c.sx / 2 + COLLIDER_PAD &&
      Math.abs(z - c.z) < c.sz / 2 + COLLIDER_PAD
    ) {
      return true;
    }
  }
  return false;
}

function randomPoint(radius: number): { x: number; z: number } {
  for (let i = 0; i < 20; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * radius;
    const x = Math.max(-WORLD_CLAMP, Math.min(WORLD_CLAMP, Math.cos(a) * r));
    const z = Math.max(-WORLD_CLAMP, Math.min(WORLD_CLAMP, Math.sin(a) * r));
    if (!insideCollider(x, z)) return { x, z };
  }
  return { x: 0, z: 0 };
}

export class RoverManager {
  readonly rovers = new Map<number, RoverState>(); // by owning user id
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private lastTick = Date.now();

  constructor(private readonly instances: InstanceManager) {}

  start(): void {
    for (const row of dbq.listActiveRovers()) this.spawn(row);
    this.lastTick = Date.now();
    this.tickTimer = setInterval(() => this.tick(), WANDER_TICK_MS);
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
  }

  get(userId: number): RoverState | undefined {
    return this.rovers.get(userId);
  }

  /** called by the REST layer whenever a rover row changes. */
  onRoverChanged(userId: number): void {
    const row = dbq.getRover(userId);
    const live = this.rovers.get(userId);
    // synthetic test rovers stay out of the live world unless explicitly opted
    // in — keeps the cost firewall and the world identical in production.
    const user = dbq.getUserById(userId);
    const allowed = !user?.is_test || process.env.FREEKNET_TEST_LIVE === '1';
    const shouldRun = !!row && !!row.active && !!row.drawing && allowed;
    if (!shouldRun) {
      if (live) this.despawn(userId);
      return;
    }
    if (live) {
      if (live.occ.drawing === row!.drawing) return; // text-only edit; nothing in-world changes
      this.despawn(userId); // drawing changed: rejoin so clients rebuild the avatar
    }
    this.spawn(row!);
  }

  spawn(row: RoverRow): void {
    if (this.rovers.has(row.user_id) || !row.drawing) return;
    const { x, z } = randomPoint(15);
    const occ = this.instances.add({
      id: `rover-${row.user_id}`,
      kind: 'rover',
      drawing: row.drawing,
      bot: false,
      x,
      y: 0,
      z,
      rotY: Math.random() * Math.PI * 2,
      dance: false,
      lastMoveAt: Date.now(),
      roverUserId: row.user_id,
    });
    const state: RoverState = {
      userId: row.user_id,
      occ,
      phase: 'idle',
      idleUntil: Date.now() + 1000 + Math.random() * 4000,
      target: null,
      lastUpdateSent: 0,
      busy: false,
    };
    this.rovers.set(row.user_id, state);
    occ.instance.broadcast(
      {
        t: 'join',
        id: occ.id,
        drawing: occ.drawing,
        x: occ.x,
        y: 0,
        z: occ.z,
        rotY: occ.rotY,
        dance: false,
        bot: false,
        rover: true,
      },
      occ.id,
    );
    occ.instance.maybeBroadcastPresence();
  }

  despawn(userId: number): void {
    const state = this.rovers.get(userId);
    if (!state) return;
    this.rovers.delete(userId);
    const inst = state.occ.instance;
    this.instances.remove(state.occ);
    inst.broadcast({ t: 'leave', id: state.occ.id });
    inst.maybeBroadcastPresence();
  }

  /** move a rover to another instance (used by handshake pairing). */
  migrate(state: RoverState, dest: Instance): void {
    const from = state.occ.instance;
    if (from === dest) return;
    this.instances.remove(state.occ);
    from.broadcast({ t: 'leave', id: state.occ.id });
    from.maybeBroadcastPresence();
    const { x, z } = randomPoint(15);
    state.occ.x = x;
    state.occ.z = z;
    this.instances.add(state.occ, dest);
    dest.broadcast(
      {
        t: 'join',
        id: state.occ.id,
        drawing: state.occ.drawing,
        x,
        y: 0,
        z,
        rotY: state.occ.rotY,
        dance: false,
        bot: false,
        rover: true,
      },
      state.occ.id,
    );
    dest.maybeBroadcastPresence();
  }

  /** steer toward a point; used by both wandering and handshake approach. */
  private stepToward(state: RoverState, tx: number, tz: number, dt: number, now: number): boolean {
    const occ = state.occ;
    const dx = tx - occ.x;
    const dz = tz - occ.z;
    const dist = Math.hypot(dx, dz);
    if (dist < ARRIVE_DIST) return true;
    const step = Math.min(dist, WALK_SPEED * dt);
    occ.x += (dx / dist) * step;
    occ.z += (dz / dist) * step;
    occ.rotY = Math.atan2(dx, dz);
    occ.lastMoveAt = now;
    if (now - state.lastUpdateSent >= UPDATE_INTERVAL_MS) {
      state.lastUpdateSent = now;
      occ.instance.broadcast({ t: 'update', id: occ.id, x: occ.x, y: 0, z: occ.z, rotY: occ.rotY });
    }
    return false;
  }

  private tick(): void {
    const now = Date.now();
    const dt = Math.min(0.5, (now - this.lastTick) / 1000);
    this.lastTick = now;

    for (const state of this.rovers.values()) {
      if (state.busy) continue; // handshake engine is driving this rover
      switch (state.phase) {
        case 'idle':
          if (now >= state.idleUntil) {
            state.target = randomPoint(WANDER_RADIUS);
            state.phase = 'walk';
          }
          break;
        case 'walk': {
          const t = state.target;
          if (!t || this.stepToward(state, t.x, t.z, dt, now)) {
            // flush the final position so clients don't interpolate short
            state.occ.instance.broadcast({
              t: 'update',
              id: state.occ.id,
              x: state.occ.x,
              y: 0,
              z: state.occ.z,
              rotY: state.occ.rotY,
            });
            state.target = null;
            state.phase = 'idle';
            state.idleUntil = now + 3000 + Math.random() * 7000;
          }
          break;
        }
        case 'handshake':
          // positioning during handshakes is driven by the engine via
          // approachStep(); nothing to do on the wander tick.
          break;
      }
    }
  }

  /**
   * handshake helper: walk toward a meeting point for up to `deadline`;
   * returns true once arrived (or snapped after the deadline).
   */
  approachStep(state: RoverState, tx: number, tz: number, deadline: number): boolean {
    const now = Date.now();
    const dt = WANDER_TICK_MS / 1000;
    if (now > deadline) {
      state.occ.x = tx;
      state.occ.z = tz;
      state.occ.instance.broadcast({
        t: 'update',
        id: state.occ.id,
        x: tx,
        y: 0,
        z: tz,
        rotY: state.occ.rotY,
      });
      return true;
    }
    return this.stepToward(state, tx, tz, dt, now);
  }

  /** handshake helper: face a partner and stand still. */
  facePartner(state: RoverState, other: RoverState): void {
    const occ = state.occ;
    occ.rotY = Math.atan2(other.occ.x - occ.x, other.occ.z - occ.z);
    occ.instance.broadcast({
      t: 'update',
      id: occ.id,
      x: occ.x,
      y: 0,
      z: occ.z,
      rotY: occ.rotY,
    });
  }
}
