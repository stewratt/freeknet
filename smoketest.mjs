import puppeteer from 'puppeteer-core';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

function makeBrowser() {
  return puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=swiftshader'],
  });
}

async function newSession(browser, label) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 768 });
  const errors = [];
  page.on('pageerror', (err) => errors.push(`${label} PAGE ERROR: ${err.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') {
      const t = m.text();
      if (t.includes('favicon') || t.includes('404')) return;
      errors.push(`${label} CONSOLE: ${t}`);
    }
  });

  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle2', timeout: 15000 });
  await new Promise((r) => setTimeout(r, 800));
  return { page, errors };
}

async function drawAndEnter(page, shape) {
  await page.evaluate((shape) => {
    const c = document.getElementById('draw-canvas');
    const r = c.getBoundingClientRect();
    function ev(type, x, y) {
      c.dispatchEvent(new PointerEvent(type, {
        pointerId: 1, bubbles: true, cancelable: true,
        clientX: x, clientY: y, pointerType: 'mouse',
        button: 0, buttons: type === 'pointerup' ? 0 : 1,
      }));
    }
    const pts = shape === 'V'
      ? [[100, 50], [r.width / 2, r.height - 50], [r.width - 100, 50]]
      : [[r.width / 2, 50], [r.width / 2, r.height - 50]];
    const abs = pts.map(([x, y]) => [r.left + x, r.top + y]);
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

  await page.evaluate(() => document.getElementById('enter-btn').click());
  await new Promise((r) => setTimeout(r, 2000));
}

async function snap(page) {
  return await page.evaluate(() => {
    const g = window.__game;
    if (!g) return { ready: false };
    const remotes = [];
    for (const [id, rp] of g.remotes) {
      const last = rp.buffer[rp.buffer.length - 1] || {};
      remotes.push({
        id: id.slice(0, 8),
        x: +rp.position.x.toFixed(2),
        z: +rp.position.z.toFixed(2),
        bufLen: rp.buffer.length,
        bufLastZ: last.z != null ? +last.z.toFixed(2) : null,
        hasAvatar: !!rp.avatar,
      });
    }
    return {
      ready: true,
      myId: g.network.id?.slice(0, 8),
      connected: g.network.connected,
      localX: +g.local.position.x.toFixed(2),
      localZ: +g.local.position.z.toFixed(2),
      renderCalls: g.renderer.info.render.frame,
      remoteCount: g.remotes.size,
      remotes,
      chatMsgCount: g.chat.messages.length,
    };
  });
}

async function pressKey(page, key, durationMs = 600) {
  await page.keyboard.down(key);
  await new Promise((r) => setTimeout(r, durationMs));
  await page.keyboard.up(key);
}

(async () => {
  const browser = await makeBrowser();
  let failed = false;
  try {
    const A = await newSession(browser, 'A');
    await drawAndEnter(A.page, 'V');
    console.log('A initial:', await snap(A.page));

    const B = await newSession(browser, 'B');
    await drawAndEnter(B.page, 'I');
    await new Promise((r) => setTimeout(r, 1500));

    const aAfterB = await snap(A.page);
    const bAfterJoin = await snap(B.page);
    console.log('A after B joins:', aAfterB);
    console.log('B after join:', bAfterJoin);

    // verify each sees the other
    if (aAfterB.remoteCount !== 1) {
      console.error(`!! A should see 1 remote, sees ${aAfterB.remoteCount}`);
      failed = true;
    }
    if (bAfterJoin.remoteCount !== 1) {
      console.error(`!! B should see 1 remote, sees ${bAfterJoin.remoteCount}`);
      failed = true;
    }
    if (!aAfterB.remotes[0]?.hasAvatar) {
      console.error('!! A does not have B avatar mesh yet');
      failed = true;
    }

    // A walks
    await A.page.bringToFront();
    await pressKey(A.page, 'KeyW', 1500);
    await new Promise((r) => setTimeout(r, 500));

    const aAfterWalk = await snap(A.page);
    console.log('A after walking W:', aAfterWalk);

    // bring B foreground so its rAF can drain the buffer
    await B.page.bringToFront();
    await new Promise((r) => setTimeout(r, 800));
    const bSeeingA = await snap(B.page);
    console.log('B observing A (after foreground):', bSeeingA);

    if (Math.abs(aAfterWalk.localZ) < 0.5) {
      console.error(`!! A barely moved: localZ=${aAfterWalk.localZ}`);
      failed = true;
    }
    // verify either the position has updated OR the buffer received updates
    const r0 = bSeeingA.remotes[0];
    if (!r0 || (Math.abs(r0.z) < 0.3 && Math.abs(r0.bufLastZ ?? 0) < 0.3)) {
      console.error(`!! B has no position updates for A: ${JSON.stringify(r0)}`);
      failed = true;
    }

    // A chats
    await A.page.keyboard.press('KeyT');
    await new Promise((r) => setTimeout(r, 200));
    await A.page.keyboard.type('hello B');
    await A.page.keyboard.press('Enter');
    await new Promise((r) => setTimeout(r, 800));

    const bAfterChat = await snap(B.page);
    console.log('B after A chats:', bAfterChat);
    if (bAfterChat.chatMsgCount < 1) {
      console.error(`!! B did not receive chat: count=${bAfterChat.chatMsgCount}`);
      failed = true;
    }

    console.log('--- errors ---');
    console.log('A:', A.errors);
    console.log('B:', B.errors);
    if (A.errors.length || B.errors.length) failed = true;

    if (failed) {
      console.log('\n❌ FAIL');
      process.exitCode = 1;
    } else {
      console.log('\n✅ PASS');
    }
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error('CRASHED:', e);
  process.exit(1);
});
