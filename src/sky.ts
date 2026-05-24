// gradient skydome — three-color shader, top → horizon → ground.
// the horizon color matches the renderer clear color and the floor base so
// the meeting line reads as one smooth plane.

import * as THREE from 'three';

export const HORIZON_COLOR = 0xf2f2f2;
export const TOP_COLOR = 0xdde6f0;
export const GROUND_COLOR = 0xe6e6e6;

const VERT = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 topColor;
  uniform vec3 horizonColor;
  uniform vec3 groundColor;
  uniform float exponent;
  varying vec3 vWorld;
  void main() {
    float h = normalize(vWorld).y;
    vec3 col;
    if (h > 0.0) {
      col = mix(horizonColor, topColor, pow(h, exponent));
    } else {
      col = mix(horizonColor, groundColor, pow(-h, exponent));
    }
    gl_FragColor = vec4(col, 1.0);
  }
`;

export function createSky(radius = 500): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      topColor:     { value: new THREE.Color(TOP_COLOR) },
      horizonColor: { value: new THREE.Color(HORIZON_COLOR) },
      groundColor:  { value: new THREE.Color(GROUND_COLOR) },
      exponent:     { value: 0.7 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), mat);
}
