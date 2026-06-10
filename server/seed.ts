// dev seeding: FREEKNET_SEED_ROVERS=N creates N seed accounts with active
// rovers so the world has wanderers before any real users exist.
//
// the rover doodle is generated here as a real PNG (rgba, zlib-deflated)
// because the server has no canvas. each seed gets a different squiggle so
// you can tell them apart in-world.

import { deflateSync } from 'zlib';
import { randomBytes } from 'crypto';
import * as dbq from './db';
import { encryptApiKey, hashPassword } from './crypto';

// ---- minimal png encoder ----------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type rgba
  // scanlines, each prefixed with filter byte 0
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- squiggle doodle ----------------------------------------------------------

function dot(rgba: Buffer, width: number, height: number, cx: number, cy: number, r: number): void {
  for (let y = Math.max(0, cy - r); y <= Math.min(height - 1, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x <= Math.min(width - 1, cx + r); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
      const i = (y * width + x) * 4;
      rgba[i] = 20;
      rgba[i + 1] = 20;
      rgba[i + 2] = 30;
      rgba[i + 3] = 255;
    }
  }
}

export function makeSquiggleDataUrl(seed: number): string {
  const W = 100,
    H = 150;
  const rgba = Buffer.alloc(W * H * 4); // transparent
  const phase = seed * 1.7;
  const wobble = 12 + (seed % 4) * 4;
  // head
  for (let a = 0; a < Math.PI * 2; a += 0.05) {
    dot(rgba, W, H, Math.round(50 + Math.cos(a) * 16), Math.round(28 + Math.sin(a) * 14), 3);
  }
  // eyes
  dot(rgba, W, H, 43, 26, 2);
  dot(rgba, W, H, 57, 26, 2);
  // wiggly body stroke
  for (let y = 42; y < 130; y++) {
    const x = Math.round(50 + Math.sin(y / 11 + phase) * wobble);
    dot(rgba, W, H, x, y, 3);
  }
  // little feet
  dot(rgba, W, H, 38, 134, 4);
  dot(rgba, W, H, 62, 134, 4);
  return `data:image/png;base64,${encodePng(W, H, rgba).toString('base64')}`;
}

// ---- seeding -------------------------------------------------------------------

export function seedRovers(): void {
  const n = Number(process.env.FREEKNET_SEED_ROVERS ?? 0);
  if (!n) return;
  for (let i = 1; i <= n; i++) {
    const username = `seed_rover_${i}`;
    let user = dbq.getUserByName(username);
    if (!user) {
      const { salt, hash } = hashPassword(randomBytes(24).toString('hex'));
      const userId = dbq.createUser(username, salt, hash);
      user = dbq.getUserById(userId)!;
    }
    dbq.upsertRover({
      user_id: user.id,
      drawing: makeSquiggleDataUrl(i),
      personality: `a cheerful doodle who hums while wandering (seed #${i})`,
      intent_short: 'find someone to wave at',
      intent_long: 'see every corner of the paper world',
      active: 1,
      model: 'openai/gpt-4.1-mini',
      updated_at: Date.now(),
    });
    // seeds get a fake key so they're handshake-eligible under FREEKNET_LLM_MOCK
    if (process.env.FREEKNET_LLM_MOCK === '1' && !user.api_key_enc) {
      dbq.setApiKey(user.id, encryptApiKey('sk-or-mock-seed'));
    }
  }
  console.log(`freeknet: seeded ${n} rovers`);
}
