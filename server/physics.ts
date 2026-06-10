// per-instance world physics (bounce-driven).
//
// the ball's collision response, gravity, friction, and restitution are
// owned by @perplexdotgg/bounce. we still own player↔ball kick detection
// (a velocity-based reach test) and we still apply our own sleep + broadcast
// throttling on top, because the on-the-wire protocol is { x, y, z, vx, vy,
// vz } at ~20Hz and we don't want to send updates when the ball is at rest.
//
// each instance gets its own World + ball via createInstancePhysics(); the
// constants are shared. the COLLIDERS array is the single source of truth
// for world geometry — the client constructs visually-equivalent boxes from
// src/stage.ts; both must agree on position + size.

import { World, Vec3, type Body } from '@perplexdotgg/bounce';
import type { BallMsg } from '../src/protocol';

export interface Collider {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
}

export const COLLIDERS: Collider[] = [
  { x: 12.5, y: 0.35, z: 0, sx: 6, sy: 0.7, sz: 5 }, // stage
];

export const BALL_RADIUS = 0.25;
export const BALL_MASS = 0.5;
export const PLAYER_RADIUS = 0.45;
export const PLAYER_HEIGHT = 1.8;
export const BALL_SPAWN = { x: -5, y: BALL_RADIUS + 0.5, z: 0 };
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

const BALL_BROADCAST_MS = 50;

interface KickerPos {
  x: number;
  y: number;
  z: number;
}

export interface InstancePhysics {
  serialize(): BallMsg;
  tryKick(p: KickerPos, oldX: number, oldZ: number, dt: number): void;
  /** step the world; returns a BallMsg when a broadcast is due, else null. */
  step(dt: number, now: number): BallMsg | null;
}

export function createInstancePhysics(): InstancePhysics {
  const world = new World({
    gravity: [0, WORLD_GRAVITY, 0],
    timeStepSizeSeconds: 1 / 60,
  });

  // add static colliders (the stage, etc.). high friction on the ground +
  // stage so the ball doesn't keep rolling forever the way it does with
  // bounce's default Coulomb friction.
  for (const c of COLLIDERS) {
    const shape = world.createBox({ width: c.sx, height: c.sy, depth: c.sz });
    world.createStaticBody({
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
    const groundShape = world.createBox({ width: 200, height: 1, depth: 200 });
    world.createStaticBody({
      shape: groundShape,
      position: [0, -0.5, 0],
      friction: 0.95,
      restitution: 0.4,
    });
  }

  const ballShape = world.createSphere({ radius: BALL_RADIUS });
  const ball: Body = world.createDynamicBody({
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
  let dirty = true;
  let restAccum = 0;
  let lastBroadcast = 0;

  function serialize(): BallMsg {
    return {
      t: 'ball',
      x: ball.position.x,
      y: ball.position.y,
      z: ball.position.z,
      vx: ball.linearVelocity.x,
      vy: ball.linearVelocity.y,
      vz: ball.linearVelocity.z,
    };
  }

  function respawnIfStrayed(): void {
    const p = ball.position;
    if (p.y < -5 || Math.abs(p.x) > 80 || Math.abs(p.z) > 80) {
      ball.position.set([BALL_SPAWN.x, BALL_SPAWN.y, BALL_SPAWN.z]);
      ball.linearVelocity.set([0, 0, 0]);
      ball.angularVelocity.set([0, 0, 0]);
      ball.commitChanges();
      dirty = true;
      restAccum = 0;
    }
  }

  function tryKick(p: KickerPos, oldX: number, oldZ: number, dt: number): void {
    const ballPos = ball.position;
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
        ball.position.set([ballPos.x + nrx * pen, ballPos.y, ballPos.z + nrz * pen]);
        ball.commitChanges();
        dirty = true;
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
    ball.applyLinearImpulse(new Vec3([ix, iy, iz]));
    dirty = true;
    restAccum = 0;
  }

  function step(dt: number, now: number): BallMsg | null {
    world.takeOneStep(dt);

    // low-speed cutoff: bounce decays smoothly toward zero but the ball will
    // coast at 0.1 m/s for a long time before truly stopping, which doesn't
    // feel right. snap velocity to zero below a threshold (matches the old
    // `if Math.abs(ball.vx) < 0.04 then 0` cutoffs).
    const v = ball.linearVelocity;
    const av = ball.angularVelocity;
    let touched = false;
    if (Math.abs(v.x) < 0.15) {
      v.x = 0;
      touched = true;
    }
    if (Math.abs(v.z) < 0.15) {
      v.z = 0;
      touched = true;
    }
    if (Math.abs(v.y) < 0.15 && ball.position.y <= BALL_RADIUS + 0.05) {
      v.y = 0;
      touched = true;
    }
    // dampen residual spin too once linear motion is dead
    if (touched && v.x === 0 && v.z === 0 && v.y === 0) {
      av.x = av.y = av.z = 0;
    }
    if (touched) ball.commitChanges();

    // update dirty + rest tracking from the body's velocity. bounce has its
    // own sleeping but the on-the-wire protocol still wants us to throttle.
    const speed2 = v.x * v.x + v.y * v.y + v.z * v.z;
    if (speed2 < REST_SPEED2) {
      restAccum += dt;
    } else {
      restAccum = 0;
      dirty = true;
    }

    respawnIfStrayed();

    if (dirty && now - lastBroadcast >= BALL_BROADCAST_MS) {
      lastBroadcast = now;
      if (restAccum > 0.3) dirty = false;
      return serialize();
    }
    return null;
  }

  return { serialize, tryKick, step };
}
