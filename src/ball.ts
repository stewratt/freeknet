import * as THREE from 'three';

export const BALL_RADIUS = 0.25;

export class Ball {
  readonly mesh: THREE.Mesh;
  readonly position = new THREE.Vector3(0, BALL_RADIUS, 0);
  readonly velocity = new THREE.Vector3();
  private readonly targetPosition = new THREE.Vector3(0, BALL_RADIUS, 0);
  private readonly targetVelocity = new THREE.Vector3();
  private lastUpdate = performance.now() / 1000;
  /** until the first server `ball` message lands, the mesh is hidden and
   *  receiveState will snap straight to the authoritative position instead
   *  of lerping (which used to cause a visible tween from the origin to
   *  the ball's real spawn point on initial load). */
  private hasReceivedState = false;

  constructor(scene: THREE.Scene) {
    const geo = new THREE.SphereGeometry(BALL_RADIUS, 20, 14);
    const mat = new THREE.MeshBasicMaterial({ color: 0xb8b8b8, fog: true });
    this.mesh = new THREE.Mesh(geo, mat);

    // soft contour: a slightly larger flat-shaded inner sphere via line ring on the equator
    const ringGeo = new THREE.RingGeometry(BALL_RADIUS * 0.98, BALL_RADIUS * 1.02, 24);
    ringGeo.rotateX(-Math.PI / 2);
    const ring = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({ color: 0x8a8a8a, side: THREE.DoubleSide, fog: true }),
    );
    this.mesh.add(ring);

    // hide until we know where the ball actually is; saves the player from
    // seeing it tween from (0, 0.25, 0) to the spawn point on first load.
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  receiveState(x: number, y: number, z: number, vx: number, vy: number, vz: number): void {
    this.targetPosition.set(x, y, z);
    this.targetVelocity.set(vx, vy, vz);
    this.velocity.copy(this.targetVelocity);
    this.lastUpdate = performance.now() / 1000;
    if (!this.hasReceivedState) {
      // first state from the server — snap directly so the mesh appears at
      // the correct position, not at the constructor's placeholder origin.
      this.position.set(x, y, z);
      this.mesh.position.copy(this.position);
      this.mesh.visible = true;
      this.hasReceivedState = true;
    }
  }

  update(dt: number): void {
    if (!this.hasReceivedState) return;
    const t = performance.now() / 1000;
    const sinceUpdate = Math.min(t - this.lastUpdate, 0.3);
    const predicted = this.targetPosition.clone().add(
      this.targetVelocity.clone().multiplyScalar(sinceUpdate),
    );
    const k = 1 - Math.exp(-dt * 14);
    this.position.lerp(predicted, k);
    this.mesh.position.copy(this.position);

    // rolling rotation: axis perpendicular to ground-plane velocity
    const speed = Math.hypot(this.targetVelocity.x, this.targetVelocity.z);
    if (speed > 0.05) {
      const axis = new THREE.Vector3(-this.targetVelocity.z, 0, this.targetVelocity.x).normalize();
      this.mesh.rotateOnWorldAxis(axis, (speed * dt) / BALL_RADIUS);
    }
  }
}
