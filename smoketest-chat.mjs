import puppeteer from 'puppeteer-core';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function newSession(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 768 });
  const errors = [];
  page.on('pageerror', (err) => errors.push(`PAGE ERROR: ${err.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('favicon') && !m.text().includes('404')) {
      errors.push(`CONSOLE: ${m.text()}`);
    }
  });
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle2', timeout: 15000 });
  await new Promise((r) => setTimeout(r, 800));
  return { page, errors };
}

async function drawAndEnter(page) {
  await page.evaluate(() => {
    const c = document.getElementById('draw-canvas');
    const r = c.getBoundingClientRect();
    function ev(type, x, y) {
      c.dispatchEvent(new PointerEvent(type, {
        pointerId: 1, bubbles: true, cancelable: true,
        clientX: x, clientY: y, pointerType: 'mouse',
        button: 0, buttons: type === 'pointerup' ? 0 : 1,
      }));
    }
    ev('pointerdown', r.left + r.width / 2, r.top + 50);
    for (let i = 1; i <= 20; i++) {
      ev('pointermove', r.left + r.width / 2, r.top + 50 + ((r.height - 100) * i / 20));
    }
    ev('pointerup', r.left + r.width / 2, r.top + r.height - 50);
  });
  await page.evaluate(() => document.getElementById('enter-btn').click());
  await new Promise((r) => setTimeout(r, 1500));
}

async function chatCounts(page) {
  return await page.evaluate(() => {
    const g = window.__game;
    return { bubbleCount: g.chat.bubbles.size, msgCount: g.chat.messages.length };
  });
}

async function getInputValue(page) {
  return await page.evaluate(() => document.getElementById('chat-input').value);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=swiftshader'],
  });
  let failed = false;
  try {
    const A = await newSession(browser);
    await drawAndEnter(A.page);
    const B = await newSession(browser);
    await drawAndEnter(B.page);
    await new Promise((r) => setTimeout(r, 1000));

    // A sends first chat
    await A.page.bringToFront();
    await A.page.keyboard.press('KeyT');
    await new Promise((r) => setTimeout(r, 200));
    await A.page.keyboard.type('first message');
    await A.page.keyboard.press('Enter');
    await new Promise((r) => setTimeout(r, 600));

    const inputAfter1 = await getInputValue(A.page);
    if (inputAfter1 !== '') {
      console.error('!! input not cleared after send:', JSON.stringify(inputAfter1));
      failed = true;
    } else {
      console.log('✓ input cleared after send');
    }

    const aCounts1 = await chatCounts(A.page);
    console.log('A counts after first message:', aCounts1);
    if (aCounts1.bubbleCount !== 1) { console.error('!! A should have 1 bubble (own message)'); failed = true; }

    await B.page.bringToFront();
    await new Promise((r) => setTimeout(r, 500));
    const bCounts1 = await chatCounts(B.page);
    console.log('B counts after first message:', bCounts1);
    if (bCounts1.bubbleCount !== 1) { console.error('!! B should have 1 bubble'); failed = true; }

    // A sends second chat — should REPLACE first, not stack
    await A.page.bringToFront();
    await A.page.keyboard.press('KeyT');
    await new Promise((r) => setTimeout(r, 200));
    await A.page.keyboard.type('second message');
    await A.page.keyboard.press('Enter');
    await new Promise((r) => setTimeout(r, 600));

    const aCounts2 = await chatCounts(A.page);
    console.log('A counts after second message:', aCounts2);
    if (aCounts2.bubbleCount !== 1) {
      console.error(`!! A bubbles should still be 1 after replace, got ${aCounts2.bubbleCount}`);
      failed = true;
    } else {
      console.log('✓ A: second message replaced first (count stayed at 1)');
    }

    await B.page.bringToFront();
    await new Promise((r) => setTimeout(r, 500));
    const bCounts2 = await chatCounts(B.page);
    console.log('B counts after second message:', bCounts2);
    if (bCounts2.bubbleCount !== 1) {
      console.error(`!! B bubbles should still be 1 after replace, got ${bCounts2.bubbleCount}`);
      failed = true;
    } else {
      console.log('✓ B: second message replaced first');
    }

    // verify text of the current bubble is the second message
    const bubbleText = await A.page.evaluate(() => {
      const g = window.__game;
      const b = Array.from(g.chat.bubbles.values())[0];
      return b ? b.text.text : null;
    });
    console.log('A current bubble text:', bubbleText);
    if (bubbleText !== 'second message') { console.error('!! wrong bubble text'); failed = true; }

    console.log('A errors:', A.errors);
    console.log('B errors:', B.errors);
    if (A.errors.length || B.errors.length) failed = true;

    console.log(failed ? '\n❌ FAIL' : '\n✅ PASS');
    if (failed) process.exitCode = 1;
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error('CRASHED:', e); process.exit(1); });
