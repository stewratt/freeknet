// the rover profile panel: login/signup, rover doodle + persona editing,
// api key management, and handshake logs. a slide-in over the game, opened
// from the "my rover" hud button. all raw DOM, matching the rest of the ui.

import { api, type HandshakeLog, type Me } from './api';
import { createDoodlePad, type DoodlePad } from './drawing';

export interface RoverPanel {
  isOpen(): boolean;
}

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

export function setupRoverPanel(): RoverPanel {
  const panel = el<HTMLDivElement>('rover-panel');
  const openBtn = el<HTMLButtonElement>('rover-btn');
  const closeBtn = el<HTMLButtonElement>('rp-close');

  const authView = el<HTMLDivElement>('rp-auth');
  const mainView = el<HTMLDivElement>('rp-main');
  const usernameInput = el<HTMLInputElement>('rp-username');
  const passwordInput = el<HTMLInputElement>('rp-password');
  const authError = el<HTMLParagraphElement>('rp-auth-error');

  const roverCanvas = el<HTMLCanvasElement>('rover-canvas');
  const redrawBtn = el<HTMLButtonElement>('rp-redraw');
  const personalityInput = el<HTMLTextAreaElement>('rp-personality');
  const intentShortInput = el<HTMLInputElement>('rp-intent-short');
  const intentLongInput = el<HTMLInputElement>('rp-intent-long');
  const activeInput = el<HTMLInputElement>('rp-active');
  const saveBtn = el<HTMLButtonElement>('rp-save');
  const roverMsg = el<HTMLParagraphElement>('rp-rover-msg');

  const keyStatus = el<HTMLParagraphElement>('rp-key-status');
  const keyInput = el<HTMLInputElement>('rp-key-input');
  const keySaveBtn = el<HTMLButtonElement>('rp-key-save');
  const keyRemoveBtn = el<HTMLButtonElement>('rp-key-remove');
  const keyMsg = el<HTMLParagraphElement>('rp-key-msg');

  const logsList = el<HTMLDivElement>('rp-logs-list');
  const logsMore = el<HTMLButtonElement>('rp-logs-more');

  const userLabel = el<HTMLSpanElement>('rp-user');
  const logoutBtn = el<HTMLButtonElement>('rp-logout');

  let me: Me | null = null;
  let open = false;
  let drewNewDoodle = false;
  let oldestLogId: number | null = null;

  const pad: DoodlePad = createDoodlePad(roverCanvas, {
    onFinishedChange: (finished) => {
      drewNewDoodle = finished;
      redrawBtn.disabled = !finished;
    },
  });

  // ---- view state -----------------------------------------------------------

  function render(): void {
    authView.style.display = me ? 'none' : 'block';
    mainView.style.display = me ? 'block' : 'none';
    if (!me) return;
    userLabel.textContent = me.username;
    const rover = me.rover;
    personalityInput.value = rover?.personality ?? '';
    intentShortInput.value = rover?.intentShort ?? '';
    intentLongInput.value = rover?.intentLong ?? '';
    activeInput.checked = rover?.active ?? false;
    if (rover?.drawing && !drewNewDoodle) pad.setBackground(rover.drawing);

    if (me.keyError) {
      keyStatus.textContent =
        me.keyError === 'invalid'
          ? '⚠ openrouter rejected your key — paste a fresh one'
          : `⚠ key problem: ${me.keyError}`;
      keyStatus.className = 'rp-error';
    } else if (me.hasApiKey) {
      keyStatus.textContent = '✓ key set — your rover can handshake';
      keyStatus.className = 'rp-ok';
    } else {
      keyStatus.textContent = rover?.active
        ? 'your rover wanders, but needs an openrouter key to handshake'
        : 'no key yet — your rover needs one to talk';
      keyStatus.className = 'rp-hint';
    }
    keyRemoveBtn.style.display = me.hasApiKey ? '' : 'none';
  }

  function setMe(next: Me | null): void {
    me = next;
    render();
  }

  // ---- open/close -------------------------------------------------------------

  function show(): void {
    open = true;
    panel.classList.add('open');
    openBtn.style.display = 'none';
    if (!me) void refresh();
  }

  function hide(): void {
    open = false;
    panel.classList.remove('open');
    openBtn.style.display = '';
  }

  async function refresh(): Promise<void> {
    const res = await api.me();
    if (res.ok && res.data) {
      setMe(res.data);
      void loadLogs(true);
    } else {
      setMe(null);
    }
  }

  openBtn.addEventListener('click', show);
  closeBtn.addEventListener('click', hide);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open && !e.defaultPrevented) {
      e.preventDefault();
      hide();
    }
  });

  // ---- auth ----------------------------------------------------------------------

  async function doAuth(kind: 'login' | 'register'): Promise<void> {
    authError.textContent = '';
    const username = usernameInput.value.trim().toLowerCase();
    const password = passwordInput.value;
    const res =
      kind === 'login' ? await api.login(username, password) : await api.register(username, password);
    if (res.ok && res.data) {
      passwordInput.value = '';
      setMe(res.data);
      void loadLogs(true);
    } else {
      authError.textContent = res.error ?? 'something went wrong';
    }
  }

  el<HTMLButtonElement>('rp-login').addEventListener('click', () => void doAuth('login'));
  el<HTMLButtonElement>('rp-register').addEventListener('click', () => void doAuth('register'));
  passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void doAuth('login');
  });

  logoutBtn.addEventListener('click', async () => {
    await api.logout();
    setMe(null);
  });

  // ---- tabs --------------------------------------------------------------------

  const tabs = Array.from(panel.querySelectorAll<HTMLButtonElement>('.rp-tab'));
  const tabPanes: Record<string, HTMLElement> = {
    rover: el('rp-tab-rover'),
    key: el('rp-tab-key'),
    logs: el('rp-tab-logs'),
  };
  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      for (const t of tabs) t.classList.toggle('active', t === tab);
      for (const [name, pane] of Object.entries(tabPanes)) {
        pane.style.display = name === tab.dataset.tab ? 'block' : 'none';
      }
      if (tab.dataset.tab === 'logs') void loadLogs(true);
    });
  }

  // ---- rover tab -------------------------------------------------------------------

  redrawBtn.addEventListener('click', () => {
    pad.reset();
    drewNewDoodle = false;
  });

  saveBtn.addEventListener('click', async () => {
    roverMsg.textContent = '';
    roverMsg.className = 'rp-hint';
    const res = await api.saveRover({
      ...(drewNewDoodle ? { drawing: pad.toDataURL() } : {}),
      personality: personalityInput.value,
      intentShort: intentShortInput.value,
      intentLong: intentLongInput.value,
      active: activeInput.checked,
    });
    if (res.ok && res.data) {
      drewNewDoodle = false;
      redrawBtn.disabled = true;
      setMe(res.data);
      roverMsg.textContent = res.data.rover?.active
        ? '✓ saved — your rover is roaming'
        : '✓ saved';
      roverMsg.className = 'rp-ok';
    } else {
      roverMsg.textContent = res.error ?? 'save failed';
      roverMsg.className = 'rp-error';
    }
  });

  // ---- key tab ----------------------------------------------------------------------

  keySaveBtn.addEventListener('click', async () => {
    keyMsg.textContent = '';
    const apiKey = keyInput.value.trim();
    if (!apiKey) return;
    keySaveBtn.disabled = true;
    const res = await api.saveKey(apiKey);
    keySaveBtn.disabled = false;
    if (res.ok && res.data) {
      keyInput.value = '';
      setMe(res.data);
      keyMsg.textContent = '';
    } else {
      keyMsg.textContent = res.error ?? 'could not save key';
      keyMsg.className = 'rp-error';
    }
  });

  keyRemoveBtn.addEventListener('click', async () => {
    const res = await api.deleteKey();
    if (res.ok && res.data) setMe(res.data);
  });

  // ---- handshake logs -----------------------------------------------------------------

  function renderLog(log: HandshakeLog): HTMLElement {
    const item = document.createElement('details');
    item.className = 'rp-log';
    const date = new Date(log.startedAt).toLocaleDateString();
    const summary = document.createElement('summary');
    summary.textContent = `${date} — with ${log.partner}`;
    if (log.status !== 'done') summary.textContent += ` (${log.status})`;
    item.appendChild(summary);
    const body = document.createElement('div');
    body.className = 'rp-log-lines';
    for (const line of log.transcript) {
      const p = document.createElement('p');
      const ours = line.speaker === log.mine;
      p.className = ours ? 'rp-line rp-line-mine' : 'rp-line';
      p.textContent = line.text;
      body.appendChild(p);
    }
    if (log.transcript.length === 0) {
      const p = document.createElement('p');
      p.className = 'rp-hint';
      p.textContent = 'no words were exchanged.';
      body.appendChild(p);
    }
    item.appendChild(body);
    return item;
  }

  async function loadLogs(fresh: boolean): Promise<void> {
    if (!me) return;
    if (fresh) {
      oldestLogId = null;
      logsList.textContent = '';
    }
    const res = await api.handshakes(oldestLogId ?? undefined);
    if (!res.ok || !res.data) return;
    const logs = res.data.handshakes;
    if (fresh && logs.length === 0) {
      const p = document.createElement('p');
      p.className = 'rp-hint';
      p.textContent = 'no handshakes yet — once a day, your rover will find another rover and talk.';
      logsList.appendChild(p);
    }
    for (const log of logs) logsList.appendChild(renderLog(log));
    if (logs.length > 0) oldestLogId = logs[logs.length - 1].id;
    logsMore.style.display = logs.length === 20 ? '' : 'none';
  }

  logsMore.addEventListener('click', () => void loadLogs(false));

  // initial session probe so a returning user sees their rover immediately
  void refresh();

  return {
    isOpen: () => open,
  };
}
