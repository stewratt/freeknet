// shared helpers for the smoke tests. cross-platform: uses bundled chromium
// from `puppeteer` (not puppeteer-core), so no executablePath is needed.

import puppeteer, { Browser, Page } from 'puppeteer';

const BASE_URL = process.env.SMOKE_URL ?? 'http://localhost:5173/';

export async function makeBrowser(): Promise<Browser> {
  return puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      // headless chromium on macOS arm64 fails with --use-gl=swiftshader; try
      // a few flags that have worked in practice. on linux CI swiftshader is
      // usually the right choice.
      '--enable-unsafe-swiftshader',
      '--use-angle=swiftshader',
      '--ignore-gpu-blocklist',
      '--enable-webgl',
    ],
  });
}

export interface Session {
  page: Page;
  errors: string[];
}

export async function newSession(browser: Browser, label = ''): Promise<Session> {
  const page = await browser.newPage();
  // esbuild (via tsx) injects a __name() helper into transpiled functions to
  // preserve class.name / function.name. when we pass those functions to
  // page.evaluate(), they get serialized and run inside the browser where
  // __name is undefined. polyfill it as a no-op so our evaluate() calls work.
  await page.evaluateOnNewDocument(`
    if (typeof __name === 'undefined') {
      window.__name = (fn) => fn;
    }
  `);
  await page.setViewport({ width: 1024, height: 768 });
  const errors: string[] = [];
  const prefix = label ? `${label} ` : '';
  page.on('pageerror', (err) => errors.push(`${prefix}PAGE ERROR: ${err.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (t.includes('favicon') || t.includes('404')) return;
    errors.push(`${prefix}CONSOLE: ${t}`);
  });
  await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 15000 });
  await sleep(800);
  return { page, errors };
}

export async function drawAndEnter(page: Page, shape: 'V' | 'line' = 'line'): Promise<void> {
  await page.evaluate((shape) => {
    const c = document.getElementById('draw-canvas') as HTMLCanvasElement;
    const r = c.getBoundingClientRect();
    function ev(type: string, x: number, y: number): void {
      c.dispatchEvent(new PointerEvent(type, {
        pointerId: 1, bubbles: true, cancelable: true,
        clientX: x, clientY: y, pointerType: 'mouse',
        button: 0, buttons: type === 'pointerup' ? 0 : 1,
      }));
    }
    const pts: Array<[number, number]> = shape === 'V'
      ? [[100, 50], [r.width / 2, r.height - 50], [r.width - 100, 50]]
      : [[r.width / 2, 50], [r.width / 2, r.height - 50]];
    const abs: Array<[number, number]> = pts.map(([x, y]) => [r.left + x, r.top + y]);
    ev('pointerdown', abs[0][0], abs[0][1]);
    for (let i = 0; i < abs.length - 1; i++) {
      const [x1, y1] = abs[i];
      const [x2, y2] = abs[i + 1];
      for (let t = 1; t <= 20; t++) {
        ev('pointermove', x1 + (x2 - x1) * (t / 20), y1 + (y2 - y1) * (t / 20));
      }
    }
    const last = abs[abs.length - 1];
    ev('pointerup', last[0], last[1]);
  }, shape);
  await page.evaluate(() => (document.getElementById('enter-btn') as HTMLElement).click());
  await sleep(1500);
}

// shape of the snapshot we extract from window.__game; not exhaustive, just
// the fields the tests look at.
export interface RemoteSnap {
  id: string;
  x: number;
  y: number;
  z: number;
  bufLen: number;
  bufLastZ: number | null;
  hasAvatar: boolean;
}

export interface GameSnap {
  ready: boolean;
  myId?: string;
  connected?: boolean;
  localX?: number;
  localY?: number;
  localZ?: number;
  renderCalls?: number;
  remoteCount?: number;
  remotes?: RemoteSnap[];
  chatMsgCount?: number;
}

export async function snap(page: Page): Promise<GameSnap> {
  return await page.evaluate(() => {
    const g = window.__game;
    if (!g) return { ready: false };
    const remotes = [];
    for (const [id, rp] of g.remotes) {
      // `rp.buffer` is private to RemotePlayer; access via index-signature cast
      // since smoke tests inspect more than the public surface.
      const buf = (rp as unknown as { buffer: Array<{ z?: number }> }).buffer;
      const last = buf[buf.length - 1] || {};
      remotes.push({
        id: id.slice(0, 8),
        x: +rp.position.x.toFixed(2),
        y: +(rp.position.y ?? 0).toFixed(2),
        z: +rp.position.z.toFixed(2),
        bufLen: buf.length,
        bufLastZ: last.z != null ? +last.z.toFixed(2) : null,
        hasAvatar: !!rp.avatar,
      });
    }
    return {
      ready: true,
      myId: g.network.id?.slice(0, 8),
      connected: g.network.connected,
      localX: +g.local.position.x.toFixed(2),
      localY: +(g.local.position.y ?? 0).toFixed(2),
      localZ: +g.local.position.z.toFixed(2),
      renderCalls: g.renderer.info.render.frame,
      remoteCount: g.remotes.size,
      remotes,
      chatMsgCount: g.chat.messages.length,
    };
  });
}

export interface ChatCounts {
  bubbleCount: number;
  msgCount: number;
}

export async function chatCounts(page: Page): Promise<ChatCounts> {
  return await page.evaluate(() => {
    const g = window.__game!;
    return {
      bubbleCount: g.chat.bubbles.size,
      msgCount: g.chat.messages.length,
    };
  });
}

export interface InputSnap {
  value: string;
  activeId: string | undefined;
}

export async function inputState(page: Page): Promise<InputSnap> {
  return await page.evaluate(() => ({
    value: (document.getElementById('chat-input') as HTMLInputElement).value,
    activeId: (document.activeElement as HTMLElement | null)?.id,
  }));
}

export interface BubbleSnap {
  text: string;
  fillOpacity: number;
  outlineOpacity: number;
  visible: boolean;
  age: number;
}

export async function currentBubble(page: Page): Promise<BubbleSnap | null> {
  return await page.evaluate(() => {
    const b = Array.from(window.__game!.chat.bubbles.values())[0];
    if (!b) return null;
    // accessing troika Text's internal fields by name; cast loosely so the
    // smoke test isn't coupled to the strict ChatManager types.
    const t = b.text as unknown as {
      text: string;
      fillOpacity: number;
      outlineOpacity: number;
      visible: boolean;
    };
    return {
      text: t.text,
      fillOpacity: t.fillOpacity,
      outlineOpacity: t.outlineOpacity,
      visible: t.visible,
      age: +b.age.toFixed(2),
    };
  });
}

export async function pressKey(page: Page, key: string, durationMs = 600): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.keyboard.down(key as any);
  await sleep(durationMs);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.keyboard.up(key as any);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// minimal reporter: tracks pass/fail per test, prints a summary, exits 1 on
// any failure. each test is `test(name, async () => { ... })`. assertions use
// throws.
interface TestResult {
  name: string;
  fails: string[];
}

export interface Runner {
  test: (name: string, fn: () => Promise<void> | void) => Promise<void>;
  expect: (cond: boolean, msg: string) => void;
  fail: (msg: string) => void;
  pass: (msg: string) => void;
  summary: () => boolean;
}

export function makeRunner(): Runner {
  const results: TestResult[] = [];
  let current: TestResult | null = null;

  async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    current = { name, fails: [] };
    process.stdout.write(`\n── ${name} ──\n`);
    try {
      await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      current.fails.push(msg);
    }
    results.push(current);
    current = null;
  }

  function expect(cond: boolean, msg: string): void {
    if (!cond) {
      throw new Error(msg);
    }
  }

  function fail(msg: string): void {
    if (!current) throw new Error(`fail() called outside a test: ${msg}`);
    current.fails.push(msg);
    console.error(`  ✗ ${msg}`);
  }

  function pass(msg: string): void {
    console.log(`  ✓ ${msg}`);
  }

  function summary(): boolean {
    const failed = results.filter((r) => r.fails.length > 0);
    console.log('\n────────');
    for (const r of results) {
      const mark = r.fails.length ? '✗' : '✓';
      console.log(`  ${mark} ${r.name}`);
      for (const f of r.fails) console.log(`      ${f}`);
    }
    console.log(`\n${failed.length === 0 ? '✅ PASS' : `❌ FAIL (${failed.length}/${results.length})`}`);
    return failed.length === 0;
  }

  return { test, expect, fail, pass, summary };
}
