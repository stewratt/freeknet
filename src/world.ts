// the static world: floor plane + grid. matches the sky's ground color so the
// horizon line reads naturally.

import * as THREE from 'three';
import { GROUND_COLOR } from './sky';

export function createFloor(size = 400): THREE.Mesh {
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshBasicMaterial({ color: GROUND_COLOR, fog: true }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.001; // hair below 0 so the grid sits on top
  return floor;
}

export function createGrid(size = 200, divisions = 80): THREE.GridHelper {
  const grid = new THREE.GridHelper(size, divisions, 0x999999, 0xc8c8c8);
  // GridHelper's material is a LineBasicMaterial (single) — type it directly.
  const mat = grid.material as THREE.LineBasicMaterial;
  mat.transparent = true;
  mat.opacity = 0.6;
  mat.depthWrite = false;
  return grid;
}
