// REST endpoints under /api/*. auth, rover profile, api key, handshake logs.
//
// the router is intentionally tiny: exact method+path matching, JSON in and
// out, session resolved from the fk_session cookie. the game's ws protocol is
// untouched — guests never hit these endpoints.

import type { IncomingMessage, ServerResponse } from 'http';
import { randomBytes } from 'crypto';
import * as dbq from './db';
import { encryptApiKey, hashPassword, verifyPassword } from './crypto';
import { runSimulation } from './simulate';
import { converse, resolveApiKey } from './handshake';
import { estimateCostUsd } from './openrouter';
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

// validate + persist a rover profile patch. shared by the user-facing
// PUT /api/rover and the dev-tools tester editor. returns an error string on
// validation failure, or null on success.
function applyRoverUpdate(userId: number, body: Record<string, unknown>): string | null {
  const existing = dbq.getRover(userId);
  let drawing = existing?.drawing ?? null;
  if (typeof body.drawing === 'string') {
    if (!body.drawing.startsWith('data:image/png;base64,') || body.drawing.length > DRAWING_LIMIT) {
      return 'drawing must be a png data url under 512KB';
    }
    drawing = body.drawing;
  }
  let model = existing?.model ?? DEFAULT_MODEL;
  if (typeof body.model === 'string') {
    if (!ALLOWED_MODELS.has(body.model)) return 'unknown model';
    model = body.model;
  }
  const active = typeof body.active === 'boolean' ? body.active : !!existing?.active;
  if (active && !drawing) return 'draw your rover before activating it';

  // field caps double as the token-spend control: these strings go straight
  // into the handshake system prompt.
  const str = (v: unknown, fallback: string, max: number) =>
    typeof v === 'string' ? v.slice(0, max) : fallback;

  dbq.upsertRover({
    user_id: userId,
    drawing,
    personality: str(body.personality, existing?.personality ?? '', PERSONALITY_MAX),
    intent_short: str(body.intentShort, existing?.intent_short ?? '', INTENT_MAX),
    intent_long: str(body.intentLong, existing?.intent_long ?? '', INTENT_MAX),
    active: active ? 1 : 0,
    model,
    updated_at: Date.now(),
  });
  roverHooks.onRoverChanged(userId);
  return null;
}

async function handlePutRover(
  req: IncomingMessage,
  res: ServerResponse,
  user: UserRow,
): Promise<void> {
  const body = await readBody(req);
  if (!body) return sendJson(res, 400, { error: 'bad request body' });
  const err = applyRoverUpdate(user.id, body);
  if (err) return sendJson(res, 400, { error: err });
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

// ---- dev tools --------------------------------------------------------------------
//
// the test-corpus authoring surface, mounted only when FREEKNET_DEV_TOOLS=1.
// it has no auth of its own — the env flag is the gate, so DO NOT enable it on
// a public deployment (POST /api/dev/simulate spends the shared test key).

function testerToJson(user: UserRow) {
  return {
    id: user.id,
    username: user.username,
    rover: roverToJson(dbq.getRover(user.id)),
  };
}

function devListTesters(res: ServerResponse): void {
  sendJson(res, 200, {
    testers: dbq.listTestUsers().map(testerToJson),
    testKeyConfigured: !!process.env.FREEKNET_TEST_API_KEY || process.env.FREEKNET_LLM_MOCK === '1',
    mock: process.env.FREEKNET_LLM_MOCK === '1',
    allowedModels: [...ALLOWED_MODELS],
  });
}

function devCreateTester(res: ServerResponse): void {
  let username = '';
  for (let i = 0; i < 6 && !username; i++) {
    const candidate = `test_${randomBytes(4).toString('hex')}`;
    if (!dbq.getUserByName(candidate)) username = candidate;
  }
  if (!username) return sendJson(res, 500, { error: 'could not allocate a test username' });
  const { salt, hash } = hashPassword(randomBytes(24).toString('hex'));
  const id = dbq.createTestUser(username, salt, hash);
  sendJson(res, 200, testerToJson(dbq.getUserById(id)!));
}

// POST /api/dev/testers/import — batch-author explorers from a JSON file.
// Accepts a bare array, or { "explorers": [ ... ] }. Each entry creates a fresh
// test account + rover profile in one shot. Drawings are NOT imported (explorers
// are still drawn by hand on the page), so imported explorers start inactive
// until you draw + activate them. Returns a per-row summary so a bad entry is
// visible instead of silently dropped.
const IMPORT_MAX = 200;

async function devImportTesters(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const raw: unknown = Array.isArray(body)
    ? body
    : Array.isArray((body as Record<string, unknown> | null)?.explorers)
      ? (body as Record<string, unknown>).explorers
      : null;
  if (!raw) {
    return sendJson(res, 400, {
      error: 'expected a JSON array of explorers, or { "explorers": [ ... ] }',
    });
  }
  const list = raw as unknown[];
  if (list.length === 0) return sendJson(res, 400, { error: 'no explorers in the file' });
  if (list.length > IMPORT_MAX) {
    return sendJson(res, 400, { error: `too many explorers (max ${IMPORT_MAX} per import)` });
  }

  const created: ReturnType<typeof testerToJson>[] = [];
  const errors: { row: number; error: string }[] = [];

  for (let i = 0; i < list.length; i++) {
    const row = i + 1;
    const entry = list[i];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push({ row, error: 'not a JSON object' });
      continue;
    }
    const e = entry as Record<string, unknown>;

    // username: optional. validate + check uniqueness if given, else autogenerate.
    let username = '';
    if (e.username !== undefined && e.username !== null && e.username !== '') {
      const requested = String(e.username).toLowerCase();
      if (!USERNAME_RE.test(requested)) {
        errors.push({ row, error: `username "${requested}" must be 3-20 chars, a-z 0-9 _` });
        continue;
      }
      if (dbq.getUserByName(requested)) {
        errors.push({ row, error: `username "${requested}" is already taken` });
        continue;
      }
      username = requested;
    } else {
      for (let t = 0; t < 6 && !username; t++) {
        const candidate = `test_${randomBytes(4).toString('hex')}`;
        if (!dbq.getUserByName(candidate)) username = candidate;
      }
      if (!username) {
        errors.push({ row, error: 'could not allocate a username' });
        continue;
      }
    }

    // friendly column aliases so a spreadsheet export can use either name
    const update: Record<string, unknown> = {
      personality: e.personality,
      intentShort: e.intentShort ?? e.wantsNow ?? e.wants,
      intentLong: e.intentLong ?? e.dream ?? e.longTermDream,
      model: e.model,
    };

    const { salt, hash } = hashPassword(randomBytes(24).toString('hex'));
    const id = dbq.createTestUser(username, salt, hash);
    const err = applyRoverUpdate(id, update);
    if (err) {
      dbq.deleteUser(id); // roll the row back so a bad entry leaves nothing behind
      errors.push({ row, error: err });
      continue;
    }
    created.push(testerToJson(dbq.getUserById(id)!));
  }

  sendJson(res, 200, { created: created.length, failed: errors.length, errors, testers: created });
}

async function devUpdateTester(
  req: IncomingMessage,
  res: ServerResponse,
  user: UserRow,
): Promise<void> {
  const body = await readBody(req);
  if (!body) return sendJson(res, 400, { error: 'bad request body' });
  const err = applyRoverUpdate(user.id, body);
  if (err) return sendJson(res, 400, { error: err });
  sendJson(res, 200, testerToJson(dbq.getUserById(user.id)!));
}

async function devSimulate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) ?? {};
  const num = (v: unknown) => (typeof v === 'number' && v > 0 ? Math.floor(v) : undefined);
  const report = await runSimulation({
    pairs: num(body.pairs),
    tokenBudget: num(body.tokenBudget),
    concurrency: num(body.concurrency),
  });
  sendJson(res, 200, report);
}

// ---- two-agent handshake demo ----------------------------------------------
//
// a focused surface for the investor-deck recording: exactly two persistent
// explorers (demo_a / demo_b) authored inline, then a single live handshake
// streamed turn-by-turn. uses the same shared test key + converse() core as the
// batch simulation, just for one pair with per-line streaming.

const DEMO_USERNAMES = ['demo_a', 'demo_b'] as const;

// fetch the two demo explorers, creating any that don't exist yet so the page
// always has a stable left/right slot across reloads (multiple recording takes).
function ensureDemoUsers(): UserRow[] {
  return DEMO_USERNAMES.map((name) => {
    const existing = dbq.getUserByName(name);
    if (existing) return existing;
    const { salt, hash } = hashPassword(randomBytes(24).toString('hex'));
    const id = dbq.createTestUser(name, salt, hash);
    return dbq.getUserById(id)!;
  });
}

function devHandshakeProfiles(res: ServerResponse): void {
  const [a, b] = ensureDemoUsers();
  sendJson(res, 200, {
    a: testerToJson(a),
    b: testerToJson(b),
    testKeyConfigured: !!process.env.FREEKNET_TEST_API_KEY || process.env.FREEKNET_LLM_MOCK === '1',
    mock: process.env.FREEKNET_LLM_MOCK === '1',
    allowedModels: [...ALLOWED_MODELS],
  });
}

// stream the live conversation between the two demo explorers as newline-
// delimited JSON: one {type:'line'} per turn as it lands, then a {type:'done'}
// (or {type:'error'}) summary. the client animates each line into a thought
// bubble as it arrives.
async function devHandshakeRun(res: ServerResponse): Promise<void> {
  const [a, b] = ensureDemoUsers();
  const rovers = { a: dbq.getRover(a.id), b: dbq.getRover(b.id) };

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
  });
  const write = (event: unknown) => res.write(`${JSON.stringify(event)}\n`);

  // both explorers must have a saved profile (rover row + model) and a usable
  // key before they can talk. surface a friendly reason instead of a 500.
  for (const [slot, user, rover] of [
    ['a', a, rovers.a],
    ['b', b, rovers.b],
  ] as const) {
    if (!rover) {
      write({
        type: 'error',
        error: `${slot === 'a' ? 'left' : 'right'} explorer has no profile yet — draw and save it first`,
      });
      res.end();
      return;
    }
    if (!resolveApiKey(user)) {
      write({
        type: 'error',
        error: 'no usable test key — set FREEKNET_TEST_API_KEY (or FREEKNET_LLM_MOCK=1)',
      });
      res.end();
      return;
    }
  }

  write({
    type: 'start',
    a: a.username,
    b: b.username,
    models: { a: rovers.a!.model, b: rovers.b!.model },
  });

  const result = await converse(a.id, b.id, {
    instanceId: 'handshake-demo',
    burnQuota: false,
    onLine: (line) => write({ type: 'line', speaker: line.speaker, text: line.text, at: line.at }),
  });

  const { prompt_tokens: p, completion_tokens: c } = result.usage;
  const estCostUsd =
    estimateCostUsd(rovers.a!.model, Math.round(p / 2), Math.round(c / 2)) +
    estimateCostUsd(rovers.b!.model, Math.round(p / 2), Math.round(c / 2));
  write({
    type: 'done',
    status: result.status,
    turns: result.turnsDone,
    totalTokens: result.usage.total_tokens,
    estCostUsd,
    error: result.error,
  });
  res.end();
}

async function handleDevApi(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<void> {
  if (path === '/api/dev/handshake' && method === 'GET') return devHandshakeProfiles(res);
  if (path === '/api/dev/handshake/run' && method === 'POST') return devHandshakeRun(res);
  if (path === '/api/dev/testers') {
    if (method === 'GET') return devListTesters(res);
    if (method === 'POST') return devCreateTester(res);
  }
  if (path === '/api/dev/testers/import' && method === 'POST') return devImportTesters(req, res);
  const m = path.match(/^\/api\/dev\/testers\/(\d+)$/);
  if (m) {
    const user = dbq.getUserById(Number(m[1]));
    if (!user || !user.is_test) return sendJson(res, 404, { error: 'no such test subject' });
    if (method === 'PUT') return devUpdateTester(req, res, user);
    if (method === 'DELETE') {
      dbq.deleteUser(user.id);
      roverHooks.onRoverChanged(user.id); // despawn it from the live world if present
      return sendJson(res, 200, { ok: true });
    }
  }
  if (path === '/api/dev/simulate' && method === 'POST') return devSimulate(req, res);
  sendJson(res, 404, { error: 'not found' });
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

    // dev tools: gated entirely by the env flag, no session required (local dev)
    if (path.startsWith('/api/dev/')) {
      if (process.env.FREEKNET_DEV_TOOLS !== '1')
        return (sendJson(res, 404, { error: 'not found' }), true);
      return (await handleDevApi(req, res, req.method ?? '', path), true);
    }

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
