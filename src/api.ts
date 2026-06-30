// typed fetch wrappers for the /api/* REST endpoints. same-origin, so the
// fk_session cookie rides along automatically.

export interface RoverProfile {
  drawing: string | null;
  personality: string;
  intentShort: string;
  intentLong: string;
  active: boolean;
  model: string;
  lastHandshakeDay: string | null;
}

export interface Me {
  username: string;
  hasApiKey: boolean;
  keyError: string | null;
  rover: RoverProfile | null;
}

export interface TranscriptLine {
  speaker: 'a' | 'b';
  text: string;
  at: number;
}

export interface HandshakeLog {
  id: number;
  partner: string;
  mine: 'a' | 'b';
  startedAt: number;
  endedAt: number | null;
  status: string;
  transcript: TranscriptLine[];
}

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
}

async function req<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {}
    const error = (data as { error?: string } | null)?.error ?? null;
    return { ok: res.ok, status: res.status, data: res.ok ? (data as T) : null, error };
  } catch {
    return { ok: false, status: 0, data: null, error: 'network error' };
  }
}

export interface RoverUpdate {
  drawing?: string;
  personality?: string;
  intentShort?: string;
  intentLong?: string;
  active?: boolean;
  model?: string;
}

// ---- dev tools (only meaningful when the server has FREEKNET_DEV_TOOLS=1) ----

export interface Tester {
  id: number;
  username: string;
  rover: RoverProfile | null;
}

export interface DevTesters {
  testers: Tester[];
  testKeyConfigured: boolean;
  mock: boolean;
  allowedModels: string[];
}

// one row of an explorer-import file (see api.devImportTesters). all fields are
// optional; username autogenerates and missing text fields become empty.
export interface ExplorerImportRow {
  username?: string;
  personality?: string;
  intentShort?: string;
  intentLong?: string;
  model?: string;
}

export interface ImportResult {
  created: number;
  failed: number;
  errors: { row: number; error: string }[];
  testers: Tester[];
}

export interface SimConversation {
  handshakeId: number | null;
  a: string;
  b: string;
  status: string;
  turns: number;
  totalTokens: number;
  transcript: TranscriptLine[];
  error?: string;
}

export interface SimReport {
  runId: string;
  candidates: number;
  pairsRun: number;
  turnsTotal: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estCostUsd: number;
  perModel: Record<string, { tokens: number; estCostUsd: number }>;
  conversations: SimConversation[];
  stoppedEarly: boolean;
}

export interface SimulateOpts {
  pairs?: number;
  tokenBudget?: number;
  concurrency?: number;
}

export const api = {
  register: (username: string, password: string) =>
    req<Me>('POST', '/api/register', { username, password }),
  login: (username: string, password: string) =>
    req<Me>('POST', '/api/login', { username, password }),
  logout: () => req<{ ok: boolean }>('POST', '/api/logout'),
  me: () => req<Me>('GET', '/api/me'),
  saveRover: (update: RoverUpdate) => req<Me>('PUT', '/api/rover', update),
  saveKey: (apiKey: string) => req<Me>('PUT', '/api/rover/key', { apiKey }),
  deleteKey: () => req<Me>('DELETE', '/api/rover/key'),
  handshakes: (before?: number) =>
    req<{ handshakes: HandshakeLog[] }>(
      'GET',
      `/api/rover/handshakes?limit=20${before ? `&before=${before}` : ''}`,
    ),
  devTesters: () => req<DevTesters>('GET', '/api/dev/testers'),
  devCreateTester: () => req<Tester>('POST', '/api/dev/testers'),
  devImportTesters: (explorers: ExplorerImportRow[] | { explorers: ExplorerImportRow[] }) =>
    req<ImportResult>('POST', '/api/dev/testers/import', explorers),
  devUpdateTester: (id: number, update: RoverUpdate) =>
    req<Tester>('PUT', `/api/dev/testers/${id}`, update),
  devDeleteTester: (id: number) => req<{ ok: boolean }>('DELETE', `/api/dev/testers/${id}`),
  devSimulate: (opts: SimulateOpts) => req<SimReport>('POST', '/api/dev/simulate', opts),
};
