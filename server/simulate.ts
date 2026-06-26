// the batch simulation runner: drive a controlled number of rover handshakes
// among the synthetic test corpus all at once, then stop. unlike the live
// scheduler it ignores the daily quota and the spatial choreography — it just
// runs the conversations headless, sums token usage, and reports an estimated
// cost. this is the only thing that spends the shared test key, so all token
// burn is bounded to an explicit run (and an optional tokenBudget).

import * as dbq from './db';
import { converse, type TranscriptLine } from './handshake';
import { estimateCostUsd } from './openrouter';

export interface SimulateOpts {
  pairs?: number; // number of handshakes to run; default = floor(candidates / 2)
  tokenBudget?: number; // stop launching new pairs once total tokens reaches this
  concurrency?: number; // how many conversations run at once (default 3)
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

const SIM_INSTANCE = 'sim';

// all unordered pairs (i<j), so a small corpus still yields many interactions.
function buildPairs(n: number, limit: number): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < n && pairs.length < limit; i++) {
    for (let j = i + 1; j < n && pairs.length < limit; j++) {
      pairs.push([i, j]);
    }
  }
  return pairs;
}

export async function runSimulation(opts: SimulateOpts = {}): Promise<SimReport> {
  const rovers = dbq.listActiveTestRovers();
  const runId = `sim-${Date.now()}`;
  const report: SimReport = {
    runId,
    candidates: rovers.length,
    pairsRun: 0,
    turnsTotal: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estCostUsd: 0,
    perModel: {},
    conversations: [],
    stoppedEarly: false,
  };
  if (rovers.length < 2) return report;

  const nameOf = (userId: number) => dbq.getUserById(userId)?.username ?? `#${userId}`;
  const limit = Math.max(0, opts.pairs ?? Math.floor(rovers.length / 2));
  const pairs = buildPairs(rovers.length, limit);
  const concurrency = Math.max(1, opts.concurrency ?? 3);

  let cursor = 0;
  const runOne = async (pair: [number, number]): Promise<void> => {
    const a = rovers[pair[0]];
    const b = rovers[pair[1]];
    const result = await converse(a.user_id, b.user_id, {
      instanceId: SIM_INSTANCE,
      burnQuota: false,
    });
    report.pairsRun++;
    report.turnsTotal += result.turnsDone;
    report.promptTokens += result.usage.prompt_tokens;
    report.completionTokens += result.usage.completion_tokens;
    report.totalTokens += result.usage.total_tokens;
    // attribute usage to each speaker's model (turns alternate a, b, a, ...)
    for (const r of [a, b]) {
      const bucket = (report.perModel[r.model] ??= { tokens: 0, estCostUsd: 0 });
      const half = Math.round(result.usage.total_tokens / 2);
      bucket.tokens += half;
    }
    report.conversations.push({
      handshakeId: result.handshakeId,
      a: nameOf(a.user_id),
      b: nameOf(b.user_id),
      status: result.status,
      turns: result.turnsDone,
      totalTokens: result.usage.total_tokens,
      transcript: result.transcript,
      error: result.error,
    });
  };

  // a simple concurrency pool that re-checks the token budget before each
  // launch. the budget is a soft cap: with concurrency C, up to C-1 already
  // in-flight conversations can overshoot it before the pool notices.
  const workers: Promise<void>[] = [];
  const pump = async (): Promise<void> => {
    while (cursor < pairs.length) {
      if (opts.tokenBudget != null && report.totalTokens >= opts.tokenBudget) {
        report.stoppedEarly = true;
        return;
      }
      const pair = pairs[cursor++];
      await runOne(pair);
    }
  };
  for (let i = 0; i < concurrency; i++) workers.push(pump());
  await Promise.all(workers);

  // estimate per-model cost: split each model's tokens by the run's global
  // prompt/completion ratio (coarse, but a useful ballpark next to the cap).
  const promptRatio = report.totalTokens ? report.promptTokens / report.totalTokens : 0.5;
  for (const [model, bucket] of Object.entries(report.perModel)) {
    const prompt = Math.round(bucket.tokens * promptRatio);
    const completion = bucket.tokens - prompt;
    bucket.estCostUsd = estimateCostUsd(model, prompt, completion);
  }
  report.estCostUsd = Object.values(report.perModel).reduce((s, b) => s + b.estCostUsd, 0);
  return report;
}
