// REST endpoints under /api/*. auth, rover profile, api key, handshake logs.
//
// the router is intentionally tiny: exact method+path matching, JSON in and
// out, session resolved from the fk_session cookie. the game's ws protocol is
// untouched — guests never hit these endpoints.

import type { IncomingMessage, ServerResponse } from 'http';
import * as dbq from './db';
import { encryptApiKey, hashPassword, verifyPassword } from './crypto';
import {
  clearSessionCookie,
  endSession,
  getSessionUser,
  rateLimitAuth,
  startSession,
} from './auth';
import type { UserRow } from './db';

const BODY_LIMIT = 1024 * 1024; // rover drawings are png data urls, ~50-200KB
const DRAWING_LIMIT = 512 * 1024;
const PERSONALITY_MAX = 500;
const INTENT_MAX = 200;
const ALLOWED_MODELS = new Set([
  'openai/gpt-4.1-mini',
  'openai/gpt-4.1-nano',
  'anthropic/claude-haiku-4.5',
  'google/gemini-2.0-flash-001',
]);
const DEFAULT_MODEL = 'openai/gpt-4.1-mini';

// hooks the rover manager registers so profile edits take effect in-world
// immediately. defaults are no-ops so the api works before rovers exist.
export interface RoverHooks {
  onRoverChanged(userId: number): void; // active toggled / drawing changed
}

let roverHooks: RoverHooks = { onRoverChanged: () => {} };

export function setRoverHooks(hooks: RoverHooks): void {
  roverHooks = hooks;
}

// optional stats provider wired up by the instance manager.
let statsProvider: () => unknown = () => ({ instances: [] });

export function setStatsProvider(fn: () => unknown): void {
  statsProvider = fn;
}

// ---- helpers ------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(json);
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

function roverToJson(rover: dbq.RoverRow | undefined) {
  if (!rover) return null;
  return {
    drawing: rover.drawing,
    personality: rover.personality,
    intentShort: rover.intent_short,
    intentLong: rover.intent_long,
    active: !!rover.active,
    model: rover.model,
    lastHandshakeDay: rover.last_handshake_day,
  };
}

function meToJson(user: UserRow) {
  return {
    username: user.username,
    hasApiKey: user.api_key_enc != null,
    keyError: user.key_error,
    rover: roverToJson(dbq.getRover(user.id)),
  };
}

async function validateOpenRouterKey(apiKey: string): Promise<boolean> {
  if (process.env.FREEKNET_LLM_MOCK === '1') return true;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---- handlers --------------------------------------------------------------------

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

async function handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!rateLimitAuth(req)) return sendJson(res, 429, { error: 'too many attempts' });
  const body = await readBody(req);
  const username = String(body?.username ?? '').toLowerCase();
  const password = String(body?.password ?? '');
  if (!USERNAME_RE.test(username)) {
    return sendJson(res, 400, { error: 'username must be 3-20 chars, a-z 0-9 _' });
  }
  if (password.length < 8 || password.length > 128) {
    return sendJson(res, 400, { error: 'password must be 8-128 chars' });
  }
  if (dbq.getUserByName(username)) {
    return sendJson(res, 409, { error: 'username taken' });
  }
  const { salt, hash } = hashPassword(password);
  const userId = dbq.createUser(username, salt, hash);
  startSession(res, userId);
  sendJson(res, 200, meToJson(dbq.getUserById(userId)!));
}

async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!rateLimitAuth(req)) return sendJson(res, 429, { error: 'too many attempts' });
  const body = await readBody(req);
  const username = String(body?.username ?? '').toLowerCase();
  const password = String(body?.password ?? '');
  const user = dbq.getUserByName(username);
  if (!user || !verifyPassword(password, user.pass_salt, user.pass_hash)) {
    return sendJson(res, 401, { error: 'invalid username or password' });
  }
  startSession(res, user.id);
  sendJson(res, 200, meToJson(user));
}

async function handlePutRover(
  req: IncomingMessage,
  res: ServerResponse,
  user: UserRow,
): Promise<void> {
  const body = await readBody(req);
  if (!body) return sendJson(res, 400, { error: 'bad request body' });

  const existing = dbq.getRover(user.id);
  let drawing = existing?.drawing ?? null;
  if (typeof body.drawing === 'string') {
    if (!body.drawing.startsWith('data:image/png;base64,') || body.drawing.length > DRAWING_LIMIT) {
      return sendJson(res, 400, { error: 'drawing must be a png data url under 512KB' });
    }
    drawing = body.drawing;
  }
  let model = existing?.model ?? DEFAULT_MODEL;
  if (typeof body.model === 'string') {
    if (!ALLOWED_MODELS.has(body.model)) return sendJson(res, 400, { error: 'unknown model' });
    model = body.model;
  }
  const active = typeof body.active === 'boolean' ? body.active : !!existing?.active;
  if (active && !drawing) {
    return sendJson(res, 400, { error: 'draw your rover before activating it' });
  }

  // field caps double as the token-spend control: these strings go straight
  // into the handshake system prompt.
  const str = (v: unknown, fallback: string, max: number) =>
    typeof v === 'string' ? v.slice(0, max) : fallback;

  dbq.upsertRover({
    user_id: user.id,
    drawing,
    personality: str(body.personality, existing?.personality ?? '', PERSONALITY_MAX),
    intent_short: str(body.intentShort, existing?.intent_short ?? '', INTENT_MAX),
    intent_long: str(body.intentLong, existing?.intent_long ?? '', INTENT_MAX),
    active: active ? 1 : 0,
    model,
    updated_at: Date.now(),
  });
  roverHooks.onRoverChanged(user.id);
  sendJson(res, 200, meToJson(user));
}

async function handlePutKey(
  req: IncomingMessage,
  res: ServerResponse,
  user: UserRow,
): Promise<void> {
  const body = await readBody(req);
  const apiKey = String(body?.apiKey ?? '').trim();
  if (!apiKey || apiKey.length > 256) return sendJson(res, 400, { error: 'missing api key' });
  if (!(await validateOpenRouterKey(apiKey))) {
    return sendJson(res, 400, { error: 'openrouter rejected this key' });
  }
  dbq.setApiKey(user.id, encryptApiKey(apiKey));
  sendJson(res, 200, meToJson(dbq.getUserById(user.id)!));
}

function handleListHandshakes(req: IncomingMessage, res: ServerResponse, user: UserRow): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit')) || 20));
  const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
  const rows = dbq.listHandshakesForUser(user.id, limit, before);
  sendJson(res, 200, {
    handshakes: rows.map((row) => ({
      id: row.id,
      partner: row.rover_a === user.id ? row.username_b : row.username_a,
      mine: row.rover_a === user.id ? 'a' : 'b',
      startedAt: row.started_at,
      endedAt: row.ended_at,
      status: row.status,
      transcript: JSON.parse(row.transcript) as unknown[],
    })),
  });
}

// ---- router -----------------------------------------------------------------------

/** handle /api/* requests; returns false if the path is not an api route. */
export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = (req.url ?? '/').split('?')[0];
  if (!path.startsWith('/api/')) return false;
  const route = `${req.method} ${path}`;

  try {
    if (route === 'POST /api/register') return (await handleRegister(req, res), true);
    if (route === 'POST /api/login') return (await handleLogin(req, res), true);
    if (route === 'GET /api/stats') return (sendJson(res, 200, statsProvider()), true);

    // everything below requires a session
    const user = getSessionUser(req);
    if (!user) {
      if (route === 'POST /api/logout') {
        clearSessionCookie(res);
        return (sendJson(res, 200, { ok: true }), true);
      }
      return (sendJson(res, 401, { error: 'not logged in' }), true);
    }

    switch (route) {
      case 'POST /api/logout':
        endSession(req, res);
        return (sendJson(res, 200, { ok: true }), true);
      case 'GET /api/me':
        return (sendJson(res, 200, meToJson(user)), true);
      case 'PUT /api/rover':
        return (await handlePutRover(req, res, user), true);
      case 'PUT /api/rover/key':
        return (await handlePutKey(req, res, user), true);
      case 'DELETE /api/rover/key':
        dbq.setApiKey(user.id, null);
        return (sendJson(res, 200, meToJson(dbq.getUserById(user.id)!)), true);
      case 'GET /api/rover/handshakes':
        return (handleListHandshakes(req, res, user), true);
      default:
        return (sendJson(res, 404, { error: 'not found' }), true);
    }
  } catch (err) {
    console.error('api error:', err);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    return true;
  }
}
