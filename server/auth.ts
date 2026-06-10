// sessions, cookies, and auth rate limiting.

import { randomBytes } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import * as dbq from './db';
import type { UserRow } from './db';

const COOKIE_NAME = 'fk_session';
const SECURE_COOKIES = process.env.FREEKNET_SECURE_COOKIES === '1';

// ---- cookies ----------------------------------------------------------------

function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

export function setSessionCookie(res: ServerResponse, token: string): void {
  const attrs = [
    `${COOKIE_NAME}=${token}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${30 * 24 * 60 * 60}`,
  ];
  if (SECURE_COOKIES) attrs.push('Secure');
  res.setHeader('set-cookie', attrs.join('; '));
}

export function clearSessionCookie(res: ServerResponse): void {
  res.setHeader('set-cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

// ---- sessions -----------------------------------------------------------------

export function startSession(res: ServerResponse, userId: number): void {
  const token = randomBytes(32).toString('hex');
  dbq.createSession(token, userId);
  setSessionCookie(res, token);
}

export function endSession(req: IncomingMessage, res: ServerResponse): void {
  const token = parseCookies(req)[COOKIE_NAME];
  if (token) dbq.deleteSession(token);
  clearSessionCookie(res);
}

/** resolve the request's session cookie to a user, or undefined. */
export function getSessionUser(req: IncomingMessage): UserRow | undefined {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return undefined;
  const session = dbq.getSession(token);
  if (!session) return undefined;
  return dbq.getUserById(session.user_id);
}

// ---- rate limiting --------------------------------------------------------------

// sliding window per ip for register/login. in-memory is fine: a restart
// resetting the limiter is harmless, and the map self-prunes.
const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map<string, number[]>();

export function rateLimitAuth(req: IncomingMessage): boolean {
  const ip = req.socket.remoteAddress ?? 'unknown';
  const now = Date.now();
  const list = (attempts.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= MAX_ATTEMPTS) {
    attempts.set(ip, list);
    return false;
  }
  list.push(now);
  attempts.set(ip, list);
  if (attempts.size > 10000) {
    for (const [k, v] of attempts) {
      if (v.length === 0 || now - v[v.length - 1] > WINDOW_MS) attempts.delete(k);
    }
  }
  return true;
}
