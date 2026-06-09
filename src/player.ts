import * as THREE from 'three';
import { NoneFlag, type Body, type World } from '@perplexdotgg/bounce';
import CharacterController from '@perplexdotgg/bounce-character-controller';
import { createAvatarFromCanvas, updateWalkDeformation, type AvatarMesh } from './avatar';
import type { InputState } from './controls';
import type { SnapshotPlayer, JoinBroadcastMsg } from './protocol';

const MOVE_SPEED = 4.5;
const JUMP_SPEED = 7.5;
const PLAYER_RADIUS = 0.4;
const PLAYER_HEIGHT = 0.9;
// total capsule height = PLAYER_HEIGHT + 2 * PLAYER_RADIUS = 1.7 units

const BOW_DURATION = 1.4;
const BOW_MAX_ANGLE = Math.PI * 0.47; // ~85deg, slightly less than 90

function bowAngleAt(t: number): number {
  if (t < 0.35) return BOW_MAX_ANGLE * (t / 0.35);
  if (t < 0.9) return BOW_MAX_ANGLE;
  if (t < BOW_DURATION) return BOW_MAX_ANGLE * (1 - (t - 0.9) / 0.5);
  return 0;
}

export class LocalPlayer {
  readonly group = new THREE.Group();
  readonly avatar: AvatarMesh;
  /** Mirrors the bounce body's position each frame. Read by the camera, chat
   *  bubble positions, and the network sendMove. Always kept in sync with
   *  `body.position` so other code doesn't need to know about bounce. */
  readonly position = new THREE.Vector3(0, 0, 0);
  /** Horizontal-only velocity for the walk deformer (y motion shouldn't
   *  trigger walk animation). */
  readonly velocity = new THREE.Vector3();
  speed = 0;
  dance = false;
  bowTime = 0;

  private readonly body: Body;
  private readonly controller: CharacterController;

  constructor(drawingCanvas: HTMLCanvasElement, physicsWorld: World) {
    this.avatar = createAvatarFromCanvas(drawingCanvas);
    this.group.add(this.avatar);

    this.controller = new CharacterController(physicsWorld, {
      walkingSpeed: MOVE_SPEED,
      jumpingSpeed: JUMP_SPEED,
      gravityScale: 1,
      gravity: { x: 0, y: -22, z: 0 },
      canControlMovementDuringJump: true,
      shouldCharacterStickToFloor: true,
      // air-control feel: a higher inertia-decay rate means the player
      // changes direction faster, which suits a top-down/orbit camera.
      inertiaDecayRate: 30,
    });

    // bounce convention: body.position is the capsule's CENTER. our rest-
    // of-codebase convention is that LocalPlayer.position.y === 0 means
    // feet on the ground. we translate between the two in update(): mirror
    // `body.position - halfCapsuleHeight` into our position. spawn the body
    // with its center at halfCapsuleHeight so initial feet are at y=0.
    const shape = physicsWorld.createCapsule({
      radius: PLAYER_RADIUS,
      height: PLAYER_HEIGHT,
    });

    // kinematic body in no collision groups — the controller does its own
    // shape-casts against the world rather than relying on broad-phase
    // collisions, so NoneFlag is correct here.
    this.body = physicsWorld.createKinematicBody({
      shape,
      position: [0, PLAYER_RADIUS + PLAYER_HEIGHT / 2, 0],
      orientation: [0, 0, 0],
      belongsToGroups: NoneFlag,
      collidesWithGroups: NoneFlag,
    });
    this.controller.setBody(this.body);
  }

  /** Move the player to a server-assigned spawn point (from the `welcome`
   *  message) before play begins. Repositions the underlying bounce body —
   *  its position is the capsule center, so we lift by halfCapsuleHeight to
   *  keep feet on the ground — and mirrors into the THREE position the camera
   *  reads. Safe to call once right after construction. */
  setSpawn(x: number, z: number): void {
    const halfCapsuleHeight = PLAYER_RADIUS + PLAYER_HEIGHT / 2;
    // the controller tracks its own center position and writes it back to the
    // body every update(), so moving only the body gets clobbered on the next
    // frame. teleport the controller's position too (it's the capsule center).
    this.controller.position.set([x, halfCapsuleHeight, z]);
    this.body.position.set([x, halfCapsuleHeight, z]);
    this.body.commitChanges();
    this.position.set(x, 0, z);
    this.group.position.copy(this.position);
  }

  startBow(): void {
    this.bowTime = 0.0001; // any positive value starts the animation
  }

  toggleDance(): boolean {
    this.dance = !this.dance;
    return this.dance;
  }

  /**
   * Step the local player physics for one frame.
   *
   * `colliders` used to be a list of AABBs we hand-resolved against. With
   * bounce it's redundant — the static stage bodies are registered into the
   * same physics world and the character controller queries them itself.
   * The parameter is kept (and ignored) for back-compat with the call site
   * in game.ts; will be cleaned up in a follow-up.
   */
  update(dt: number, input: InputState, cameraYaw: number, _colliders: unknown = null): void {
    let fx = input.mx || 0;
    let fz = input.mz || 0;
    const len = Math.hypot(fx, fz);
    if (len > 1) {
      fx /= len;
      fz /= len;
    }

    // rotate input from camera-relative to world-relative. (fz=-1 = forward
    // in the camera frame, which becomes movement toward the camera's facing.)
    const cy = Math.cos(cameraYaw);
    const sy = Math.sin(cameraYaw);
    const worldX = fx * cy + fz * sy;
    const worldZ = -fx * sy + fz * cy;

    // the controller's setTargetMovement wants a normalized direction (it
    // applies its own walkingSpeed). edge-trigger the jump like before.
    const jump = !!input.jump;
    if (input.jump) input.jump = false;
    this.controller.setTargetMovement(worldX, worldZ, jump);
    this.controller.update(dt);

    // mirror the body's resolved position to the THREE.Vector3 the rest of
    // the code reads from. body.position is the capsule center; subtract
    // halfCapsuleHeight so position.y is "feet on the ground" by the rest of
    // the codebase's convention.
    const bp = this.body.position;
    const halfCapsuleHeight = PLAYER_RADIUS + PLAYER_HEIGHT / 2;
    this.position.set(bp.x, bp.y - halfCapsuleHeight, bp.z);
    this.group.position.copy(this.position);

    // horizontal velocity for the walk deformer (y bobs from jumping
    // shouldn't drive the walk cycle).
    this.velocity.set(worldX * MOVE_SPEED, 0, worldZ * MOVE_SPEED);
    this.speed = this.velocity.length();
    const animSpeed = this.dance ? MOVE_SPEED : this.speed;
    updateWalkDeformation(this.avatar, animSpeed / MOVE_SPEED, dt, 0);

    if (this.bowTime > 0) {
      this.bowTime += dt;
      if (this.bowTime >= BOW_DURATION) {
        this.bowTime = 0;
        this.avatar.rotation.x = 0;
      } else {
        this.avatar.rotation.x = bowAngleAt(this.bowTime);
      }
    } else {
      this.avatar.rotation.x = 0;
    }
  }

  billboardTo(cameraPos: THREE.Vector3): void {
    this.avatar.rotation.y = Math.atan2(
      cameraPos.x - this.position.x,
      cameraPos.z - this.position.z,
    );
  }
}

interface InterpSample {
  t: number;
  x: number;
  y: number;
  z: number;
}

type RemoteInit = SnapshotPlayer | JoinBroadcastMsg;

export class RemotePlayer {
  readonly id: string;
  readonly group = new THREE.Group();
  avatar: AvatarMesh | null = null;
  readonly position: THREE.Vector3;
  private readonly buffer: InterpSample[];
  private readonly renderDelay = 0.12;
  lastSpeed = 0;
  dance: boolean;
  bowTime = 0;

  constructor(initial: RemoteInit) {
    this.id = initial.id;
    this.position = new THREE.Vector3(initial.x ?? 0, initial.y ?? 0, initial.z ?? 0);
    this.group.position.copy(this.position);
    this.buffer = [
      {
        t: performance.now() / 1000,
        x: this.position.x,
        y: this.position.y,
        z: this.position.z,
      },
    ];
    this.dance = !!initial.dance;
  }

  setAvatar(mesh: AvatarMesh): void {
    this.avatar = mesh;
    this.group.add(mesh);
  }

  startBow(): void {
    this.bowTime = 0.0001;
  }

  setDance(on: boolean): void {
    this.dance = !!on;
  }

  pushUpdate(x: number, y: number, z: number): void {
    const now = performance.now() / 1000;
    this.buffer.push({ t: now, x, y: y ?? 0, z });
    if (this.buffer.length > 20) this.buffer.shift();
  }

  update(dt: number, cameraPos: THREE.Vector3): void {
    const target = performance.now() / 1000 - this.renderDelay;
    let a = this.buffer[0],
      b = this.buffer[this.buffer.length - 1];
    for (let i = 0; i < this.buffer.length - 1; i++) {
      if (this.buffer[i].t <= target && this.buffer[i + 1].t >= target) {
        a = this.buffer[i];
        b = this.buffer[i + 1];
        break;
      }
    }
    let alpha = 1;
    if (b.t > a.t) alpha = (target - a.t) / (b.t - a.t);
    alpha = Math.max(0, Math.min(1, alpha));
    const nx = a.x + (b.x - a.x) * alpha;
    const ny = (a.y ?? 0) + ((b.y ?? 0) - (a.y ?? 0)) * alpha;
    const nz = a.z + (b.z - a.z) * alpha;

    const dx = nx - this.position.x;
    const dz = nz - this.position.z;
    // horizontal speed only — y bobbing should not trigger walk deformation.
    // clamp sub-mm jitter to 0 so a held-still player doesn't sway from
    // interp noise.
    let speed = Math.hypot(dx, dz) / Math.max(dt, 1e-4);
    if (speed < 0.05) speed = 0;
    this.lastSpeed = speed;

    this.position.set(nx, ny, nz);
    this.group.position.copy(this.position);

    if (this.avatar) {
      const animSpeed = this.dance ? 4.5 : speed;
      const speedNorm = Math.min(animSpeed / 4.5, 1);
      const dxc = cameraPos.x - this.position.x;
      const dzc = cameraPos.z - this.position.z;
      const cameraDistance = Math.hypot(dxc, dzc);
      updateWalkDeformation(this.avatar, speedNorm, dt, cameraDistance);
      this.avatar.rotation.y = Math.atan2(dxc, dzc);

      if (this.bowTime > 0) {
        this.bowTime += dt;
        if (this.bowTime >= BOW_DURATION) {
          this.bowTime = 0;
          this.avatar.rotation.x = 0;
        } else {
          this.avatar.rotation.x = bowAngleAt(this.bowTime);
        }
      } else {
        this.avatar.rotation.x = 0;
      }
    }
  }
}
