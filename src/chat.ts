import * as THREE from 'three';
import { Text } from 'troika-three-text';

const PROXIMITY_MAX = 30;
const PROXIMITY_FADE = 22;
const MESSAGE_LIFETIME = 10;
const FADE_OUT_DURATION = 1.0;

// troika's Text isn't strictly typed. cast through a small interface for the
// properties we actually set.
interface BubbleText extends THREE.Object3D {
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

interface Bubble {
  playerId: string;
  text: BubbleText;
  age: number;
}

export type GetPlayerPos = (id: string) => THREE.Vector3 | null;

export class ChatManager {
  // one current bubble per player
  readonly bubbles = new Map<string, Bubble>();
  // messages array kept for external introspection / count
  messages: Bubble[] = [];

  constructor(
    private readonly scene: THREE.Scene,
    private readonly getPlayerPos: GetPlayerPos,
    private readonly camera: THREE.Camera,
  ) {}

  private _disposeBubble(b: Bubble): void {
    this.scene.remove(b.text);
    b.text.dispose();
  }

  add(playerId: string, text: string): void {
    const existing = this.bubbles.get(playerId);
    if (existing) this._disposeBubble(existing);

    const tx = new Text() as unknown as BubbleText;
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
    tx.renderOrder = 999;
    tx.material.depthTest = false;
    tx.material.depthWrite = false;
    tx.sync();
    this.scene.add(tx);

    const bubble: Bubble = { playerId, text: tx, age: 0 };
    this.bubbles.set(playerId, bubble);
    this.messages = Array.from(this.bubbles.values());
  }

  update(dt: number): void {
    const camPos = new THREE.Vector3();
    this.camera.getWorldPosition(camPos);

    const expired: string[] = [];
    for (const [pid, b] of this.bubbles) {
      const pos = this.getPlayerPos(pid);
      if (!pos) {
        expired.push(pid);
        continue;
      }

      b.age += dt;
      if (b.age >= MESSAGE_LIFETIME) {
        expired.push(pid);
        continue;
      }

      const tx = b.text;
      tx.position.set(pos.x, pos.y + 2.05, pos.z);
      tx.lookAt(camPos.x, tx.position.y, camPos.z);

      const dist = camPos.distanceTo(pos);
      const proximity =
        dist > PROXIMITY_MAX
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

  clearForPlayer(playerId: string): void {
    const b = this.bubbles.get(playerId);
    if (b) {
      this._disposeBubble(b);
      this.bubbles.delete(playerId);
      this.messages = Array.from(this.bubbles.values());
    }
  }
}

interface ChatInputOpts {
  onSend: (text: string) => void;
  onCommand?: (cmd: string) => void;
}

export interface ChatInput {
  isActive: () => boolean;
}

export function setupChatInput({ onSend, onCommand }: ChatInputOpts): ChatInput {
  const input = document.getElementById('chat-input') as HTMLInputElement;
  const chatBar = document.getElementById('chat-bar') as HTMLElement;

  function isActive(): boolean {
    return document.activeElement === input;
  }

  function open(): void {
    document.body.classList.add('chatting');
    input.focus();
    // iOS sometimes ignores focus from a non-trusted event; nudge it
    setTimeout(() => input.focus({ preventScroll: true }), 0);
  }

  function close(): void {
    input.value = '';
    input.blur();
    document.body.classList.remove('chatting');
    chatBar.style.bottom = '';
  }

  // T to focus on desktop
  window.addEventListener('keydown', (e) => {
    if (isActive()) return;
    if ((e.key === 't' || e.key === 'T') && !e.repeat) {
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      open();
    }
  });

  input.addEventListener('focus', () => {
    document.body.classList.add('chatting');
  });
  input.addEventListener('blur', () => {
    document.body.classList.remove('chatting');
    chatBar.style.bottom = '';
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const text = input.value.trim();
      if (text.startsWith('/')) {
        onCommand?.(text);
      } else if (text) {
        onSend(text);
      }
      close();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });

  // reposition input above the on-screen keyboard
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const onViewport = (): void => {
      if (!isActive()) {
        chatBar.style.bottom = '';
        return;
      }
      const keyboardInset = window.innerHeight - (vv.height + vv.offsetTop);
      const offset = Math.max(0, keyboardInset);
      chatBar.style.bottom = `calc(${offset}px + 12px)`;
    };
    vv.addEventListener('resize', onViewport);
    vv.addEventListener('scroll', onViewport);
  }

  return { isActive };
}
