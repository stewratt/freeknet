interface SetupDrawingOpts {
  onEnter: (canvas: HTMLCanvasElement) => void;
}

interface Point {
  x: number;
  y: number;
}

export interface DoodlePadOpts {
  onFinishedChange?: (finished: boolean) => void;
}

export interface DoodlePad {
  readonly canvas: HTMLCanvasElement;
  reset(): void;
  isFinished(): boolean;
  toDataURL(): string;
  /** show an existing doodle (e.g. a saved rover); cleared on next stroke. */
  setBackground(dataUrl: string): void;
}

// the single-stroke doodle pad: click, draw one continuous line, release.
// used by the entry "draw yourself" phase and by the rover profile panel.
export function createDoodlePad(
  canvas: HTMLCanvasElement,
  { onFinishedChange }: DoodlePadOpts = {},
): DoodlePad {
  const ctx = canvas.getContext('2d')!;

  let drawing = false;
  let finished = false;
  let points: Point[] = [];

  function clear(): void {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function setupStroke(): void {
    ctx.strokeStyle = '#111111';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  function setFinished(f: boolean): void {
    if (finished === f) return;
    finished = f;
    onFinishedChange?.(f);
  }

  function reset(): void {
    drawing = false;
    points = [];
    clear();
    setupStroke();
    setFinished(false);
  }

  function getPos(e: PointerEvent): Point {
    const r = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * canvas.width,
      y: ((e.clientY - r.top) / r.height) * canvas.height,
    };
  }

  function redraw(): void {
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

  function endStroke(): void {
    if (!drawing) return;
    drawing = false;
    if (points.length < 2) {
      points = [];
      return;
    }
    setFinished(true);
  }

  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('pointerleave', endStroke);

  reset();

  return {
    canvas,
    reset,
    isFinished: () => finished,
    toDataURL: () => canvas.toDataURL('image/png'),
    setBackground: (dataUrl: string) => {
      const img = new Image();
      img.addEventListener('load', () => {
        if (finished || drawing) return; // user already started over
        clear();
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      });
      img.src = dataUrl;
    },
  };
}

export function setupDrawing({ onEnter }: SetupDrawingOpts): void {
  const canvas = document.getElementById('draw-canvas') as HTMLCanvasElement;
  const enterBtn = document.getElementById('enter-btn') as HTMLButtonElement;
  const redrawBtn = document.getElementById('redraw-btn') as HTMLButtonElement;

  const pad = createDoodlePad(canvas, {
    onFinishedChange: (finished) => {
      enterBtn.disabled = !finished;
      redrawBtn.disabled = !finished;
    },
  });

  redrawBtn.addEventListener('click', () => pad.reset());
  enterBtn.addEventListener('click', () => {
    if (!pad.isFinished()) return;
    onEnter(canvas);
  });
}
