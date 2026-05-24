// orbit-follow camera: tracks the local player with the user's yaw/pitch/
// distance from setupControls. exports a single follow() helper that the
// frame loop calls each tick.

import * as THREE from 'three';

const TARGET_HEIGHT = 1.0;   // look at the player's chest, not their feet
const VERTICAL_OFFSET = 1.5; // camera floats above the orbit ring

export interface CameraController {
  yaw: number;
  pitch: number;
  distance: number;
}

export function createCamera(aspect: number): THREE.PerspectiveCamera {
  return new THREE.PerspectiveCamera(60, aspect, 0.1, 1000);
}

const _offset = new THREE.Vector3();
const _target = new THREE.Vector3();

export function follow(
  camera: THREE.PerspectiveCamera,
  camCtl: CameraController,
  playerPos: THREE.Vector3,
): void {
  const cy = Math.cos(camCtl.yaw);
  const sy = Math.sin(camCtl.yaw);
  const cp = Math.cos(camCtl.pitch);
  const sp = Math.sin(camCtl.pitch);
  _offset.set(
    sy * cp * camCtl.distance,
    sp * camCtl.distance + VERTICAL_OFFSET,
    cy * cp * camCtl.distance,
  );
  _target.set(playerPos.x, playerPos.y + TARGET_HEIGHT, playerPos.z);
  camera.position.copy(_target).add(_offset);
  camera.lookAt(_target);
}
