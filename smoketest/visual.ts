// visual smoke: dump 4 screenshots through the chat flow so a human can
// eyeball them. writes shot-*.png to cwd.

import { makeBrowser, newSession, drawAndEnter, sleep } from './helpers';

const browser = await makeBrowser();
try {
  const { page } = await newSession(browser);
  await drawAndEnter(page);
  await page.screenshot({ path: 'shot-1-entered.png' });
  console.log('wrote shot-1-entered.png');

  await page.keyboard.press('KeyT');
  await sleep(200);
  await page.keyboard.type('hello there');
  await page.screenshot({ path: 'shot-2-typed.png' });
  console.log('wrote shot-2-typed.png');

  await page.keyboard.press('Enter');
  await sleep(800);
  await page.screenshot({ path: 'shot-3-after-enter.png' });
  console.log('wrote shot-3-after-enter.png');

  await sleep(1200);
  await page.screenshot({ path: 'shot-4-after-1s.png' });
  console.log('wrote shot-4-after-1s.png');
} finally {
  await browser.close();
}
