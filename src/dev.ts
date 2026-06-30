// the test-corpus dev page (dev.html). lists synthetic rovers, lets you draw
// them by hand and edit their bios, then runs a batch simulation and shows the
// transcripts + token/cost report. talks only to /api/dev/*, which the server
// mounts when FREEKNET_DEV_TOOLS=1.

import {
  api,
  type DevTesters,
  type ExplorerImportRow,
  type RoverUpdate,
  type SimReport,
  type Tester,
} from './api';
import { createDoodlePad } from './drawing';

const root = document.getElementById('root') as HTMLDivElement;

// a one-shot banner shown at the top of the next render (e.g. import results),
// then cleared so it doesn't stick around across refreshes.
let flash: { text: string; kind: 'ok' | 'warn' | 'err' } | null = null;

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

let state: DevTesters | null = null;

async function init(): Promise<void> {
  const res = await api.devTesters();
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

function render(): void {
  if (!state) return;

  // hidden file picker that drives the batch import
  const fileInput = el('input', { type: 'file', accept: '.json,application/json' });
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = ''; // allow re-importing the same filename
    if (file) await importExplorers(file);
  });

  const bar = el('div', { className: 'bar' }, [
    el('button', { className: 'primary', textContent: '+ add test subject', onclick: addTester }),
    el('button', { textContent: '↑ import JSON', onclick: () => fileInput.click() }),
    el('button', { textContent: '↓ template', onclick: downloadTemplate }),
    fileInput,
    el('span', {
      className: `pill ${state.mock ? 'warn' : 'ok'}`,
      textContent: state.mock ? 'mock mode (no real tokens)' : 'live LLM calls',
    }),
    el('span', {
      className: `pill ${state.testKeyConfigured ? 'ok' : 'warn'}`,
      textContent: state.testKeyConfigured
        ? 'shared key ready'
        : 'no FREEKNET_TEST_API_KEY set',
    }),
    el('span', { className: 'pill', textContent: `${state.testers.length} subjects` }),
  ]);

  const banner = flash
    ? el('p', { className: `msg ${flash.kind === 'ok' ? 'ok' : 'err'}`, textContent: flash.text })
    : null;
  flash = null; // one-shot

  const grid = el('div', { className: 'grid' });
  if (state.testers.length === 0) {
    grid.append(
      el('p', { className: 'sub', textContent: 'No test subjects yet. Add one to get started.' }),
    );
  }
  for (const t of state.testers) grid.append(testerCard(t));

  root.replaceChildren(...(banner ? [bar, banner] : [bar]), grid, simSection());
}

// download a ready-to-fill JSON file in the exact shape the import accepts.
function downloadTemplate(): void {
  const sample: ExplorerImportRow[] = [
    {
      username: 'ada',
      personality: 'a curious cartographer who narrates everything she sees',
      intentShort: 'find the tallest hill to get a view of the valley',
      intentLong: 'chart every corner of this world',
      model: state?.allowedModels[0],
    },
    {
      personality: 'a shy collector of shiny pebbles, speaks in short sentences',
      intentShort: 'find one perfect round stone',
      intentLong: 'build a little cairn that others will notice',
    },
  ];
  const blob = new Blob([JSON.stringify(sample, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: 'explorers-template.json' });
  a.click();
  URL.revokeObjectURL(url);
}

// read a JSON file, batch-create the explorers, then refresh with a summary.
async function importExplorers(file: File): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch (e) {
    flash = { text: `Could not parse ${file.name}: ${(e as Error).message}`, kind: 'err' };
    render();
    return;
  }
  const payload = parsed as ExplorerImportRow[] | { explorers: ExplorerImportRow[] };
  const res = await api.devImportTesters(payload);
  if (!res.ok || !res.data) {
    flash = { text: res.error ?? 'import failed', kind: 'err' };
    render();
    return;
  }
  const { created, failed, errors } = res.data;
  if (failed > 0) {
    const detail = errors
      .slice(0, 8)
      .map((e) => `row ${e.row}: ${e.error}`)
      .join('  •  ');
    const more = errors.length > 8 ? `  •  …${errors.length - 8} more` : '';
    flash = { text: `Imported ${created}, skipped ${failed} — ${detail}${more}`, kind: 'err' };
  } else {
    flash = { text: `Imported ${created} explorer${created === 1 ? '' : 's'}.`, kind: 'ok' };
  }
  await init();
}

async function addTester(): Promise<void> {
  const res = await api.devCreateTester();
  if (res.ok) await init();
}

function testerCard(t: Tester): HTMLElement {
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

  const active = el('input', { type: 'checkbox', checked: !!r?.active });

  const save = el('button', {
    className: 'primary',
    textContent: 'save',
    onclick: async () => {
      const update: RoverUpdate = {
        personality: personality.value,
        intentShort: intentShort.value,
        intentLong: intentLong.value,
        model: model.value,
        active: active.checked,
      };
      if (pad.isFinished()) update.drawing = pad.toDataURL();
      msg.className = 'msg';
      msg.textContent = 'saving…';
      const res = await api.devUpdateTester(t.id, update);
      if (res.ok) {
        msg.className = 'msg ok';
        msg.textContent = 'saved';
        t.rover = res.data!.rover;
      } else {
        msg.className = 'msg err';
        msg.textContent = res.error ?? 'save failed';
        active.checked = !!t.rover?.active; // revert the toggle on failure
      }
    },
  });

  const redraw = el('button', { textContent: 'redraw', onclick: () => pad.reset() });
  const del = el('button', {
    className: 'danger',
    textContent: 'delete',
    onclick: async () => {
      if (!confirm(`Delete ${t.username}?`)) return;
      const res = await api.devDeleteTester(t.id);
      if (res.ok) await init();
    },
  });

  return el('div', { className: 'card' }, [
    el('h3', { textContent: t.username }),
    el('div', { className: 'pad-wrap' }, [
      canvas,
      el('div', { className: 'fields' }, [
        el('label', { textContent: 'personality' }),
        personality,
        el('label', { textContent: 'wants right now' }),
        intentShort,
        el('label', { textContent: 'long-term dream' }),
        intentLong,
        el('label', { textContent: 'model' }),
        model,
      ]),
    ]),
    el('div', { className: 'row' }, [active, el('label', { textContent: 'active' })]),
    el('div', { className: 'row' }, [save, redraw, del]),
    msg,
  ]);
}

function simSection(): HTMLElement {
  const pairs = el('input', { type: 'number', min: '1', placeholder: 'auto' });
  const budget = el('input', { type: 'number', min: '1', placeholder: 'none' });
  const concurrency = el('input', { type: 'number', min: '1', value: '3' });
  const out = el('div');
  const status = el('p', { className: 'msg' });

  const run = el('button', {
    className: 'primary',
    textContent: 'run simulation',
    onclick: async () => {
      run.disabled = true;
      status.className = 'msg';
      status.textContent = 'running… (this spends tokens unless in mock mode)';
      const numOf = (i: HTMLInputElement) => (i.value ? Number(i.value) : undefined);
      const res = await api.devSimulate({
        pairs: numOf(pairs),
        tokenBudget: numOf(budget),
        concurrency: numOf(concurrency),
      });
      run.disabled = false;
      if (!res.ok || !res.data) {
        status.className = 'msg err';
        status.textContent = res.error ?? 'simulation failed';
        return;
      }
      status.textContent = '';
      out.replaceChildren(renderReport(res.data));
    },
  });

  const field = (labelText: string, input: HTMLElement) =>
    el('div', { className: 'field' }, [el('label', { textContent: labelText }), input]);

  return el('section', { className: 'sim' }, [
    el('h2', { textContent: 'batch simulation' }),
    el('div', { className: 'sim-controls' }, [
      field('pairs', pairs),
      field('token budget', budget),
      field('concurrency', concurrency),
      run,
    ]),
    status,
    out,
  ]);
}

function renderReport(rep: SimReport): HTMLElement {
  const stat = (value: string, label: string) =>
    el('div', { className: 'stat' }, [
      el('b', { textContent: value }),
      el('span', { textContent: label }),
    ]);

  const stats = el('div', { className: 'stats' }, [
    stat(String(rep.pairsRun), 'handshakes'),
    stat(String(rep.turnsTotal), 'turns'),
    stat(rep.totalTokens.toLocaleString(), 'total tokens'),
    stat(`$${rep.estCostUsd.toFixed(4)}`, 'est. cost'),
    stat(rep.stoppedEarly ? 'yes' : 'no', 'hit budget'),
  ]);

  const lines: string[] = [];
  lines.push(`run ${rep.runId} — ${rep.candidates} candidates`);
  lines.push(
    `tokens: ${rep.promptTokens} prompt + ${rep.completionTokens} completion = ${rep.totalTokens}`,
  );
  for (const [m, b] of Object.entries(rep.perModel)) {
    lines.push(`  ${m}: ~${b.tokens} tok, ~$${b.estCostUsd.toFixed(4)}`);
  }
  lines.push('');
  for (const c of rep.conversations) {
    lines.push(`── ${c.a} ↔ ${c.b}  [${c.status}, ${c.turns} turns]${c.error ? ` ⚠ ${c.error}` : ''}`);
    for (const line of c.transcript) {
      lines.push(`   ${line.speaker === 'a' ? c.a : c.b}: ${line.text}`);
    }
    lines.push('');
  }

  return el('div', {}, [stats, el('div', { className: 'report', textContent: lines.join('\n') })]);
}

void init();
