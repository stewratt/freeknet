import puppeteer from 'puppeteer-core';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

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

async function inputState(page) {
  return await page.evaluate(() => ({
    value: document.getElementById('chat-input').value,
    activeId: document.activeElement?.id,
  }));
}

async function bubble(page) {
  return await page.evaluate(() => {
    const b = Array.from(window.__game.chat.bubbles.values())[0];
    if (!b) return null;
    return {
      text: b.text.text,
      fillOpacity: b.text.fillOpacity,
      outlineOpacity: b.text.outlineOpacity,
      visible: b.text.visible,
      age: +b.age.toFixed(2),
    };
  });
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--use-gl=swiftshader'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 768 });
  page.on('pageerror', (e) => console.log('[ERR]', e.message));

  let failed = false;

  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 600));
  await drawAndEnter(page);

  // ---- Flow A: press T, type, Enter ----
  console.log('\n=== Flow A: T → type → Enter ===');
  await page.keyboard.press('KeyT');
  await new Promise((r) => setTimeout(r, 150));
  console.log('after T:', await inputState(page));
  await page.keyboard.type('typed via T');
  console.log('after typing:', await inputState(page));
  await page.keyboard.press('Enter');
  await new Promise((r) => setTimeout(r, 600));
  const after1 = await inputState(page);
  console.log('after Enter:', after1);
  console.log('bubble:', await bubble(page));
  if (after1.value !== '') { console.error('!! input not cleared'); failed = true; }

  // ---- Flow B: CLICK the input, type, Enter ----
  console.log('\n=== Flow B: click input → type → Enter ===');
  const inputBox = await page.$('#chat-input');
  const box = await inputBox.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await new Promise((r) => setTimeout(r, 150));
  console.log('after click:', await inputState(page));
  await page.keyboard.type('clicked then typed');
  console.log('after typing:', await inputState(page));
  await page.keyboard.press('Enter');
  await new Promise((r) => setTimeout(r, 600));
  const after2 = await inputState(page);
  console.log('after Enter:', after2);
  const b2 = await bubble(page);
  console.log('bubble:', b2);
  if (after2.value !== '') { console.error('!! input not cleared after click flow'); failed = true; }
  if (!b2 || b2.text !== 'clicked then typed') {
    console.error('!! bubble text wrong after click flow');
    failed = true;
  }
  if (b2 && (b2.fillOpacity == null || b2.fillOpacity <= 0)) {
    console.error('!! fillOpacity not set:', b2.fillOpacity);
    failed = true;
  }

  // ---- Flow C: Escape cancels ----
  console.log('\n=== Flow C: T → type → Escape ===');
  await page.keyboard.press('KeyT');
  await new Promise((r) => setTimeout(r, 150));
  await page.keyboard.type('to be cancelled');
  await page.keyboard.press('Escape');
  await new Promise((r) => setTimeout(r, 200));
  const after3 = await inputState(page);
  console.log('after Esc:', after3);
  if (after3.value !== '') { console.error('!! Esc did not clear'); failed = true; }
  if (after3.activeId === 'chat-input') { console.error('!! Esc did not blur'); failed = true; }

  // ---- Flow D: WASD does NOT move while typing ----
  console.log('\n=== Flow D: WASD while input focused ===');
  const startZ = await page.evaluate(() => window.__game.local.position.z);
  await page.keyboard.press('KeyT');
  await new Promise((r) => setTimeout(r, 100));
  await page.keyboard.down('KeyW');
  await new Promise((r) => setTimeout(r, 800));
  await page.keyboard.up('KeyW');
  const endZ = await page.evaluate(() => window.__game.local.position.z);
  console.log(`startZ=${startZ} endZ=${endZ}`);
  if (Math.abs(endZ - startZ) > 0.3) {
    console.error('!! player moved while typing in chat');
    failed = true;
  }

  await page.screenshot({ path: 'shot-chat-final.png' });

  console.log(failed ? '\n❌ FAIL' : '\n✅ PASS');
  if (failed) process.exitCode = 1;
  await browser.close();
})();
