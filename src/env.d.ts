/// <reference types="vite/client" />

declare module 'troika-three-text' {
  import * as THREE from 'three';
  export class Text extends THREE.Object3D {
    text: string;
    fontSize: number;
    color: number;
    anchorX: string;
    anchorY: string;
    outlineWidth: number;
    outlineColor: number;
    outlineOpacity: number;
    maxWidth: number;
    depthOffset: number;
    fillOpacity: number;
    renderOrder: number;
    material: THREE.Material & { depthTest: boolean; depthWrite: boolean };
    sync(): void;
    dispose(): void;
  }
}

interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly VITE_DISABLE_VOICE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
