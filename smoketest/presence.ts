// presence broadcast: the HUD's `#presence` row should reflect the live
// online count. one client → "1 online", a second client → "2 online".
// the ?bot=1 query param is honored but doesn't change the count display
// (bots count as one each, same as humans).

import { Page } from 'puppeteer';
import { makeBrowser, newSession, drawAndEnter, sleep, makeRunner } from './helpers';

async function presenceText(page: Page): Promise<string> {
  return await page.evaluate(() => document.getElementById('presence')?.textContent ?? '');
}

const browser = await makeBrowser();
const { test, fail, pass, summary } = makeRunner();

try {
  // human session
  const human = await newSession(browser, 'human');
  await drawAndEnter(human.page, 'line');
  await sleep(1000);

  await test('initial presence shows 1 online', async () => {
    const t = await presenceText(human.page);
    if (!/1 online/.test(t)) {
      fail(`expected '1 online' in: "${t}"`);
    } else {
      pass(`presence: "${t}"`);
    }
  });

  // second session, this one a bot (?bot=1). uses newPage directly so we can
  // pass the query string; inject the __name polyfill ourselves because we
  // skip newSession.
  const botPage = await browser.newPage();
  await botPage.evaluateOnNewDocument(`
    if (typeof __name === 'undefined') {
      window.__name = (fn) => fn;
    }
  `);
  await botPage.setViewport({ width: 800, height: 600 });
  await botPage.goto('http://localhost:5173/?bot=1', { waitUntil: 'networkidle2' });
  await sleep(800);
  await drawAndEnter(botPage, 'V');
  await sleep(1500);

  await test('after a second client joins, presence shows 2 online', async () => {
    const t = await presenceText(human.page);
    if (!/2 online/.test(t)) {
      fail(`expected '2 online' in: "${t}"`);
    } else {
      pass(`presence: "${t}"`);
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
