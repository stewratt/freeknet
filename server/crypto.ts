// password hashing (scrypt) + api key encryption (aes-256-gcm).
//
// the key secret comes from FREEKNET_KEY_SECRET (64 hex chars). in dev we
// generate a throwaway one and warn — encrypted keys won't survive a restart
// without a stable secret, which is fine for local hacking and unacceptable
// in prod (deploy docs cover setting it via freeknet.env).

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'crypto';

const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPassword(password: string): { salt: Buffer; hash: Buffer } {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTS);
  return { salt, hash };
}

export function verifyPassword(password: string, salt: Buffer, hash: Buffer): boolean {
  const candidate = scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTS);
  return candidate.length === hash.length && timingSafeEqual(candidate, hash);
}

// ---- api key encryption ----------------------------------------------------

function loadKeySecret(): Buffer {
  const hex = process.env.FREEKNET_KEY_SECRET;
  if (hex) {
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error('FREEKNET_KEY_SECRET must be 64 hex chars (32 bytes)');
    }
    return Buffer.from(hex, 'hex');
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('FREEKNET_KEY_SECRET is required in production');
  }
  console.warn(
    'freeknet: FREEKNET_KEY_SECRET not set — using a throwaway secret; ' +
      'stored api keys will not survive a restart',
  );
  return randomBytes(32);
}

const KEY_SECRET = loadKeySecret();

// stored as a single blob: iv(12) || tag(16) || ciphertext
export function encryptApiKey(plain: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY_SECRET, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function decryptApiKey(blob: Buffer): string | null {
  try {
    const iv = blob.subarray(0, 12);
    const tag = blob.subarray(12, 28);
    const ct = blob.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', KEY_SECRET, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    // wrong/rotated secret — treat as no key rather than crashing
    return null;
  }
}
