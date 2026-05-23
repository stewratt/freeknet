import * as THREE from 'three';
import { createAvatarFromCanvas, updateWalkDeformation } from './avatar.js';

const MOVE_SPEED = 4.5;
const GRAVITY = -22;
const JUMP_VELOCITY = 7.5;
const PLAYER_RADIUS = 0.45;
const PLAYER_HEIGHT = 1.8;
const STEP_SLOP = 0.05;

const BOW_DURATION = 1.4;
const BOW_MAX_ANGLE = Math.PI * 0.47; // ~85deg, slightly less than 90

function bowAngleAt(t) {
  if (t < 0.35) return BOW_MAX_ANGLE * (t / 0.35);
  if (t < 0.9) return BOW_MAX_ANGLE;
  if (t < BOW_DURATION) return BOW_MAX_ANGLE * (1 - (t - 0.9) / 0.5);
  return 0;
}

function resolveHorizontalAxis(newVal, axis, otherAxisPos, colliders, feetY, headY) {
  for (const c of colliders) {
    const boxBottom = c.y - c.sy / 2;
    const boxTop = c.y + c.sy / 2;
    if (headY <= boxBottom + 0.01) continue;
    if (feetY >= boxTop - STEP_SLOP) continue;
    const halfX = c.sx / 2 + PLAYER_RADIUS;
    const halfZ = c.sz / 2 + PLAYER_RADIUS;
    if (axis === 'x') {
      if (Math.abs(otherAxisPos - c.z) >= halfZ) continue;
      if (Math.abs(newVal - c.x) >= halfX) continue;
      newVal = newVal > c.x ? c.x + halfX : c.x - halfX;
    } else {
      if (Math.abs(otherAxisPos - c.x) >= halfX) continue;
      if (Math.abs(newVal - c.z) >= halfZ) continue;
      newVal = newVal > c.z ? c.z + halfZ : c.z - halfZ;
    }
  }
  return newVal;
}

function highestSupportY(x, z, colliders) {
  let supportY = 0;
  for (const c of colliders) {
    const halfX = c.sx / 2 + PLAYER_RADIUS;
    const halfZ = c.sz / 2 + PLAYER_RADIUS;
    if (Math.abs(x - c.x) >= halfX) continue;
    if (Math.abs(z - c.z) >= halfZ) continue;
    const top = c.y + c.sy / 2;
    if (top > supportY) supportY = top;
  }
  return supportY;
}

export class LocalPlayer {
  constructor(drawingCanvas) {
    this.group = new THREE.Group();
    this.avatar = createAvatarFromCanvas(drawingCanvas);
    this.group.add(this.avatar);

    this.position = new THREE.Vector3(0, 0, 0);
    this.velocity = new THREE.Vector3();
    this.velocityY = 0;
    this.onGround = true;
    this.speed = 0;

    this.dance = false;
    this.bowTime = 0;
  }

  startBow() {
    this.bowTime = 0.0001; // any positive value starts the animation
  }

  toggleDance() {
    this.dance = !this.dance;
    return this.dance;
  }

  update(dt, input, cameraYaw, colliders = []) {
    let fx = input.mx || 0;
    let fz = input.mz || 0;

    const len = Math.hypot(fx, fz);
    if (len > 1) { fx /= len; fz /= len; }

    const cy = Math.cos(cameraYaw);
    const sy = Math.sin(cameraYaw);
    const worldX = fx * cy + fz * sy;
    const worldZ = -fx * sy + fz * cy;

    const vx = worldX * MOVE_SPEED;
    const vz = worldZ * MOVE_SPEED;

    const feetY = this.position.y;
    const headY = this.position.y + PLAYER_HEIGHT;

    let newX = this.position.x + vx * dt;
    newX = resolveHorizontalAxis(newX, 'x', this.position.z, colliders, feetY, headY);
    this.position.x = newX;

    let newZ = this.position.z + vz * dt;
    newZ = resolveHorizontalAxis(newZ, 'z', this.position.x, colliders, feetY, headY);
    this.position.z = newZ;

    this.velocity.set(vx, 0, vz);

    if (input.jump) {
      input.jump = false;
      if (this.onGround) {
        this.velocityY = JUMP_VELOCITY;
        this.onGround = false;
      }
    }

    this.velocityY += GRAVITY * dt;
    let newY = this.position.y + this.velocityY * dt;

    const support = highestSupportY(this.position.x, this.position.z, colliders);
    if (newY <= support) {
      newY = support;
      this.velocityY = 0;
      this.onGround = true;
    } else {
      this.onGround = false;
    }
    this.position.y = newY;

    this.group.position.copy(this.position);

    this.speed = this.velocity.length();
    const animSpeed = this.dance ? MOVE_SPEED : this.speed;
    updateWalkDeformation(this.avatar, animSpeed / MOVE_SPEED, dt);

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

  billboardTo(cameraPos) {
    this.avatar.rotation.y = Math.atan2(
      cameraPos.x - this.position.x,
      cameraPos.z - this.position.z
    );
  }
}

export class RemotePlayer {
  constructor(initial) {
    this.id = initial.id;
    this.group = new THREE.Group();
    this.avatar = null;
    this.position = new THREE.Vector3(initial.x ?? 0, initial.y ?? 0, initial.z ?? 0);
    this.group.position.copy(this.position);

    this.buffer = [{ t: performance.now() / 1000, x: this.position.x, y: this.position.y, z: this.position.z }];
    this.renderDelay = 0.12;
    this.lastSpeed = 0;

    this.dance = !!initial.dance;
    this.bowTime = 0;
  }

  setAvatar(mesh) {
    this.avatar = mesh;
    this.group.add(mesh);
  }

  startBow() {
    this.bowTime = 0.0001;
  }

  setDance(on) {
    this.dance = !!on;
  }

  pushUpdate(x, y, z) {
    const now = performance.now() / 1000;
    this.buffer.push({ t: now, x, y, z });
    if (this.buffer.length > 20) this.buffer.shift();
  }

  update(dt, cameraPos) {
    const target = performance.now() / 1000 - this.renderDelay;
    let a = this.buffer[0], b = this.buffer[this.buffer.length - 1];
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
    const speed = Math.hypot(dx, dz) / Math.max(dt, 1e-4);
    this.lastSpeed = speed;

    this.position.set(nx, ny, nz);
    this.group.position.copy(this.position);

    if (this.avatar) {
      const animSpeed = this.dance ? 4.5 : speed;
      const speedNorm = Math.min(animSpeed / 4.5, 1);
      updateWalkDeformation(this.avatar, speedNorm, dt);
      this.avatar.rotation.y = Math.atan2(
        cameraPos.x - this.position.x,
        cameraPos.z - this.position.z
      );

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
