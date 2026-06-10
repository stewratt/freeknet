// rover profile panel smoke test (puppeteer). drives the real ui: sign up,
// draw a rover doodle, save + activate, watch the rover join the world, and
// manage the api key. assumes `npm start` is running with FREEKNET_LLM_MOCK=1.

import type { Page } from 'puppeteer';
import { drawAndEnter, makeBrowser, makeRunner, sleep, snap } from './helpers';
import { newSession } from './helpers';

async function drawOnRoverCanvas(page: Page): Promise<void> {
  await page.evaluate(() => {
    const c = document.getElementById('rover-canvas') as HTMLCanvasElement;
    const r = c.getBoundingClientRect();
    function ev(type: string, x: number, y: number): void {
      c.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 1,
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          pointerType: 'mouse',
          button: 0,
          buttons: type === 'pointerup' ? 0 : 1,
        }),
      );
    }
    const x0 = r.left + 20;
    const y0 = r.top + 20;
    const x1 = r.left + r.width - 20;
    const y1 = r.top + r.height - 20;
    ev('pointerdown', x0, y0);
    for (let t = 1; t <= 25; t++) {
      ev('pointermove', x0 + ((x1 - x0) * t) / 25, y0 + ((y1 - y0) * t) / 25);
    }
    ev('pointerup', x1, y1);
  });
}

async function click(page: Page, id: string): Promise<void> {
  await page.evaluate((elId) => (document.getElementById(elId) as HTMLElement).click(), id);
}

async function typeInto(page: Page, id: string, value: string): Promise<void> {
  await page.evaluate(
    (elId, v) => {
      const input = document.getElementById(elId) as HTMLInputElement;
      input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    id,
    value,
  );
}

async function text(page: Page, id: string): Promise<string> {
  return await page.evaluate(
    (elId) => (document.getElementById(elId) as HTMLElement).textContent ?? '',
    id,
  );
}

async function visible(page: Page, id: string): Promise<boolean> {
  return await page.evaluate((elId) => {
    const node = document.getElementById(elId);
    return !!node && getComputedStyle(node).display !== 'none';
  }, id);
}

async function main(): Promise<void> {
  const r = makeRunner();
  const browser = await makeBrowser();
  const username = `ui_${Date.now().toString(36)}`;
  const password = 'hunter22hunter22';

  try {
    const { page, errors } = await newSession(browser, 'ui');
    await drawAndEnter(page, 'V');

    // the dev db may hold rovers from earlier runs; assert against the delta
    const baseRovers = ((await snap(page)).remotes ?? []).filter((rp) => rp.isRover).length;

    await r.test('panel opens from the hud button', async () => {
      r.expect(await visible(page, 'rover-btn'), 'rover button visible in game phase');
      await click(page, 'rover-btn');
      await sleep(300);
      const isOpen = await page.evaluate(() => window.__game!.roverPanel.isOpen());
      r.expect(isOpen, 'panel reports open');
      r.expect(await visible(page, 'rp-auth'), 'login form shows when logged out');
      r.pass('panel opens to auth view');
    });

    await r.test('sign up from the panel', async () => {
      await typeInto(page, 'rp-username', username);
      await typeInto(page, 'rp-password', password);
      await click(page, 'rp-register');
      await sleep(600);
      r.expect(await visible(page, 'rp-main'), 'main view appears after signup');
      r.expect((await text(page, 'rp-user')) === username, 'username shown in footer');
      r.pass('account created via ui');
    });

    await r.test('movement keys are suppressed while the panel is open', async () => {
      const before = await snap(page);
      await page.keyboard.down('KeyW');
      await sleep(500);
      await page.keyboard.up('KeyW');
      const after = await snap(page);
      const moved = Math.hypot(after.localX! - before.localX!, after.localZ! - before.localZ!);
      r.expect(moved < 0.2, `player did not walk while panel open (moved ${moved.toFixed(2)}u)`);
      r.pass('wasd suppressed');
    });

    await r.test('draw, save, and activate the rover', async () => {
      await drawOnRoverCanvas(page);
      await sleep(200);
      await page.evaluate(() => {
        (document.getElementById('rp-personality') as HTMLTextAreaElement).value =
          'a zigzag who collects sunsets';
        (document.getElementById('rp-intent-short') as HTMLInputElement).value = 'find a good hill';
        (document.getElementById('rp-active') as HTMLInputElement).checked = true;
      });
      await click(page, 'rp-save');
      await sleep(800);
      const msg = await text(page, 'rp-rover-msg');
      r.expect(msg.includes('roaming'), `save confirms roaming (got "${msg}")`);
      r.pass('rover saved + activated');
    });

    await r.test('the rover joins this world within ~2s', async () => {
      await sleep(2000);
      const s = await snap(page);
      const rovers = (s.remotes ?? []).filter((remote) => remote.isRover);
      r.expect(
        rovers.length === baseRovers + 1,
        `one new rover in world (got ${rovers.length}, base ${baseRovers})`,
      );
      r.expect(
        rovers.every((rp) => rp.hasAvatar),
        'rover avatar meshes built from doodles',
      );
      r.pass('rover walks among us');
    });

    await r.test('deactivating removes the rover from the world', async () => {
      await page.evaluate(() => {
        (document.getElementById('rp-active') as HTMLInputElement).checked = false;
      });
      await click(page, 'rp-save');
      await sleep(1500);
      const s = await snap(page);
      const rovers = (s.remotes ?? []).filter((remote) => remote.isRover);
      r.expect(
        rovers.length === baseRovers,
        `rover despawned (got ${rovers.length}, base ${baseRovers})`,
      );
      r.pass('toggle works live');
    });

    await r.test('api key stored but never echoed', async () => {
      await page.evaluate(() => {
        (document.querySelector('[data-tab="key"]') as HTMLElement).click();
      });
      await typeInto(page, 'rp-key-input', 'sk-or-uitest-9876');
      await click(page, 'rp-key-save');
      await sleep(600);
      const status = await text(page, 'rp-key-status');
      r.expect(status.includes('✓'), `key status confirms (got "${status}")`);
      const inputVal = await page.evaluate(
        () => (document.getElementById('rp-key-input') as HTMLInputElement).value,
      );
      r.expect(inputVal === '', 'key input cleared after save');
      const bodyHtml = await page.evaluate(() => document.body.innerHTML);
      r.expect(!bodyHtml.includes('sk-or-uitest'), 'key text nowhere in the dom');
      r.pass('key flow safe');
    });

    await r.test('session survives a reload', async () => {
      const me = await page.evaluate(async () => {
        const res = await fetch('/api/me');
        return await res.json();
      });
      r.expect(me.username === username, 'cookie session resolves to our user');
      r.expect(me.rover?.personality === 'a zigzag who collects sunsets', 'rover persisted');
      r.pass('persistence verified');
    });

    await r.test('no page errors', async () => {
      r.expect(errors.length === 0, `clean console (got: ${errors.join(' | ')})`);
      r.pass('clean');
    });
  } catch (e) {
    console.error('fatal:', e);
    await browser.close();
    process.exit(1);
  }

  await browser.close();
  process.exit(r.summary() ? 0 : 1);
}

main();
