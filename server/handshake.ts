// the daily handshake: once per utc day, each rover finds another rover and
// they hold a short llm-generated conversation. the transcript is private —
// it lives in sqlite and is only readable by the two owners over the
// authenticated REST api. the instance only ever sees a `roverchat` on/off
// indicator and the avatars standing face to face.

import * as dbq from './db';
import { decryptApiKey } from './crypto';
import { chatOnce, KeyInvalidError, OutOfCreditsError, RateLimitError } from './openrouter';
import { INSTANCE_CAP, type InstanceManager } from './instances';
import type { RoverManager, RoverState } from './rovers';

const FAST = process.env.FREEKNET_HANDSHAKE_FAST === '1';
const SWEEP_MS = FAST ? 2000 : 60000;
const TOTAL_TURNS = 6; // 3 lines each
const APPROACH_TIMEOUT_MS = 10000;
const MEET_GAP = 1.5; // meters between the two rovers while talking
const LINE_MAX_CHARS = 240;
const LINGER_MS = 2000;

interface TranscriptLine {
  speaker: 'a' | 'b';
  text: string;
  at: number;
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

// deterministic per-(rover, day) attempt time: midnight utc + 0..20h. spreads
// handshakes across the day instead of stampeding at the date rollover.
function nextAttemptAt(userId: number, day: string): number {
  let h = 2166136261;
  for (const ch of `${userId}:${day}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  const offsetMs = (h >>> 0) % (20 * 60 * 60 * 1000);
  return Date.parse(`${day}T00:00:00Z`) + offsetMs;
}

function buildSystemPrompt(rover: dbq.RoverRow): string {
  return [
    'You are the spirit of a small hand-drawn doodle rover wandering a quiet paper world.',
    'You are meeting another rover for your once-a-day handshake.',
    'Reply with ONE short line: at most 2 sentences, under 40 words. Stay in character.',
    'No narration, no stage directions, no quotation marks.',
    rover.personality && `Your personality: ${rover.personality}`,
    rover.intent_short && `Right now you want to: ${rover.intent_short}`,
    rover.intent_long && `Your long-term dream: ${rover.intent_long}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export class HandshakeScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(
    private readonly rovers: RoverManager,
    private readonly instances: InstanceManager,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ---- eligibility + pairing -----------------------------------------------

  private isEligible(state: RoverState, now: number, day: string): boolean {
    if (state.busy) return false;
    const user = dbq.getUserById(state.userId);
    if (!user || !user.api_key_enc || user.key_error === 'invalid') return false;
    if (FAST) return true;
    const rover = dbq.getRover(state.userId);
    if (!rover || rover.last_handshake_day === day) return false;
    return now >= nextAttemptAt(state.userId, day);
  }

  private async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const now = Date.now();
      const day = todayUTC();
      const eligible = [...this.rovers.rovers.values()].filter((s) =>
        this.isEligible(s, now, day),
      );
      if (eligible.length < 2) return;

      // group by instance, pair within each by proximity
      const byInstance = new Map<string, RoverState[]>();
      for (const s of eligible) {
        const list = byInstance.get(s.occ.instance.id) ?? [];
        list.push(s);
        byInstance.set(s.occ.instance.id, list);
      }

      const pairs: Array<[RoverState, RoverState]> = [];
      const lonely: RoverState[] = [];
      for (const group of byInstance.values()) {
        while (group.length >= 2) {
          const a = group.shift()!;
          let bestIdx = 0;
          let bestD = Infinity;
          for (let i = 0; i < group.length; i++) {
            const d = Math.hypot(group[i].occ.x - a.occ.x, group[i].occ.z - a.occ.z);
            if (d < bestD) {
              bestD = d;
              bestIdx = i;
            }
          }
          pairs.push([a, group.splice(bestIdx, 1)[0]]);
        }
        if (group.length === 1) lonely.push(group[0]);
      }

      // a lonely eligible rover migrates to another lonely rover's instance
      // (organic rebalancing: it stays there afterwards).
      while (lonely.length >= 2) {
        const a = lonely.shift()!;
        const b = lonely.shift()!;
        if (b.occ.instance.size() < INSTANCE_CAP) {
          this.rovers.migrate(a, b.occ.instance);
          pairs.push([a, b]);
        } else if (a.occ.instance.size() < INSTANCE_CAP) {
          this.rovers.migrate(b, a.occ.instance);
          pairs.push([a, b]);
        }
        // both instances full: skip this round; a later sweep retries
      }

      for (const [a, b] of pairs) {
        void this.runHandshake(a, b).catch((err) => {
          console.error('handshake crashed:', err);
        });
      }
    } finally {
      this.sweeping = false;
    }
  }

  // ---- the conversation itself ------------------------------------------------

  private isLive(state: RoverState): boolean {
    return this.rovers.rovers.get(state.userId) === state;
  }

  private async runHandshake(a: RoverState, b: RoverState): Promise<void> {
    a.busy = true;
    b.busy = true;
    a.phase = 'handshake';
    b.phase = 'handshake';
    const inst = a.occ.instance;
    let handshakeId: number | null = null;
    let turnsDone = 0;

    try {
      // walk to a shared meeting point, ending MEET_GAP apart
      const midX = (a.occ.x + b.occ.x) / 2;
      const midZ = (a.occ.z + b.occ.z) / 2;
      let dx = b.occ.x - a.occ.x;
      let dz = b.occ.z - a.occ.z;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len;
      dz /= len;
      const targetA = { x: midX - dx * (MEET_GAP / 2), z: midZ - dz * (MEET_GAP / 2) };
      const targetB = { x: midX + dx * (MEET_GAP / 2), z: midZ + dz * (MEET_GAP / 2) };
      const deadline = Date.now() + APPROACH_TIMEOUT_MS;
      let aArrived = false;
      let bArrived = false;
      while (!aArrived || !bArrived) {
        if (!this.isLive(a) || !this.isLive(b)) return; // someone despawned mid-walk
        if (!aArrived) aArrived = this.rovers.approachStep(a, targetA.x, targetA.z, deadline);
        if (!bArrived) bArrived = this.rovers.approachStep(b, targetB.x, targetB.z, deadline);
        await new Promise((r) => setTimeout(r, 100));
      }
      this.rovers.facePartner(a, b);
      this.rovers.facePartner(b, a);

      inst.broadcast({ t: 'roverchat', a: a.occ.id, b: b.occ.id, on: true });

      handshakeId = dbq.insertHandshake(a.userId, b.userId, inst.id);
      const transcript: TranscriptLine[] = [];
      const roverRows = {
        a: dbq.getRover(a.userId)!,
        b: dbq.getRover(b.userId)!,
      };

      for (let turn = 0; turn < TOTAL_TURNS; turn++) {
        if (!this.isLive(a) || !this.isLive(b)) throw new Error('rover despawned mid-handshake');
        const speaker: 'a' | 'b' = turn % 2 === 0 ? 'a' : 'b';
        const state = speaker === 'a' ? a : b;
        const user = dbq.getUserById(state.userId);
        const apiKey = user?.api_key_enc ? decryptApiKey(user.api_key_enc) : null;
        if (!apiKey) throw new KeyInvalidError(`no usable key for rover ${state.userId}`);

        // own lines become assistant turns, the partner's become user turns
        const messages = transcript.map((line) => ({
          role: line.speaker === speaker ? ('assistant' as const) : ('user' as const),
          content: line.text,
        }));
        if (messages.length === 0) {
          messages.push({ role: 'user', content: 'You approach another rover. Greet them.' });
        }

        let text: string;
        try {
          text = await chatOnce({
            apiKey,
            model: roverRows[speaker].model,
            system: buildSystemPrompt(roverRows[speaker]),
            messages,
          });
        } catch (err) {
          if (err instanceof KeyInvalidError) dbq.setKeyError(state.userId, 'invalid');
          else if (err instanceof OutOfCreditsError) dbq.setKeyError(state.userId, 'out_of_credits');
          throw err;
        }

        transcript.push({ speaker, text: text.slice(0, LINE_MAX_CHARS), at: Date.now() });
        turnsDone++;
        dbq.updateHandshakeTranscript(handshakeId, JSON.stringify(transcript));
      }

      dbq.finishHandshake(handshakeId, 'done', null);
      const day = todayUTC();
      dbq.setLastHandshakeDay(a.userId, day);
      dbq.setLastHandshakeDay(b.userId, day);
      await new Promise((r) => setTimeout(r, LINGER_MS));
    } catch (err) {
      if (handshakeId != null) {
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof RateLimitError) {
          dbq.finishHandshake(handshakeId, 'error', 'rate limited');
        } else if (turnsDone >= 2) {
          // a real exchange happened; keep it and burn both quotas
          dbq.finishHandshake(handshakeId, 'partial', msg);
          const day = todayUTC();
          dbq.setLastHandshakeDay(a.userId, day);
          dbq.setLastHandshakeDay(b.userId, day);
        } else {
          // barely started: no quota burn, the pair can retry later today
          dbq.finishHandshake(handshakeId, 'error', msg);
        }
      }
    } finally {
      inst.broadcast({ t: 'roverchat', a: a.occ.id, b: b.occ.id, on: false });
      for (const state of [a, b]) {
        state.busy = false;
        state.phase = 'idle';
        state.idleUntil = Date.now() + 2000 + Math.random() * 4000;
        state.target = null;
      }
    }
  }
}
