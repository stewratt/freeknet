// proximity voice signaling smoke. we can't realistically capture real audio
// in headless chromium, so we substitute getUserMedia with a synthesized
// audio track (1kHz tone) before the page initializes voice. then we verify:
//
// 1. enabling voice on both clients within proximity opens an RTCPeerConnection
// 2. the connection state reaches "connected" within a reasonable timeout
// 3. walking far apart closes the peer
// 4. walking back into range re-opens it

import { Page } from 'puppeteer';
import {
  makeBrowser,
  newSession,
  drawAndEnter,
  snap,
  pressKey,
  sleep,
  makeRunner,
} from './helpers';

const FAKE_GUM = (): void => {
  // override getUserMedia to return a synthesized 1kHz tone instead of asking
  // for a real mic. this lets us exercise the full webrtc pipeline in a
  // headless browser.
  const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints?: MediaStreamConstraints) => {
    if (!constraints?.audio) return orig(constraints);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    osc.frequency.value = 1000;
    const dst = ctx.createMediaStreamDestination();
    osc.connect(dst);
    osc.start();
    return dst.stream;
  };
};

async function enableVoice(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.__game!.voice.enable();
  });
}

async function peerCount(page: Page): Promise<number> {
  return await page.evaluate(() => window.__game!.voice.peers.size);
}

interface PeerStateSnap {
  id: string;
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  hasStream: boolean;
}

async function peerStates(page: Page): Promise<PeerStateSnap[]> {
  return await page.evaluate(() => {
    const out: PeerStateSnap[] = [];
    for (const [id, st] of window.__game!.voice.peers) {
      out.push({
        id: id.slice(0, 8),
        connectionState: st.pc.connectionState,
        iceConnectionState: st.pc.iceConnectionState,
        hasStream: !!st.remoteStream,
      });
    }
    return out;
  });
}

async function waitForPeerConnected(page: Page, timeoutMs = 8000): Promise<PeerStateSnap[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ps = await peerStates(page);
    if (ps.some((p) => p.connectionState === 'connected')) return ps;
    await sleep(200);
  }
  return await peerStates(page);
}

const browser = await makeBrowser();
const { test, fail, pass, summary } = makeRunner();

try {
  // session A
  const A = await newSession(browser, 'A');
  await A.page.evaluateOnNewDocument(FAKE_GUM);
  await A.page.reload({ waitUntil: 'networkidle2' });
  await drawAndEnter(A.page, 'V');

  // session B
  const B = await newSession(browser, 'B');
  await B.page.evaluateOnNewDocument(FAKE_GUM);
  await B.page.reload({ waitUntil: 'networkidle2' });
  await drawAndEnter(B.page, 'line');
  await sleep(1500);

  await test('both clients see each other before voice is enabled', async () => {
    const a = await snap(A.page);
    const b = await snap(B.page);
    if (a.remoteCount !== 1 || b.remoteCount !== 1) {
      fail(`remoteCount A=${a.remoteCount} B=${b.remoteCount}`);
    } else {
      pass('A and B see each other');
    }
    const aPeers = await peerCount(A.page);
    const bPeers = await peerCount(B.page);
    if (aPeers !== 0 || bPeers !== 0) {
      fail(`unexpected peers before enable: A=${aPeers} B=${bPeers}`);
    } else {
      pass('no rtc peers yet');
    }
  });

  await test('enabling voice on both ends opens a peer in proximity', async () => {
    await enableVoice(A.page);
    await sleep(400);
    await enableVoice(B.page);
    await sleep(800);
    const ps = await waitForPeerConnected(A.page, 12000);
    console.log('A peer states:', ps);
    if (!ps.length) {
      fail('A has no peers');
    } else if (!ps.some((p) => p.connectionState === 'connected')) {
      fail(`A peer never reached connected: ${JSON.stringify(ps)}`);
    } else {
      pass(`A peer connected: ${JSON.stringify(ps[0])}`);
    }
    const psB = await peerStates(B.page);
    console.log('B peer states:', psB);
    if (!psB.length) fail('B has no peers');
    else pass(`B has ${psB.length} peer(s)`);
  });

  await test('walking far apart tears down the peer', async () => {
    await A.page.bringToFront();
    await pressKey(A.page, 'KeyW', 12000);
    await sleep(1500);
    const ps = await peerStates(A.page);
    console.log('A peer states after walking away:', ps);
    if (ps.length !== 0) {
      fail(`expected 0 peers after walking far, got ${ps.length}`);
    } else {
      pass('peer torn down after walking past proximity');
    }
  });

  await test('walking back into range re-opens the peer', async () => {
    await A.page.bringToFront();
    await pressKey(A.page, 'KeyS', 12000);
    await sleep(1500);
    const ps = await waitForPeerConnected(A.page, 12000);
    if (!ps.length) fail('no peer re-opened');
    else if (!ps.some((p) => p.connectionState === 'connected')) {
      fail(`peer re-opened but never reached connected: ${JSON.stringify(ps)}`);
    } else {
      pass(`peer re-opened: ${JSON.stringify(ps[0])}`);
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
