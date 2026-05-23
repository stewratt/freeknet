export function setupDrawing({ onEnter }) {
  const canvas = document.getElementById('draw-canvas');
  const ctx = canvas.getContext('2d');
  const enterBtn = document.getElementById('enter-btn');
  const redrawBtn = document.getElementById('redraw-btn');

  let drawing = false;
  let finished = false;
  let points = [];

  function clear() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function setupStroke() {
    ctx.strokeStyle = '#111111';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  function reset() {
    drawing = false;
    finished = false;
    points = [];
    clear();
    setupStroke();
    enterBtn.disabled = true;
    redrawBtn.disabled = true;
  }

  function getPos(e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * canvas.width,
      y: ((e.clientY - r.top) / r.height) * canvas.height,
    };
  }

  function redraw() {
    clear();
    setupStroke();
    if (points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length - 1; i++) {
      const mx = (points[i].x + points[i + 1].x) / 2;
      const my = (points[i].y + points[i + 1].y) / 2;
      ctx.quadraticCurveTo(points[i].x, points[i].y, mx, my);
    }
    const last = points[points.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (finished) return;
    drawing = true;
    canvas.setPointerCapture(e.pointerId);
    const p = getPos(e);
    points = [p];
    redraw();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = getPos(e);
    const last = points[points.length - 1];
    if ((p.x - last.x) ** 2 + (p.y - last.y) ** 2 < 4) return;
    points.push(p);
    redraw();
  });

  function endStroke() {
    if (!drawing) return;
    drawing = false;
    if (points.length < 2) {
      points = [];
      return;
    }
    finished = true;
    enterBtn.disabled = false;
    redrawBtn.disabled = false;
  }

  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('pointerleave', endStroke);

  redrawBtn.addEventListener('click', reset);
  enterBtn.addEventListener('click', () => {
    if (!finished) return;
    onEnter(canvas);
  });

  reset();
}
