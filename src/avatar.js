import * as THREE from 'three';

const AVATAR_WIDTH = 1.2;
const AVATAR_HEIGHT = 1.8;
const SEG_X = 8;
const SEG_Y = 14;

export function createAvatarFromCanvas(canvas) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;

  const geometry = new THREE.PlaneGeometry(AVATAR_WIDTH, AVATAR_HEIGHT, SEG_X, SEG_Y);
  geometry.translate(0, AVATAR_HEIGHT / 2, 0);

  const basePositions = new Float32Array(geometry.attributes.position.array);
  geometry.userData.basePositions = basePositions;

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    alphaTest: 0.5,
    transparent: false,
    side: THREE.DoubleSide,
    color: 0xffffff,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.userData.walkPhase = 0;
  // YXZ so billboard yaw (Y) is applied first, then bow tilt (X) is forward-toward-camera
  mesh.rotation.order = 'YXZ';
  return mesh;
}

export function createAvatarFromDataURL(dataURL) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = img.width;
      cv.height = img.height;
      const cx = cv.getContext('2d');
      cx.drawImage(img, 0, 0);
      resolve(createAvatarFromCanvas(cv));
    };
    img.src = dataURL;
  });
}

export function updateWalkDeformation(mesh, speed, dt) {
  const pos = mesh.geometry.attributes.position;
  const base = mesh.geometry.userData.basePositions;
  if (!base) return;

  mesh.userData.walkPhase += dt * speed * 8;

  if (speed < 0.01) {
    const decay = Math.exp(-dt * 8);
    for (let i = 0; i < pos.count; i++) {
      const idx = i * 3;
      const dx = pos.array[idx] - base[idx];
      const dy = pos.array[idx + 1] - base[idx + 1];
      pos.array[idx] = base[idx] + dx * decay;
      pos.array[idx + 1] = base[idx + 1] + dy * decay;
    }
  } else {
    const phase = mesh.userData.walkPhase;
    const amp = Math.min(speed * 0.08, 0.08);
    for (let i = 0; i < pos.count; i++) {
      const idx = i * 3;
      const bx = base[idx];
      const by = base[idx + 1];
      const heightFactor = by / AVATAR_HEIGHT;
      const bob = Math.sin(phase * 2) * amp * 0.4;
      const sway = Math.sin(phase + by * 2.5) * amp * heightFactor;
      pos.array[idx] = bx + sway;
      pos.array[idx + 1] = by + bob * heightFactor;
    }
  }

  pos.needsUpdate = true;
}
