// mmo-style instancing. each instance is a self-contained copy of the world:
// its own occupant map, its own ball physics, its own presence count. players
// and rovers fill the most-occupied instance with room (keeps worlds lively),
// overflowing into a fresh one at the cap. empty instances are destroyed.

import type { WebSocket } from 'ws';
import type { ServerMsg, SnapshotPlayer } from '../src/protocol';
import { createInstancePhysics, type InstancePhysics } from './physics';

export const INSTANCE_CAP = Math.max(2, Number(process.env.FREEKNET_INSTANCE_CAP ?? 40));

export interface Occupant {
  id: string;
  kind: 'human' | 'rover';
  ws?: WebSocket; // rovers are server-driven and have no socket
  drawing: string;
  bot: boolean;
  x: number;
  y: number;
  z: number;
  rotY: number;
  dance: boolean;
  lastMoveAt: number;
  roverUserId?: number;
  instance: Instance;
}

export class Instance {
  readonly id: string;
  readonly occupants = new Map<string, Occupant>();
  readonly physics: InstancePhysics = createInstancePhysics();
  private lastPresenceCount = -1;

  constructor(id: string) {
    this.id = id;
  }

  size(): number {
    return this.occupants.size;
  }

  humanCount(): number {
    let n = 0;
    for (const occ of this.occupants.values()) if (occ.kind === 'human') n++;
    return n;
  }

  roverCount(): number {
    return this.occupants.size - this.humanCount();
  }

  broadcast(msg: ServerMsg, exceptId: string | null = null): void {
    const json = JSON.stringify(msg);
    for (const [id, occ] of this.occupants) {
      if (id === exceptId) continue;
      if (occ.ws && occ.ws.readyState === 1) occ.ws.send(json);
    }
  }

  maybeBroadcastPresence(): void {
    const count = this.occupants.size;
    if (count === this.lastPresenceCount) return;
    this.lastPresenceCount = count;
    this.broadcast({ t: 'presence', count });
  }

  snapshotFor(exceptId: string): SnapshotPlayer[] {
    const snapshot: SnapshotPlayer[] = [];
    for (const [pid, other] of this.occupants) {
      if (pid === exceptId) continue;
      snapshot.push({
        id: pid,
        drawing: other.drawing,
        x: other.x,
        y: other.y,
        z: other.z,
        rotY: other.rotY,
        dance: !!other.dance,
        bot: !!other.bot,
        rover: other.kind === 'rover' || undefined,
      });
    }
    return snapshot;
  }
}

export class InstanceManager {
  readonly instances = new Map<string, Instance>();
  private nextId = 1;

  /** the most-occupied instance with room, or a fresh one. */
  assign(): Instance {
    let best: Instance | null = null;
    for (const inst of this.instances.values()) {
      if (inst.size() >= INSTANCE_CAP) continue;
      if (!best || inst.size() > best.size()) best = inst;
    }
    if (best) return best;
    const inst = new Instance(`inst-${this.nextId++}`);
    this.instances.set(inst.id, inst);
    return inst;
  }

  /** place an occupant in an instance (the given one, or best-fit). */
  add(occ: Omit<Occupant, 'instance'>, inst: Instance = this.assign()): Occupant {
    const full = occ as Occupant;
    full.instance = inst;
    inst.occupants.set(full.id, full);
    return full;
  }

  /** remove an occupant; destroys the instance if it empties. */
  remove(occ: Occupant): void {
    const inst = occ.instance;
    inst.occupants.delete(occ.id);
    if (inst.occupants.size === 0) this.instances.delete(inst.id);
  }

  stats(): { instances: Array<{ id: string; humans: number; rovers: number }> } {
    return {
      instances: [...this.instances.values()].map((inst) => ({
        id: inst.id,
        humans: inst.humanCount(),
        rovers: inst.roverCount(),
      })),
    };
  }
}
