import * as THREE from 'three';

const AVATAR_WIDTH = 1.2;
const AVATAR_HEIGHT = 1.8;
const SEG_X = 8;
const SEG_Y = 14;
// distance at which we stop deforming the mesh and treat it as a flat plane.
// the per-vertex sway is too small to perceive at this range anyway.
const LOD_DISTANCE = 25;
// once the standing-still decay has brought every vertex within this epsilon
// of its base position, we mark the mesh as "settled" and stop spending CPU
// on it until the player moves again.
const SETTLED_EPSILON = 1e-4;

interface AvatarUserData {
  walkPhase: number;
  settled: boolean;
  [key: string]: unknown;
}

interface AvatarGeometryUserData {
  basePositions: Float32Array;
  [key: string]: unknown;
}

export type AvatarMesh = THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;

export function createAvatarFromCanvas(canvas: HTMLCanvasElement): AvatarMesh {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;

  const geometry = new THREE.PlaneGeometry(AVATAR_WIDTH, AVATAR_HEIGHT, SEG_X, SEG_Y);
  geometry.translate(0, AVATAR_HEIGHT / 2, 0);

  const basePositions = new Float32Array(geometry.attributes.position.array);
  (geometry.userData as AvatarGeometryUserData).basePositions = basePositions;

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    alphaTest: 0.5,
    transparent: false,
    side: THREE.DoubleSide,
    color: 0xffffff,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  const ud = mesh.userData as AvatarUserData;
  ud.walkPhase = 0;
  ud.settled = true;
  // YXZ so billboard yaw (Y) is applied first, then bow tilt (X) is forward-toward-camera
  mesh.rotation.order = 'YXZ';
  return mesh;
}

export function createAvatarFromDataURL(dataURL: string): Promise<AvatarMesh> {
  return new Promise((resolve) => {
    const img = new Image();
    img.addEventListener(
      'load',
      () => {
        const cv = document.createElement('canvas');
        cv.width = img.width;
        cv.height = img.height;
        const cx = cv.getContext('2d')!;
        cx.drawImage(img, 0, 0);
        resolve(createAvatarFromCanvas(cv));
      },
      { once: true },
    );
    img.src = dataURL;
  });
}

// `cameraDistance` is optional; when provided and the mesh is past LOD_DISTANCE
// we skip the vertex math entirely and just snap to base. The avatar is still
// visible (texture intact), it just doesn't wiggle.
export function updateWalkDeformation(
  mesh: AvatarMesh,
  speed: number,
  dt: number,
  cameraDistance = 0,
): void {
  const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
  const base = (mesh.geometry.userData as AvatarGeometryUserData).basePositions;
  if (!base) return;
  const ud = mesh.userData as AvatarUserData;
  const arr = pos.array as Float32Array;

  // LOD: far avatars don't deform.
  if (cameraDistance > LOD_DISTANCE) {
    if (!ud.settled) {
      arr.set(base);
      pos.needsUpdate = true;
      ud.settled = true;
      ud.walkPhase = 0;
    }
    return;
  }

  // idle: nothing to do if already settled and still standing still.
  if (speed < 0.01 && ud.settled) return;

  ud.walkPhase += dt * speed * 8;

  if (speed < 0.01) {
    const decay = Math.exp(-dt * 8);
    let maxResidual = 0;
    for (let i = 0; i < pos.count; i++) {
      const idx = i * 3;
      const dx = arr[idx] - base[idx];
      const dy = arr[idx + 1] - base[idx + 1];
      arr[idx] = base[idx] + dx * decay;
      arr[idx + 1] = base[idx + 1] + dy * decay;
      const r = Math.abs(dx) + Math.abs(dy);
      if (r > maxResidual) maxResidual = r;
    }
    if (maxResidual * decay < SETTLED_EPSILON) {
      // snap to base and mark settled so subsequent frames are free.
      arr.set(base);
      ud.settled = true;
      ud.walkPhase = 0;
    }
  } else {
    ud.settled = false;
    const phase = ud.walkPhase;
    const amp = Math.min(speed * 0.08, 0.08);
    for (let i = 0; i < pos.count; i++) {
      const idx = i * 3;
      const bx = base[idx];
      const by = base[idx + 1];
      const heightFactor = by / AVATAR_HEIGHT;
      const bob = Math.sin(phase * 2) * amp * 0.4;
      const sway = Math.sin(phase + by * 2.5) * amp * heightFactor;
      arr[idx] = bx + sway;
      arr[idx + 1] = by + bob * heightFactor;
    }
  }

  pos.needsUpdate = true;
}
