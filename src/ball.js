import * as THREE from 'three';

export const BALL_RADIUS = 0.25;

export class Ball {
  constructor(scene) {
    const geo = new THREE.SphereGeometry(BALL_RADIUS, 20, 14);
    const mat = new THREE.MeshBasicMaterial({ color: 0xb8b8b8, fog: true });
    this.mesh = new THREE.Mesh(geo, mat);

    // soft contour: a slightly larger flat-shaded inner sphere via line ring on the equator
    const ringGeo = new THREE.RingGeometry(BALL_RADIUS * 0.98, BALL_RADIUS * 1.02, 24);
    ringGeo.rotateX(-Math.PI / 2);
    const ring = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({ color: 0x8a8a8a, side: THREE.DoubleSide, fog: true })
    );
    this.mesh.add(ring);

    scene.add(this.mesh);

    this.position = new THREE.Vector3(0, BALL_RADIUS, 0);
    this.velocity = new THREE.Vector3();
    this.targetPosition = new THREE.Vector3(0, BALL_RADIUS, 0);
    this.targetVelocity = new THREE.Vector3();
    this.lastUpdate = performance.now() / 1000;
  }

  receiveState(x, y, z, vx, vy, vz) {
    this.targetPosition.set(x, y, z);
    this.targetVelocity.set(vx, vy, vz);
    this.velocity.copy(this.targetVelocity);
    this.lastUpdate = performance.now() / 1000;
  }

  update(dt) {
    const t = performance.now() / 1000;
    const sinceUpdate = Math.min(t - this.lastUpdate, 0.3);
    const predicted = this.targetPosition.clone().add(
      this.targetVelocity.clone().multiplyScalar(sinceUpdate)
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
