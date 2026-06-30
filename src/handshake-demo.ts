// the two-agent handshake demo (handshake.html). a focused cousin of the batch
// dev page: author exactly two explorers inline, then watch a single live
// handshake play out as a cascade of chat bubbles between two facing doodles.
// the conversation streams from the server one line at a time; each turn adds a
// new bubble (A on the left, B on the right) that stays as visible history.

import { api, streamHandshake, type HandshakeDemo, type RoverUpdate, type Tester } from './api';
import { createDoodlePad } from './drawing';

const root = document.getElementById('root') as HTMLDivElement;

let state: HandshakeDemo | null = null;
let running = false;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const c of children) node.append(c);
  return node;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function init(): Promise<void> {
  const res = await api.devHandshakeProfiles();
  if (!res.ok || !res.data) {
    root.replaceChildren(
      el('div', { className: 'notice' }, [
        res.status === 404
          ? 'Dev tools are disabled. Start the server with FREEKNET_DEV_TOOLS=1 to use this page.'
          : `Could not reach the dev API (${res.error ?? res.status}).`,
      ]),
    );
    return;
  }
  state = res.data;
  render();
}

// the two flanking doodles, captured per render so the run loop can flag who is
// speaking and who is thinking.
interface Side {
  actor: HTMLDivElement;
  thinking: HTMLDivElement;
}

function render(): void {
  if (!state) return;

  const bar = el('div', { className: 'bar' }, [
    el('span', {
      className: `pill ${state.mock ? 'warn' : 'ok'}`,
      textContent: state.mock ? 'mock mode (no real tokens)' : 'live LLM calls',
    }),
    el('span', {
      className: `pill ${state.testKeyConfigured ? 'ok' : 'warn'}`,
      textContent: state.testKeyConfigured ? 'shared key ready' : 'no FREEKNET_TEST_API_KEY set',
    }),
  ]);

  const profiles = el('div', { className: 'profiles' }, [
    editorCard('left', state.a),
    editorCard('right', state.b),
  ]);

  // ---- the stage: doodleA | conversation cascade | doodleB ----
  const left = actor('left', state.a);
  const right = actor('right', state.b);
  const sides: Record<'a' | 'b', Side> = {
    a: { actor: left.actor, thinking: left.thinking },
    b: { actor: right.actor, thinking: right.thinking },
  };
  const cascade = el('div', { className: 'cascade' });

  const status = el('p', { className: 'msg' });
  const stats = el('div', { className: 'stats' });

  const ready = !!(state.a.rover?.drawing && state.b.rover?.drawing);
  const run = el('button', {
    className: 'primary',
    textContent: '▶ run the handshake',
    disabled: !ready,
    onclick: () => void runHandshake(sides, cascade, { run, status, stats }),
  });
  if (!ready) {
    status.textContent = 'Draw and save both explorers to begin.';
  }

  const stage = el('section', { className: 'stage' }, [
    el('div', { className: 'stage-controls' }, [el('h2', { textContent: 'the handshake' }), run]),
    el('div', { className: 'scene' }, [left.actor, cascade, right.actor]),
    status,
    el('div', { className: 'footer' }, [stats]),
  ]);

  root.replaceChildren(bar, profiles, stage);
}

// ---- profile editor (one of two) ------------------------------------------

function editorCard(side: 'left' | 'right', t: Tester): HTMLElement {
  const r = t.rover;
  const msg = el('p', { className: 'msg' });

  const canvas = el('canvas', { className: 'pad', width: 250, height: 375 });
  const pad = createDoodlePad(canvas);
  if (r?.drawing) pad.setBackground(r.drawing);

  const personality = el('textarea', {
    value: r?.personality ?? '',
    placeholder: 'personality',
    maxLength: 500,
  });
  const intentShort = el('input', {
    type: 'text',
    value: r?.intentShort ?? '',
    placeholder: 'wants right now',
    maxLength: 200,
  });
  const intentLong = el('input', {
    type: 'text',
    value: r?.intentLong ?? '',
    placeholder: 'long-term dream',
    maxLength: 200,
  });

  const model = el('select');
  for (const m of state!.allowedModels) {
    model.append(el('option', { value: m, textContent: m, selected: r?.model === m }));
  }

  const save = el('button', {
    className: 'primary',
    textContent: 'save explorer',
    onclick: async () => {
      if (running) return;
      const update: RoverUpdate = {
        personality: personality.value,
        intentShort: intentShort.value,
        intentLong: intentLong.value,
        model: model.value,
      };
      if (pad.isFinished()) update.drawing = pad.toDataURL();
      msg.className = 'msg';
      msg.textContent = 'saving…';
      const res = await api.devUpdateTester(t.id, update);
      if (!res.ok || !res.data) {
        msg.className = 'msg err';
        msg.textContent = res.error ?? 'save failed';
        return;
      }
      // fold the saved profile back into state and re-render so the scene shows
      // the doodle and the run button can enable.
      if (state) {
        if (side === 'left') state.a = res.data;
        else state.b = res.data;
      }
      render();
    },
  });
  const redraw = el('button', { textContent: 'redraw', onclick: () => pad.reset() });

  const fields = el('div', { className: 'fields' }, [
    el('label', { textContent: 'personality' }),
    personality,
    el('label', { textContent: 'wants right now' }),
    intentShort,
    el('label', { textContent: 'long-term dream' }),
    intentLong,
    el('label', { textContent: 'model' }),
    model,
  ]);

  return el('div', { className: `card ${side}` }, [
    el('h3', { textContent: side === 'left' ? 'explorer A' : 'explorer B' }),
    el('div', { className: 'pad-wrap' }, [canvas, fields]),
    el('div', { className: 'row' }, [save, redraw]),
    msg,
  ]);
}

// ---- one doodle flanking the conversation ----------------------------------

function actor(
  side: 'left' | 'right',
  t: Tester,
): { actor: HTMLDivElement; thinking: HTMLDivElement } {
  const thinking = el('div', { className: 'thinking', textContent: '•••' });

  let figure: HTMLElement;
  if (t.rover?.drawing) {
    figure = el('img', { src: t.rover.drawing, alt: t.username });
  } else {
    figure = el('div', { className: 'placeholder', textContent: 'not drawn yet' });
  }

  const node = el('div', { className: `actor ${side}` }, [
    figure,
    el('div', { className: 'nametag', textContent: t.username }),
    thinking,
  ]);
  return { actor: node, thinking };
}

// ---- the live run -----------------------------------------------------------

interface RunUi {
  run: HTMLButtonElement;
  status: HTMLParagraphElement;
  stats: HTMLDivElement;
}

// type a line into a bubble character-by-character, keeping the newest line in
// view as the cascade grows.
async function typeInto(bubble: HTMLElement, text: string, cascade: HTMLElement): Promise<void> {
  const span = el('span');
  const caret = el('span', { className: 'caret' });
  bubble.replaceChildren(span, caret);
  const per = Math.max(12, Math.min(42, 900 / Math.max(1, text.length)));
  for (let i = 1; i <= text.length; i++) {
    span.textContent = text.slice(0, i);
    cascade.scrollTop = cascade.scrollHeight;
    await sleep(per);
  }
  caret.remove();
}

async function runHandshake(
  sides: Record<'a' | 'b', Side>,
  cascade: HTMLElement,
  ui: RunUi,
): Promise<void> {
  if (running) return;
  running = true;
  ui.run.disabled = true;
  ui.status.className = 'msg';
  ui.status.textContent = state?.mock
    ? 'running… (mock mode — canned replies)'
    : 'running… (this spends tokens on the shared test key)';
  ui.stats.replaceChildren();
  cascade.replaceChildren();
  for (const s of [sides.a, sides.b]) {
    s.thinking.classList.remove('show');
    s.actor.classList.remove('speaking');
  }

  let activeBubble: HTMLElement | null = null;

  try {
    for await (const ev of streamHandshake()) {
      if (ev.type === 'start') {
        sides.b.thinking.classList.add('show'); // B muses while A opens
        continue;
      }
      if (ev.type === 'line') {
        const me = sides[ev.speaker];
        const you = sides[ev.speaker === 'a' ? 'b' : 'a'];
        me.actor.classList.add('speaking');
        me.thinking.classList.remove('show');
        you.actor.classList.remove('speaking');
        you.thinking.classList.add('show'); // the other one is forming a reply

        activeBubble?.classList.remove('active');
        const bubble = el('div', { className: 'cbubble active' });
        cascade.append(el('div', { className: `turn ${ev.speaker}` }, [bubble]));
        activeBubble = bubble;
        cascade.scrollTop = cascade.scrollHeight;

        const text = ev.text.replace(/^mockline:\s*/, '');
        await typeInto(bubble, text, cascade);
        continue;
      }
      if (ev.type === 'done') {
        activeBubble?.classList.remove('active');
        for (const s of [sides.a, sides.b]) {
          s.actor.classList.remove('speaking');
          s.thinking.classList.remove('show');
        }
        ui.status.textContent = '';
        renderStats(ui.stats, ev);
        continue;
      }
      if (ev.type === 'error') {
        ui.status.className = 'msg err';
        ui.status.textContent = ev.error;
      }
    }
  } catch (e) {
    ui.status.className = 'msg err';
    ui.status.textContent = (e as Error).message ?? 'handshake failed';
  } finally {
    activeBubble?.classList.remove('active');
    for (const s of [sides.a, sides.b]) s.thinking.classList.remove('show');
    running = false;
    ui.run.disabled = false;
  }
}

function renderStats(
  container: HTMLDivElement,
  ev: { status: string; turns: number; totalTokens: number; estCostUsd: number },
): void {
  const stat = (value: string, label: string) =>
    el('div', { className: 'stat' }, [
      el('b', { textContent: value }),
      el('span', { textContent: label }),
    ]);
  container.replaceChildren(
    stat(String(ev.turns), 'turns'),
    stat(ev.totalTokens.toLocaleString(), 'tokens'),
    stat(`$${ev.estCostUsd.toFixed(4)}`, 'est. cost'),
    stat(ev.status, 'status'),
  );
}

void init();
