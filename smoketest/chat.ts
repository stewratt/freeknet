// chat input flows: T-to-focus, click-to-focus, Escape cancels, WASD blocked
// while typing, and that consecutive messages REPLACE rather than stack.

import {
  makeBrowser, newSession, drawAndEnter, sleep,
  chatCounts, inputState, currentBubble, makeRunner,
} from './helpers';

const browser = await makeBrowser();
const { test, fail, pass, summary } = makeRunner();

try {
  const A = await newSession(browser, 'A');
  await drawAndEnter(A.page);
  const B = await newSession(browser, 'B');
  await drawAndEnter(B.page);
  await sleep(1000);

  await test('flow A: T → type → Enter clears input and shows bubble', async () => {
    await A.page.bringToFront();
    await A.page.keyboard.press('KeyT');
    await sleep(200);
    await A.page.keyboard.type('first message');
    await A.page.keyboard.press('Enter');
    await sleep(600);
    const s = await inputState(A.page);
    if (s.value !== '') fail(`input not cleared: ${JSON.stringify(s.value)}`);
    else pass('input cleared');
    const c = await chatCounts(A.page);
    if (c.bubbleCount !== 1) fail(`A bubbleCount=${c.bubbleCount}, want 1`);
    else pass('A has own bubble');
  });

  await test('B sees the bubble', async () => {
    await B.page.bringToFront();
    await sleep(600);
    const c = await chatCounts(B.page);
    if (c.bubbleCount !== 1) fail(`B bubbleCount=${c.bubbleCount}, want 1`);
    else pass('B sees A bubble');
  });

  await test('second message REPLACES first (no stacking)', async () => {
    await A.page.bringToFront();
    await A.page.keyboard.press('KeyT');
    await sleep(200);
    await A.page.keyboard.type('second message');
    await A.page.keyboard.press('Enter');
    await sleep(600);
    const c = await chatCounts(A.page);
    if (c.bubbleCount !== 1) fail(`A bubbleCount=${c.bubbleCount} after second send, want 1`);
    else pass('A still has 1 bubble after second send');
    const b = await currentBubble(A.page);
    if (b?.text !== 'second message') fail(`current bubble text=${b?.text}`);
    else pass('current bubble is the second message');
  });

  await test('flow B: click input, type, Enter', async () => {
    await A.page.bringToFront();
    const handle = await A.page.$('#chat-input');
    const box = await handle?.boundingBox();
    if (!box) { fail('chat-input has no bounding box'); return; }
    await A.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(200);
    await A.page.keyboard.type('clicked then typed');
    await A.page.keyboard.press('Enter');
    await sleep(600);
    const s = await inputState(A.page);
    if (s.value !== '') fail(`input not cleared after click flow`);
    else pass('cleared after click flow');
    const b = await currentBubble(A.page);
    if (b?.text !== 'clicked then typed') fail(`wrong bubble text: ${b?.text}`);
    else pass(`bubble: "${b.text}"`);
    if (!b || b.fillOpacity == null || b.fillOpacity <= 0) {
      fail(`fillOpacity=${b?.fillOpacity}`);
    } else {
      pass(`fillOpacity=${b.fillOpacity}`);
    }
  });

  await test('flow C: Escape cancels and clears input', async () => {
    await A.page.keyboard.press('KeyT');
    await sleep(150);
    await A.page.keyboard.type('to be cancelled');
    await A.page.keyboard.press('Escape');
    await sleep(200);
    const s = await inputState(A.page);
    if (s.value !== '') fail(`Esc did not clear: ${JSON.stringify(s.value)}`);
    else pass('Esc cleared the value');
    if (s.activeId === 'chat-input') fail(`Esc did not blur (active=${s.activeId})`);
    else pass(`focus moved away (active=${s.activeId})`);
  });

  await test('flow D: WASD does nothing while typing', async () => {
    const startZ = await A.page.evaluate(() => window.__game!.local.position.z);
    await A.page.keyboard.press('KeyT');
    await sleep(100);
    await A.page.keyboard.down('KeyW');
    await sleep(800);
    await A.page.keyboard.up('KeyW');
    const endZ = await A.page.evaluate(() => window.__game!.local.position.z);
    if (Math.abs(endZ - startZ) > 0.3) {
      fail(`player moved while typing: startZ=${startZ} endZ=${endZ}`);
    } else {
      pass(`player stayed put (Δz=${(endZ - startZ).toFixed(2)})`);
    }
    // close the input so trailing keystrokes don't interfere
    await A.page.keyboard.press('Escape');
  });

  await test('no page errors', async () => {
    for (const [label, errors] of [['A', A.errors] as const, ['B', B.errors] as const]) {
      if (errors.length) {
        for (const e of errors) fail(e);
      } else {
        pass(`${label} clean`);
      }
    }
  });
} catch (e) {
  console.error("smoke setup crashed:", e);
  process.exitCode = 1;
} finally {
  const ok = summary();
  await browser.close();
  process.exit(ok ? 0 : 1);
}
