// minimal openrouter chat-completions client. one endpoint, plain fetch,
// typed errors so the handshake engine can react (invalid key vs transient).
// FREEKNET_LLM_MOCK=1 swaps in canned replies for tests and offline dev.

export class KeyInvalidError extends Error {}
export class OutOfCreditsError extends Error {}
export class RateLimitError extends Error {}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatOnceOpts {
  apiKey: string;
  model: string;
  system: string;
  messages: ChatTurn[];
  maxTokens?: number;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatResult {
  text: string;
  usage: Usage;
}

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const TIMEOUT_MS = 20000;

// rough USD-per-1M-token list prices for the whitelisted models. ESTIMATE only:
// providers change pricing, and OpenRouter adds a small fee. used to give the
// simulation runner a ballpark $/run — trust the OpenRouter dashboard for truth.
const PRICING: Record<string, { in: number; out: number }> = {
  'openai/gpt-4.1-mini': { in: 0.4, out: 1.6 },
  'openai/gpt-4.1-nano': { in: 0.1, out: 0.4 },
  'anthropic/claude-haiku-4.5': { in: 1.0, out: 5.0 },
  'google/gemini-2.0-flash-001': { in: 0.1, out: 0.4 },
};

export function estimateCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const p = PRICING[model];
  if (!p) return 0;
  return (promptTokens * p.in + completionTokens * p.out) / 1_000_000;
}

const MOCK_LINES = [
  'mockline: oh! another rover — hello, hello.',
  'mockline: I was just thinking about the horizon. do you collect anything?',
  'mockline: mostly footprints. the grid out here is lovely this time of day.',
  'mockline: agreed. my owner dreams big and I carry the list.',
  'mockline: then we are both errands with legs. good meeting you.',
  'mockline: until tomorrow, friend. keep wandering.',
];

// approximate token count for mock mode (no provider to ask). ~4 chars/token.
function approxTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

async function callOnce(opts: ChatOnceOpts): Promise<ChatResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${opts.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens ?? 80,
        temperature: 0.9,
        messages: [{ role: 'system', content: opts.system }, ...opts.messages],
      }),
    });
    if (res.status === 401 || res.status === 403) throw new KeyInvalidError('key rejected');
    if (res.status === 402) throw new OutOfCreditsError('out of credits');
    if (res.status === 429) throw new RateLimitError('rate limited');
    if (!res.ok) throw new Error(`openrouter ${res.status}`);
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: Partial<Usage>;
    };
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('empty completion');
    const u = data.usage ?? {};
    const usage: Usage = {
      prompt_tokens: u.prompt_tokens ?? 0,
      completion_tokens: u.completion_tokens ?? 0,
      total_tokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
    };
    return { text, usage };
  } finally {
    clearTimeout(timer);
  }
}

export async function chatOnce(opts: ChatOnceOpts): Promise<ChatResult> {
  if (process.env.FREEKNET_LLM_MOCK === '1') {
    await new Promise((r) => setTimeout(r, 300));
    if (opts.apiKey === 'sk-or-mock-invalid') throw new KeyInvalidError('mock invalid key');
    const text = MOCK_LINES[Math.min(opts.messages.length, MOCK_LINES.length - 1)];
    const prompt_tokens =
      approxTokens(opts.system) + opts.messages.reduce((n, m) => n + approxTokens(m.content), 0);
    const completion_tokens = approxTokens(text);
    return { text, usage: { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens } };
  }
  try {
    return await callOnce(opts);
  } catch (err) {
    // one retry on transient failures (5xx / timeout); typed errors re-throw
    if (
      err instanceof KeyInvalidError ||
      err instanceof OutOfCreditsError ||
      err instanceof RateLimitError
    ) {
      throw err;
    }
    return await callOnce(opts);
  }
}
