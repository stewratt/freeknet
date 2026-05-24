import * as THREE from 'three';
import type { World } from '@perplexdotgg/bounce';

const BOX_COLOR = 0xf2efe8;
const EDGE_COLOR = 0xb0aca4;

// AABB collider description. Kept as a plain data type so the rendering and
// physics layers can both consume it (and so a future map-import pipeline
// has something obvious to emit).
export interface Collider {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
}

function makeBoxMesh(
  scene: THREE.Scene,
  sx: number,
  sy: number,
  sz: number,
  x: number,
  y: number,
  z: number,
): void {
  const geo = new THREE.BoxGeometry(sx, sy, sz);
  const mat = new THREE.MeshBasicMaterial({ color: BOX_COLOR, fog: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y, z);
  scene.add(mesh);

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geo),
    new THREE.LineBasicMaterial({ color: EDGE_COLOR, fog: true }),
  );
  edges.position.copy(mesh.position);
  scene.add(edges);
}

/**
 * Describes the static world geometry. One day this'll be a loaded map; for
 * now it's a hardcoded list. Must match the server's COLLIDERS array.
 */
export const STAGE_COLLIDERS: Collider[] = [
  // wide, low platform centered 12.5u out the +x direction. 5 grid squares.
  { x: 12.5, y: 0.35, z: 0, sx: 6, sy: 0.7, sz: 5 },
];

/**
 * Add the stage visuals to the scene and register matching static bodies in
 * the physics world. Returns the collider list so callers that don't have a
 * physics world (e.g. unit tests of geometry) can still inspect the shape.
 */
export function createStage(scene: THREE.Scene, physicsWorld: World): { colliders: Collider[] } {
  for (const c of STAGE_COLLIDERS) {
    makeBoxMesh(scene, c.sx, c.sy, c.sz, c.x, c.y, c.z);
    const shape = physicsWorld.createBox({ width: c.sx, height: c.sy, depth: c.sz });
    physicsWorld.createStaticBody({
      shape,
      position: [c.x, c.y, c.z],
      friction: 0.9,
      restitution: 0.3,
    });
  }

  // ground plane: a huge thin box just below y=0, so the character's feet
  // (at body.position.y = 0 by construction) rest on top of it.
  const groundShape = physicsWorld.createBox({ width: 400, height: 1, depth: 400 });
  physicsWorld.createStaticBody({
    shape: groundShape,
    position: [0, -0.5, 0],
    friction: 0.95,
    restitution: 0,
  });

  return { colliders: STAGE_COLLIDERS };
}
