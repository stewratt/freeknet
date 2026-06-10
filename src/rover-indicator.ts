// the "rovers are talking" indicator: a pulsing `· · ·` floating above each
// participant while a handshake conversation runs. mirrors the chat bubble
// styling but lives in its own tiny manager — ChatManager's 10s lifetime and
// one-bubble-per-player semantics don't fit a persistent indicator.

import * as THREE from 'three';
import { Text } from 'troika-three-text';
import type { GetPlayerPos } from './chat';

const PROXIMITY_MAX = 30;
const PROXIMITY_FADE = 22;
// failsafe: if the 'off' message is lost, don't blink forever
const MAX_LIFETIME = 120;

interface IndicatorText extends THREE.Object3D {
  text: string;
  fontSize: number;
  color: number;
  anchorX: string;
  anchorY: string;
  outlineWidth: number;
  outlineColor: number;
  outlineOpacity: number;
  depthOffset: number;
  fillOpacity: number;
  renderOrder: number;
  material: THREE.Material & { depthTest: boolean; depthWrite: boolean };
  sync(): void;
  dispose(): void;
}

interface Indicator {
  text: IndicatorText;
  age: number;
}

export class RoverIndicatorManager {
  readonly indicators = new Map<string, Indicator>();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly getPlayerPos: GetPlayerPos,
    private readonly camera: THREE.Camera,
  ) {}

  set(a: string, b: string, on: boolean): void {
    for (const id of [a, b]) {
      if (on) this._add(id);
      else this._remove(id);
    }
  }

  private _add(id: string): void {
    if (this.indicators.has(id)) return;
    const tx = new Text() as unknown as IndicatorText;
    tx.text = '· · ·';
    tx.fontSize = 0.22;
    tx.color = 0x111111;
    tx.anchorX = 'center';
    tx.anchorY = 'bottom';
    tx.outlineWidth = 0.014;
    tx.outlineColor = 0xffffff;
    tx.outlineOpacity = 1;
    tx.depthOffset = -1;
    tx.fillOpacity = 1;
    tx.renderOrder = 999;
    tx.material.depthTest = false;
    tx.material.depthWrite = false;
    tx.sync();
    this.scene.add(tx);
    this.indicators.set(id, { text: tx, age: 0 });
  }

  private _remove(id: string): void {
    const ind = this.indicators.get(id);
    if (!ind) return;
    this.scene.remove(ind.text);
    ind.text.dispose();
    this.indicators.delete(id);
  }

  clearForPlayer(id: string): void {
    this._remove(id);
  }

  update(dt: number): void {
    if (this.indicators.size === 0) return;
    const camPos = new THREE.Vector3();
    this.camera.getWorldPosition(camPos);

    const expired: string[] = [];
    for (const [id, ind] of this.indicators) {
      const pos = this.getPlayerPos(id);
      ind.age += dt;
      if (!pos || ind.age > MAX_LIFETIME) {
        expired.push(id);
        continue;
      }
      const tx = ind.text;
      tx.position.set(pos.x, pos.y + 2.05, pos.z);
      tx.lookAt(camPos.x, tx.position.y, camPos.z);

      const dist = camPos.distanceTo(pos);
      const proximity =
        dist > PROXIMITY_MAX
          ? 0
          : dist > PROXIMITY_FADE
            ? 1 - (dist - PROXIMITY_FADE) / (PROXIMITY_MAX - PROXIMITY_FADE)
            : 1;
      // gentle pulse so it reads as "talking", not a stuck label
      const pulse = 0.55 + 0.45 * Math.sin(ind.age * 3);
      const opacity = proximity * pulse;
      tx.fillOpacity = opacity;
      tx.outlineOpacity = opacity;
      tx.visible = opacity > 0.01;
    }
    for (const id of expired) this._remove(id);
  }
}
