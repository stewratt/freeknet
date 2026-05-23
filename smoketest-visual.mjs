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

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=swiftshader'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 768 });

  page.on('console', (m) => console.log(`[browser ${m.type()}]`, m.text()));
  page.on('pageerror', (e) => console.log('[browser ERR]', e.message));

  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 800));
  await drawAndEnter(page);

  await page.screenshot({ path: 'shot-1-entered.png' });

  // simulate the exact user flow: press T, type, press Enter
  await page.keyboard.press('KeyT');
  await new Promise((r) => setTimeout(r, 200));
  console.log('---after T, before typing---');
  console.log('chatActive=', await page.evaluate(() => document.activeElement?.id));
  console.log('inputVal=', await page.evaluate(() => document.getElementById('chat-input').value));

  await page.keyboard.type('hello there');
  await new Promise((r) => setTimeout(r, 200));
  console.log('---after typing, before Enter---');
  console.log('inputVal=', await page.evaluate(() => document.getElementById('chat-input').value));
  await page.screenshot({ path: 'shot-2-typed.png' });

  await page.keyboard.press('Enter');
  await new Promise((r) => setTimeout(r, 800));
  console.log('---after Enter---');
  console.log('inputVal=', await page.evaluate(() => document.getElementById('chat-input').value));
  console.log('bubbleCount=', await page.evaluate(() => window.__game.chat.bubbles.size));
  console.log('bubbleInfo=', await page.evaluate(() => {
    const b = Array.from(window.__game.chat.bubbles.values())[0];
    if (!b) return null;
    return {
      text: b.text.text,
      pos: b.text.position.toArray().map(n => +n.toFixed(2)),
      opacity: b.text.material.opacity,
      visible: b.text.visible,
      age: b.age,
      inScene: window.__game.scene.children.includes(b.text),
    };
  }));
  await page.screenshot({ path: 'shot-3-after-enter.png' });

  // wait a frame, take another shot
  await new Promise((r) => setTimeout(r, 1200));
  console.log('---1s later---');
  console.log('bubbleInfo=', await page.evaluate(() => {
    const b = Array.from(window.__game.chat.bubbles.values())[0];
    if (!b) return null;
    return {
      text: b.text.text,
      pos: b.text.position.toArray().map(n => +n.toFixed(2)),
      opacity: b.text.material.opacity,
      visible: b.text.visible,
      age: +b.age.toFixed(2),
    };
  }));
  await page.screenshot({ path: 'shot-4-after-1s.png' });

  await browser.close();
})();
