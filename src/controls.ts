import type { CameraController } from './camera';

const LOOK_YAW_RATE = 2.4;
const LOOK_PITCH_RATE = 1.6;

export interface InputState {
  /** analog x in [-1, 1], + is right */
  mx: number;
  /** analog z in [-1, 1], - is forward */
  mz: number;
  /** edge-triggered jump; player.update() consumes by setting back to false */
  jump: boolean;
}

interface ControlsOpts {
  isChatActive: () => boolean;
}

export interface Controls {
  input: InputState;
  camera: CameraController;
  update: (dt: number) => void;
}

interface CancellableEl extends HTMLElement {
  _cancelStick?: () => void;
}

export function setupControls(canvas: HTMLCanvasElement, { isChatActive }: ControlsOpts): Controls {
  const input: InputState = { mx: 0, mz: 0, jump: false };

  // keyboard intentions (kept separate so touch+keyboard don't fight)
  const key = { forward: false, back: false, left: false, right: false, spaceHeld: false };

  // right-stick look rate, applied per frame
  const look = { yawRate: 0, pitchRate: 0 };

  const camera: CameraController = { yaw: 0, pitch: 0.25, distance: 5 };

  let mouseDragging = false;
  let lastX = 0,
    lastY = 0;
  let moveTouchId: number | null = null;
  let lookTouchId: number | null = null;

  const moveEl = document.getElementById('joystick-move') as CancellableEl | null;
  const lookEl = document.getElementById('joystick-look') as CancellableEl | null;
  const moveThumb = moveEl?.querySelector<HTMLElement>('.joystick-thumb') ?? null;
  const lookThumb = lookEl?.querySelector<HTMLElement>('.joystick-thumb') ?? null;

  // pinch-to-zoom for camera distance
  const pinchTouches = new Map<number, { x: number; y: number }>();
  let pinchStartDist = 0;
  let pinchStartCamDist = 0;

  function updateKeyboardVector(): void {
    let mx = 0,
      mz = 0;
    if (key.forward) mz -= 1;
    if (key.back) mz += 1;
    if (key.left) mx -= 1;
    if (key.right) mx += 1;
    const len = Math.hypot(mx, mz);
    if (len > 1) {
      mx /= len;
      mz /= len;
    }
    // keyboard only writes into input when no touch stick is active
    if (moveTouchId === null) {
      input.mx = mx;
      input.mz = mz;
    }
  }

  function setKey(code: string, down: boolean): void {
    if (isChatActive()) {
      key.forward = key.back = key.left = key.right = false;
      key.spaceHeld = false;
      input.mx = input.mz = 0;
      return;
    }
    switch (code) {
      case 'KeyW':
      case 'ArrowUp':
        key.forward = down;
        break;
      case 'KeyS':
      case 'ArrowDown':
        key.back = down;
        break;
      case 'KeyA':
      case 'ArrowLeft':
        key.left = down;
        break;
      case 'KeyD':
      case 'ArrowRight':
        key.right = down;
        break;
      case 'Space':
        if (down && !key.spaceHeld) input.jump = true;
        key.spaceHeld = down;
        return;
      default:
        return;
    }
    updateKeyboardVector();
  }

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !isChatActive()) e.preventDefault();
    setKey(e.code, true);
  });
  window.addEventListener('keyup', (e) => setKey(e.code, false));
  window.addEventListener('blur', () => {
    key.forward = key.back = key.left = key.right = false;
    if (moveTouchId === null) {
      input.mx = 0;
      input.mz = 0;
    }
  });

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---------- mouse / trackpad drag for camera ----------
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') return; // touch handled by joysticks
    if (e.button === 2 || e.button === 0) {
      mouseDragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    if (!mouseDragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    camera.yaw -= dx * 0.005;
    camera.pitch += dy * 0.005;
    camera.pitch = Math.max(-0.3, Math.min(0.9, camera.pitch));
  });

  function endMouseDrag(e: PointerEvent): void {
    if (e.pointerType === 'touch') return;
    mouseDragging = false;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {}
  }
  canvas.addEventListener('pointerup', endMouseDrag);
  canvas.addEventListener('pointercancel', endMouseDrag);

  canvas.addEventListener(
    'wheel',
    (e) => {
      camera.distance += e.deltaY * 0.005;
      camera.distance = Math.max(2, Math.min(12, camera.distance));
    },
    { passive: true },
  );

  // ---------- touch joysticks ----------

  function joystickGeom(el: HTMLElement): { cx: number; cy: number; radius: number } {
    const r = el.getBoundingClientRect();
    return {
      cx: r.left + r.width / 2,
      cy: r.top + r.height / 2,
      radius: r.width / 2 - 12,
    };
  }

  function setThumb(thumb: HTMLElement, dx: number, dy: number): void {
    thumb.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  }

  function resetThumb(thumb: HTMLElement): void {
    thumb.style.transform = `translate(-50%, -50%)`;
  }

  function attachStick(
    el: CancellableEl | null,
    thumb: HTMLElement | null,
    onVector: (nx: number, ny: number) => void,
    onEnd: () => void,
  ): void {
    if (!el || !thumb) return;
    let activeId: number | null = null;
    let geom: { cx: number; cy: number; radius: number } | null = null;

    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' && e.pointerType !== 'pen' && e.pointerType !== 'mouse') return;
      if (activeId !== null) return;
      if (isChatActive()) return;
      activeId = e.pointerId;
      geom = joystickGeom(el);
      el.setPointerCapture(e.pointerId);
      el.classList.add('active');
      handleMove(e);
      e.preventDefault();
    });

    el.addEventListener('pointermove', handleMove);

    function handleMove(e: PointerEvent): void {
      if (e.pointerId !== activeId || !geom) return;
      const dx = e.clientX - geom.cx;
      const dy = e.clientY - geom.cy;
      const len = Math.hypot(dx, dy);
      const max = geom.radius;
      let nx = dx / max;
      let ny = dy / max;
      if (len > max) {
        nx = dx / len;
        ny = dy / len;
      }
      setThumb(thumb!, nx * max, ny * max);
      onVector(nx, ny);
    }

    function end(e: PointerEvent): void {
      if (e.pointerId !== activeId) return;
      activeId = null;
      el!.classList.remove('active');
      try {
        el!.releasePointerCapture(e.pointerId);
      } catch {}
      resetThumb(thumb!);
      onEnd();
    }
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', end);

    // expose for outer scope cancellation when chat opens
    el._cancelStick = (): void => {
      if (activeId !== null) {
        activeId = null;
        el.classList.remove('active');
        resetThumb(thumb);
        onEnd();
      }
    };
  }

  attachStick(
    moveEl,
    moveThumb,
    (nx, ny) => {
      moveTouchId = 1;
      const dead = 0.12;
      const mag = Math.hypot(nx, ny);
      if (mag < dead) {
        input.mx = 0;
        input.mz = 0;
        return;
      }
      const scaled = (mag - dead) / (1 - dead);
      const k = scaled / mag;
      input.mx = nx * k;
      input.mz = ny * k;
    },
    () => {
      moveTouchId = null;
      input.mx = 0;
      input.mz = 0;
      updateKeyboardVector();
    },
  );

  attachStick(
    lookEl,
    lookThumb,
    (nx, ny) => {
      lookTouchId = 1;
      const dead = 0.15;
      const mag = Math.hypot(nx, ny);
      if (mag < dead) {
        look.yawRate = 0;
        look.pitchRate = 0;
        return;
      }
      const scaled = (mag - dead) / (1 - dead);
      const k = scaled / mag;
      look.yawRate = nx * k;
      look.pitchRate = ny * k;
    },
    () => {
      lookTouchId = null;
      look.yawRate = 0;
      look.pitchRate = 0;
    },
  );

  // pinch-to-zoom on the game canvas surface (not on joysticks)
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    pinchTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinchTouches.size === 2) {
      const [a, b] = [...pinchTouches.values()];
      pinchStartDist = Math.hypot(a.x - b.x, a.y - b.y);
      pinchStartCamDist = camera.distance;
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'touch') return;
    if (!pinchTouches.has(e.pointerId)) return;
    pinchTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinchTouches.size === 2 && pinchStartDist > 0) {
      const [a, b] = [...pinchTouches.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const ratio = pinchStartDist / d;
      camera.distance = Math.max(2, Math.min(12, pinchStartCamDist * ratio));
    }
  });
  function endPinch(e: PointerEvent): void {
    if (e.pointerType !== 'touch') return;
    pinchTouches.delete(e.pointerId);
    if (pinchTouches.size < 2) pinchStartDist = 0;
  }
  canvas.addEventListener('pointerup', endPinch);
  canvas.addEventListener('pointercancel', endPinch);

  const jumpBtn = document.getElementById('jump-btn');
  if (jumpBtn) {
    jumpBtn.addEventListener('pointerdown', (e) => {
      if (isChatActive()) return;
      input.jump = true;
      jumpBtn.classList.add('pressed');
      e.preventDefault();
    });
    const release = (): void => {
      jumpBtn.classList.remove('pressed');
    };
    jumpBtn.addEventListener('pointerup', release);
    jumpBtn.addEventListener('pointercancel', release);
    jumpBtn.addEventListener('pointerleave', release);
  }

  function update(dt: number): void {
    if (isChatActive()) {
      input.mx = 0;
      input.mz = 0;
      look.yawRate = 0;
      look.pitchRate = 0;
      moveEl?._cancelStick?.();
      lookEl?._cancelStick?.();
      return;
    }
    if (look.yawRate || look.pitchRate) {
      camera.yaw -= look.yawRate * LOOK_YAW_RATE * dt;
      camera.pitch += look.pitchRate * LOOK_PITCH_RATE * dt;
      camera.pitch = Math.max(-0.3, Math.min(0.9, camera.pitch));
    }
  }

  // suppress unused-variable warning for lookTouchId — it's a placeholder for
  // future logic that distinguishes active look pointers.
  void lookTouchId;

  return { input, camera, update };
}
