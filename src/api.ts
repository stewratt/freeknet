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
};
