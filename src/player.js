import * as THREE from 'three';
import { createAvatarFromCanvas, updateWalkDeformation } from './avatar.js';

const MOVE_SPEED = 4.5;

export class LocalPlayer {
  constructor(drawingCanvas) {
    this.group = new THREE.Group();
    this.avatar = createAvatarFromCanvas(drawingCanvas);
    this.group.add(this.avatar);

    this.position = new THREE.Vector3(0, 0, 0);
    this.velocity = new THREE.Vector3();
    this.speed = 0;
  }

  update(dt, input, cameraYaw) {
    let fx = 0, fz = 0;
    if (input.forward) fz -= 1;
    if (input.back) fz += 1;
    if (input.left) fx -= 1;
    if (input.right) fx += 1;

    const len = Math.hypot(fx, fz);
    if (len > 0) { fx /= len; fz /= len; }

    const cy = Math.cos(cameraYaw);
    const sy = Math.sin(cameraYaw);
    const worldX = fx * cy + fz * sy;
    const worldZ = -fx * sy + fz * cy;

    this.velocity.set(worldX * MOVE_SPEED, 0, worldZ * MOVE_SPEED);
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    this.group.position.copy(this.position);

    this.speed = this.velocity.length();
    updateWalkDeformation(this.avatar, this.speed / MOVE_SPEED, dt);
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
    this.position = new THREE.Vector3(initial.x ?? 0, 0, initial.z ?? 0);
    this.group.position.copy(this.position);

    this.buffer = [{ t: performance.now() / 1000, x: this.position.x, z: this.position.z }];
    this.renderDelay = 0.12;
    this.lastSpeed = 0;
  }

  setAvatar(mesh) {
    this.avatar = mesh;
    this.group.add(mesh);
  }

  pushUpdate(x, z) {
    const now = performance.now() / 1000;
    this.buffer.push({ t: now, x, z });
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
    const nz = a.z + (b.z - a.z) * alpha;

    const dx = nx - this.position.x;
    const dz = nz - this.position.z;
    const speed = Math.hypot(dx, dz) / Math.max(dt, 1e-4);
    this.lastSpeed = speed;

    this.position.set(nx, 0, nz);
    this.group.position.copy(this.position);

    if (this.avatar) {
      const speedNorm = Math.min(speed / 4.5, 1);
      updateWalkDeformation(this.avatar, speedNorm, dt);
      this.avatar.rotation.y = Math.atan2(
        cameraPos.x - this.position.x,
        cameraPos.z - this.position.z
      );
    }
  }
}
