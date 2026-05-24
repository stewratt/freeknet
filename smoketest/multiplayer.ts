// two clients join, see each other, A walks and B observes the movement,
// A chats and B receives it.

import {
  makeBrowser,
  newSession,
  drawAndEnter,
  snap,
  pressKey,
  sleep,
  makeRunner,
} from './helpers';

const browser = await makeBrowser();
const { test, fail, pass, summary } = makeRunner();

try {
  const A = await newSession(browser, 'A');
  await drawAndEnter(A.page, 'V');
  const B = await newSession(browser, 'B');
  await drawAndEnter(B.page, 'line');
  await sleep(1500);

  await test('A and B see each other after both joined', async () => {
    const a = await snap(A.page);
    const b = await snap(B.page);
    if (!a.ready) {
      fail('A game not ready (renderer init failed?)');
      return;
    }
    if (!b.ready) {
      fail('B game not ready (renderer init failed?)');
      return;
    }
    if (a.remoteCount !== 1) fail(`A sees ${a.remoteCount} remotes, want 1`);
    else pass('A sees 1 remote');
    if (b.remoteCount !== 1) fail(`B sees ${b.remoteCount} remotes, want 1`);
    else pass('B sees 1 remote');
    if (!a.remotes?.[0]?.hasAvatar) fail('A has no avatar for B yet');
    else pass('A has B avatar');
  });

  await test('A walks forward and B observes movement', async () => {
    await A.page.bringToFront();
    await pressKey(A.page, 'KeyW', 1500);
    await sleep(500);
    const aAfter = await snap(A.page);
    if (Math.abs(aAfter.localZ ?? 0) < 0.5) fail(`A barely moved (localZ=${aAfter.localZ})`);
    else pass(`A moved to z=${aAfter.localZ}`);

    await B.page.bringToFront();
    await sleep(800);
    const bSeeingA = await snap(B.page);
    const r0 = bSeeingA.remotes?.[0];
    const z = r0?.z ?? 0;
    const bz = r0?.bufLastZ ?? 0;
    if (Math.abs(z) < 0.3 && Math.abs(bz) < 0.3) {
      fail(`B has no updates for A: ${JSON.stringify(r0)}`);
    } else {
      pass(`B sees A at z=${z} (buffer last z=${bz})`);
    }
  });

  await test('A chats and B receives the message', async () => {
    await A.page.bringToFront();
    await A.page.keyboard.press('KeyT');
    await sleep(200);
    await A.page.keyboard.type('hello B');
    await A.page.keyboard.press('Enter');
    await sleep(800);
    const bAfter = await snap(B.page);
    if ((bAfter.chatMsgCount ?? 0) < 1)
      fail(`B did not receive chat (count=${bAfter.chatMsgCount})`);
    else pass(`B has ${bAfter.chatMsgCount} chat bubble(s)`);
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
  console.error('smoke setup crashed:', e);
  process.exitCode = 1;
} finally {
  const ok = summary();
  await browser.close();
  process.exit(ok ? 0 : 1);
}
