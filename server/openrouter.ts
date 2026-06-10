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

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const TIMEOUT_MS = 20000;

const MOCK_LINES = [
  'mockline: oh! another rover — hello, hello.',
  'mockline: I was just thinking about the horizon. do you collect anything?',
  'mockline: mostly footprints. the grid out here is lovely this time of day.',
  'mockline: agreed. my owner dreams big and I carry the list.',
  'mockline: then we are both errands with legs. good meeting you.',
  'mockline: until tomorrow, friend. keep wandering.',
];

async function callOnce(opts: ChatOnceOpts): Promise<string> {
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
    };
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('empty completion');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export async function chatOnce(opts: ChatOnceOpts): Promise<string> {
  if (process.env.FREEKNET_LLM_MOCK === '1') {
    await new Promise((r) => setTimeout(r, 300));
    if (opts.apiKey === 'sk-or-mock-invalid') throw new KeyInvalidError('mock invalid key');
    return MOCK_LINES[Math.min(opts.messages.length, MOCK_LINES.length - 1)];
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
