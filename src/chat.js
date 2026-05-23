import * as THREE from 'three';
import { Text } from 'troika-three-text';

const PROXIMITY_MAX = 30;
const PROXIMITY_FADE = 22;
const MESSAGE_LIFETIME = 10;
const FADE_OUT_DURATION = 1.0;

export class ChatManager {
  constructor(scene, getPlayerPos, camera) {
    this.scene = scene;
    this.camera = camera;
    this.getPlayerPos = getPlayerPos;
    // one current bubble per player
    this.bubbles = new Map();
    // messages array kept for external introspection / count
    this.messages = [];
  }

  _disposeBubble(b) {
    this.scene.remove(b.text);
    b.text.dispose();
  }

  add(playerId, text) {
    const existing = this.bubbles.get(playerId);
    if (existing) this._disposeBubble(existing);

    const tx = new Text();
    tx.text = text;
    tx.fontSize = 0.22;
    tx.color = 0x111111;
    tx.anchorX = 'center';
    tx.anchorY = 'bottom';
    tx.outlineWidth = 0.014;
    tx.outlineColor = 0xffffff;
    tx.outlineOpacity = 1;
    tx.maxWidth = 5;
    tx.depthOffset = -1;
    tx.fillOpacity = 1;
    tx.outlineOpacity = 1;
    tx.renderOrder = 999;
    tx.material.depthTest = false;
    tx.material.depthWrite = false;
    tx.sync();
    this.scene.add(tx);

    const bubble = { playerId, text: tx, age: 0 };
    this.bubbles.set(playerId, bubble);
    this.messages = Array.from(this.bubbles.values());
  }

  update(dt) {
    const camPos = new THREE.Vector3();
    this.camera.getWorldPosition(camPos);

    const expired = [];
    for (const [pid, b] of this.bubbles) {
      const pos = this.getPlayerPos(pid);
      if (!pos) { expired.push(pid); continue; }

      b.age += dt;
      if (b.age >= MESSAGE_LIFETIME) { expired.push(pid); continue; }

      const tx = b.text;
      tx.position.set(pos.x, pos.y + 2.05, pos.z);
      tx.lookAt(camPos.x, tx.position.y, camPos.z);

      const dist = camPos.distanceTo(pos);
      const proximity = dist > PROXIMITY_MAX
        ? 0
        : dist > PROXIMITY_FADE
          ? 1 - (dist - PROXIMITY_FADE) / (PROXIMITY_MAX - PROXIMITY_FADE)
          : 1;

      const fadeIn = Math.min(b.age / 0.15, 1);
      const remaining = MESSAGE_LIFETIME - b.age;
      const fadeOut = remaining < FADE_OUT_DURATION ? remaining / FADE_OUT_DURATION : 1;
      const opacity = Math.max(0, fadeIn * fadeOut * proximity);
      tx.fillOpacity = opacity;
      tx.outlineOpacity = opacity;
      tx.visible = opacity > 0.01;
    }

    for (const pid of expired) {
      const b = this.bubbles.get(pid);
      if (b) {
        this._disposeBubble(b);
        this.bubbles.delete(pid);
      }
    }
    if (expired.length) this.messages = Array.from(this.bubbles.values());
  }

  clearForPlayer(playerId) {
    const b = this.bubbles.get(playerId);
    if (b) {
      this._disposeBubble(b);
      this.bubbles.delete(playerId);
      this.messages = Array.from(this.bubbles.values());
    }
  }
}

export function setupChatInput({ onSend }) {
  const input = document.getElementById('chat-input');

  // active mirrors whether the input has focus — true whether user pressed T or clicked it
  function isActive() {
    return document.activeElement === input;
  }

  function close() {
    input.value = '';
    input.blur();
  }

  // T to focus from anywhere outside an input/textarea
  window.addEventListener('keydown', (e) => {
    if (isActive()) return;
    if ((e.key === 't' || e.key === 'T') && !e.repeat) {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      input.focus();
    }
  });

  // handle send/cancel on the input itself so it works whether you pressed T or clicked
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const text = input.value.trim();
      if (text) onSend(text);
      close();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });

  return { isActive };
}
