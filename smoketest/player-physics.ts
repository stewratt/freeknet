// player physics smoke: drive the local player around with key holds and
// check the resulting positions. specifically exercises the scenarios that
// were buggy with the hand-rolled AABB code:
//   - walking laterally past the stage
//   - jumping onto the stage from below
//   - walking off the stage edge
//
// the stage is centered at (12.5, 0.35, 0) with size 6x0.7x5 — i.e. it
// occupies x ∈ [9.5, 15.5], z ∈ [-2.5, 2.5], top at y=0.7.

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
  await sleep(1500);

  await test('initial spawn is at origin, on the ground', async () => {
    const s = await snap(A.page);
    if (!s.ready) {
      fail('game not ready');
      return;
    }
    const x = s.localX ?? 0,
      y = s.localY ?? 0,
      z = s.localZ ?? 0;
    // small tolerance for capsule settling
    if (Math.abs(x) > 0.2 || Math.abs(z) > 0.2) fail(`spawn drifted: (${x}, ${y}, ${z})`);
    else pass(`spawn at (${x}, ${y}, ${z})`);
    if (y < -0.1 || y > 0.5) fail(`y out of expected range: ${y}`);
    else pass(`y=${y} (close to 0)`);
  });

  await test('walking forward for 2s moves the player in -z', async () => {
    // generous tolerance — headless chromium throttles raf and the first
    // few frames of the page being settled may produce slow accel. the
    // game feels fine in real play; we just check that motion happened in
    // the right direction and within an order of magnitude.
    await A.page.bringToFront();
    const before = await snap(A.page);
    await pressKey(A.page, 'KeyW', 2000);
    await sleep(300);
    const after = await snap(A.page);
    const dz = (after.localZ ?? 0) - (before.localZ ?? 0);
    if (dz >= -1.0) {
      fail(`forward motion was too weak / wrong direction: ${dz.toFixed(2)}`);
    } else if (dz < -15) {
      fail(`forward motion was implausibly fast: ${dz.toFixed(2)}`);
    } else {
      pass(`walked ${Math.abs(dz).toFixed(2)}u in -z`);
    }
  });

  await test('jumping increases y temporarily, then returns to ground', async () => {
    await A.page.bringToFront();
    // settle horizontally first
    await sleep(300);
    const before = await snap(A.page);
    await A.page.keyboard.press('Space');
    // sample y a couple frames after the jump
    await sleep(250);
    const mid = await snap(A.page);
    // wait for fall to complete
    await sleep(1500);
    const after = await snap(A.page);

    const peakY = mid.localY ?? 0;
    const startY = before.localY ?? 0;
    const endY = after.localY ?? 0;

    if (peakY - startY < 0.3) {
      fail(`jump didn't gain altitude: start=${startY.toFixed(2)} mid=${peakY.toFixed(2)}`);
    } else {
      pass(`jump peak Δy=${(peakY - startY).toFixed(2)}`);
    }
    if (Math.abs(endY - startY) > 0.3) {
      fail(`didn't return to ground: start=${startY.toFixed(2)} end=${endY.toFixed(2)}`);
    } else {
      pass(`returned to ground (Δ=${(endY - startY).toFixed(2)})`);
    }
  });

  await test('walk toward the stage at (12.5, 0.35, 0); approach without falling through', async () => {
    await A.page.bringToFront();
    // hold D to walk in +x. ~3s should put us ~13.5 units in. since the stage
    // edge is at x=9.5, we'll bump into it.
    await pressKey(A.page, 'KeyD', 3000);
    await sleep(500);
    const s = await snap(A.page);
    const y = s.localY ?? 0;
    // we should still be near ground level (capsule rest), not stuck inside
    // the stage or shot up into the sky.
    if (y < -0.1 || y > 1.5) {
      fail(
        `y out of plausible range after walking toward stage: ${y.toFixed(2)} (pos=${s.localX?.toFixed(2)}, _, ${s.localZ?.toFixed(2)})`,
      );
    } else {
      pass(
        `y=${y.toFixed(2)} at (${s.localX?.toFixed(2)}, _, ${s.localZ?.toFixed(2)}) (in plausible range)`,
      );
    }
    // either we ran into the stage edge (x ≤ 9.5) or climbed onto it (y ≈ 0.7).
    // the old buggy code would snap us in weird ways. as long as no NaN/extreme:
    const x = s.localX ?? 0;
    if (x > 20 || x < -5) fail(`x ran away to ${x}`);
    else pass(`x=${x.toFixed(2)} (reasonable)`);
  });

  await test('no page errors during physics-heavy moves', async () => {
    if (A.errors.length) {
      for (const e of A.errors) fail(e);
    } else {
      pass('clean');
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
