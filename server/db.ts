// sqlite persistence. accounts, sessions, rovers, handshake transcripts.
//
// better-sqlite3 is synchronous, which fits the single-threaded tick model:
// every query is a plain function call, no await soup in the hot path.
// migrations are an append-only array gated by PRAGMA user_version.

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DB_PATH = process.env.FREEKNET_DB ?? join(__dirname, '..', 'data', 'freeknet.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

// ---- migrations -----------------------------------------------------------

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pass_salt     BLOB NOT NULL,
    pass_hash     BLOB NOT NULL,
    api_key_enc   BLOB,
    key_error     TEXT,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    token       TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );

  CREATE TABLE rovers (
    user_id            INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    drawing            TEXT,
    personality        TEXT NOT NULL DEFAULT '',
    intent_short       TEXT NOT NULL DEFAULT '',
    intent_long        TEXT NOT NULL DEFAULT '',
    active             INTEGER NOT NULL DEFAULT 0,
    model              TEXT NOT NULL DEFAULT 'openai/gpt-4.1-mini',
    last_handshake_day TEXT,
    updated_at         INTEGER NOT NULL
  );

  CREATE TABLE handshakes (
    id          INTEGER PRIMARY KEY,
    rover_a     INTEGER NOT NULL REFERENCES rovers(user_id),
    rover_b     INTEGER NOT NULL REFERENCES rovers(user_id),
    instance_id TEXT NOT NULL,
    started_at  INTEGER NOT NULL,
    ended_at    INTEGER,
    status      TEXT NOT NULL DEFAULT 'running',
    error       TEXT,
    transcript  TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX idx_hs_a ON handshakes(rover_a, started_at DESC);
  CREATE INDEX idx_hs_b ON handshakes(rover_b, started_at DESC);
  `,
];

{
  const version = db.pragma('user_version', { simple: true }) as number;
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
}

// ---- row types ------------------------------------------------------------

export interface UserRow {
  id: number;
  username: string;
  pass_salt: Buffer;
  pass_hash: Buffer;
  api_key_enc: Buffer | null;
  key_error: string | null;
  created_at: number;
}

export interface SessionRow {
  token: string;
  user_id: number;
  created_at: number;
  expires_at: number;
}

export interface RoverRow {
  user_id: number;
  drawing: string | null;
  personality: string;
  intent_short: string;
  intent_long: string;
  active: number;
  model: string;
  last_handshake_day: string | null;
  updated_at: number;
}

export interface HandshakeRow {
  id: number;
  rover_a: number;
  rover_b: number;
  instance_id: string;
  started_at: number;
  ended_at: number | null;
  status: string;
  error: string | null;
  transcript: string;
}

// ---- users ----------------------------------------------------------------

const stmtGetUserByName = db.prepare('SELECT * FROM users WHERE username = ?');
const stmtGetUserById = db.prepare('SELECT * FROM users WHERE id = ?');
const stmtCreateUser = db.prepare(
  'INSERT INTO users (username, pass_salt, pass_hash, created_at) VALUES (?, ?, ?, ?)',
);
const stmtSetApiKey = db.prepare('UPDATE users SET api_key_enc = ?, key_error = NULL WHERE id = ?');
const stmtSetKeyError = db.prepare('UPDATE users SET key_error = ? WHERE id = ?');

export function getUserByName(username: string): UserRow | undefined {
  return stmtGetUserByName.get(username) as UserRow | undefined;
}

export function getUserById(id: number): UserRow | undefined {
  return stmtGetUserById.get(id) as UserRow | undefined;
}

export function createUser(username: string, salt: Buffer, hash: Buffer): number {
  const info = stmtCreateUser.run(username, salt, hash, Date.now());
  return Number(info.lastInsertRowid);
}

export function setApiKey(userId: number, enc: Buffer | null): void {
  stmtSetApiKey.run(enc, userId);
}

export function setKeyError(userId: number, error: string | null): void {
  stmtSetKeyError.run(error, userId);
}

// ---- sessions ---------------------------------------------------------------

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const stmtCreateSession = db.prepare(
  'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
);
const stmtGetSession = db.prepare('SELECT * FROM sessions WHERE token = ?');
const stmtRefreshSession = db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?');
const stmtDeleteSession = db.prepare('DELETE FROM sessions WHERE token = ?');
const stmtPruneSessions = db.prepare('DELETE FROM sessions WHERE expires_at < ?');

export function createSession(token: string, userId: number): void {
  const now = Date.now();
  stmtCreateSession.run(token, userId, now, now + SESSION_TTL_MS);
}

export function getSession(token: string): SessionRow | undefined {
  const row = stmtGetSession.get(token) as SessionRow | undefined;
  if (!row) return undefined;
  const now = Date.now();
  if (row.expires_at < now) {
    stmtDeleteSession.run(token);
    return undefined;
  }
  // sliding expiry: refresh when more than a day has been consumed
  if (row.expires_at - now < SESSION_TTL_MS - 24 * 60 * 60 * 1000) {
    stmtRefreshSession.run(now + SESSION_TTL_MS, token);
  }
  return row;
}

export function deleteSession(token: string): void {
  stmtDeleteSession.run(token);
}

export function pruneExpiredSessions(): void {
  stmtPruneSessions.run(Date.now());
}

// ---- rovers -----------------------------------------------------------------

const stmtGetRover = db.prepare('SELECT * FROM rovers WHERE user_id = ?');
const stmtListActiveRovers = db.prepare(
  'SELECT * FROM rovers WHERE active = 1 AND drawing IS NOT NULL',
);
const stmtUpsertRover = db.prepare(`
  INSERT INTO rovers (user_id, drawing, personality, intent_short, intent_long, active, model, updated_at)
  VALUES (@user_id, @drawing, @personality, @intent_short, @intent_long, @active, @model, @updated_at)
  ON CONFLICT(user_id) DO UPDATE SET
    drawing = excluded.drawing,
    personality = excluded.personality,
    intent_short = excluded.intent_short,
    intent_long = excluded.intent_long,
    active = excluded.active,
    model = excluded.model,
    updated_at = excluded.updated_at
`);
const stmtSetHandshakeDay = db.prepare(
  'UPDATE rovers SET last_handshake_day = ? WHERE user_id = ?',
);

export function getRover(userId: number): RoverRow | undefined {
  return stmtGetRover.get(userId) as RoverRow | undefined;
}

export function listActiveRovers(): RoverRow[] {
  return stmtListActiveRovers.all() as RoverRow[];
}

export function upsertRover(rover: Omit<RoverRow, 'last_handshake_day'>): void {
  stmtUpsertRover.run(rover);
}

export function setLastHandshakeDay(userId: number, day: string): void {
  stmtSetHandshakeDay.run(day, userId);
}

// ---- handshakes ---------------------------------------------------------------

const stmtInsertHandshake = db.prepare(`
  INSERT INTO handshakes (rover_a, rover_b, instance_id, started_at) VALUES (?, ?, ?, ?)
`);
const stmtUpdateTranscript = db.prepare('UPDATE handshakes SET transcript = ? WHERE id = ?');
const stmtFinishHandshake = db.prepare(
  'UPDATE handshakes SET status = ?, error = ?, ended_at = ? WHERE id = ?',
);
const stmtAbortRunning = db.prepare(
  "UPDATE handshakes SET status = 'aborted', ended_at = ? WHERE status = 'running'",
);
const stmtListHandshakes = db.prepare(`
  SELECT h.*, ua.username AS username_a, ub.username AS username_b
  FROM handshakes h
  JOIN users ua ON ua.id = h.rover_a
  JOIN users ub ON ub.id = h.rover_b
  WHERE (h.rover_a = @user_id OR h.rover_b = @user_id) AND h.id < @before
  ORDER BY h.id DESC
  LIMIT @limit
`);

export function insertHandshake(roverA: number, roverB: number, instanceId: string): number {
  const info = stmtInsertHandshake.run(roverA, roverB, instanceId, Date.now());
  return Number(info.lastInsertRowid);
}

export function updateHandshakeTranscript(id: number, transcript: string): void {
  stmtUpdateTranscript.run(transcript, id);
}

export function finishHandshake(id: number, status: string, error: string | null): void {
  stmtFinishHandshake.run(status, error, Date.now(), id);
}

export function abortRunningHandshakes(): void {
  stmtAbortRunning.run(Date.now());
}

export type HandshakeListRow = HandshakeRow & { username_a: string; username_b: string };

export function listHandshakesForUser(
  userId: number,
  limit: number,
  before: number,
): HandshakeListRow[] {
  return stmtListHandshakes.all({
    user_id: userId,
    before,
    limit,
  }) as HandshakeListRow[];
}
