export function setupControls(canvas, { isChatActive }) {
  const input = {
    forward: false,
    back: false,
    left: false,
    right: false,
  };

  const camera = {
    yaw: 0,
    pitch: 0.25,
    distance: 5,
  };

  let dragging = false;
  let lastX = 0, lastY = 0;

  function setKey(code, down) {
    if (isChatActive()) {
      input.forward = input.back = input.left = input.right = false;
      return;
    }
    switch (code) {
      case 'KeyW': case 'ArrowUp':    input.forward = down; break;
      case 'KeyS': case 'ArrowDown':  input.back = down;    break;
      case 'KeyA': case 'ArrowLeft':  input.left = down;    break;
      case 'KeyD': case 'ArrowRight': input.right = down;   break;
    }
  }

  window.addEventListener('keydown', (e) => setKey(e.code, true));
  window.addEventListener('keyup',   (e) => setKey(e.code, false));
  window.addEventListener('blur', () => {
    input.forward = input.back = input.left = input.right = false;
  });

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button === 2 || e.button === 0) {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    camera.yaw -= dx * 0.005;
    camera.pitch += dy * 0.005;
    camera.pitch = Math.max(-0.3, Math.min(0.9, camera.pitch));
  });

  function endDrag(e) {
    dragging = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch {}
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  canvas.addEventListener('wheel', (e) => {
    camera.distance += e.deltaY * 0.005;
    camera.distance = Math.max(2, Math.min(12, camera.distance));
  }, { passive: true });

  return { input, camera };
}
