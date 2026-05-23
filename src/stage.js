import * as THREE from 'three';

const BOX_COLOR = 0xf2efe8;
const EDGE_COLOR = 0xb0aca4;

function makeBox(scene, sx, sy, sz, x, y, z) {
  const geo = new THREE.BoxGeometry(sx, sy, sz);
  const mat = new THREE.MeshBasicMaterial({ color: BOX_COLOR, fog: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y, z);
  scene.add(mesh);

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geo),
    new THREE.LineBasicMaterial({ color: EDGE_COLOR, fog: true })
  );
  edges.position.copy(mesh.position);
  scene.add(edges);

  return { x, y, z, sx, sy, sz };
}

export function createStage(scene) {
  const colliders = [];

  // 5 grid squares (2.5 units each) in +x
  const stageCenter = { x: 12.5, z: 0 };

  // stage: wide, low platform
  colliders.push(makeBox(scene, 6, 0.7, 5, stageCenter.x, 0.35, stageCenter.z));

  return { colliders };
}
