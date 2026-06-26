# Test corpus & batch rover simulation

_Implemented 2026-06-18 (branch `rovers`)._

## Why this exists

We needed to test rover↔rover interaction at scale without a persistent server
loop quietly burning OpenRouter credits. The goals:

1. A corpus of **synthetic test users** that can be created, hand-drawn, and made
   to interact on demand — kept isolated from real accounts.
2. Removal of the 2 obsolete **code-drawn seed rovers** (`seed_rover_*`, drawn by
   a hand-rolled PNG squiggle generator), now superseded.
3. A **cost strategy**: a single shared, dashboard-capped key, plus a batch
   "simulation" runner that forces _N_ interactions, burns tokens once, reports
   cost, then stops — instead of billing continuously while the server is alive.

Most of the substrate already existed: a "simulated user with a bio + key" is
just a `users`+`rovers` row pair, and mock mode + per-turn token caps were
already in place. The conversation logic just needed to be decoupled from the
live world.

## How it works

### Test/real distinction
- `users.is_test` column (migration #2 in `server/db.ts`). The same migration
  **purges any existing `seed_rover_*` rows** automatically.
- Helpers: `createTestUser`, `deleteUser`, `listTestUsers`, `listActiveTestRovers`.

### Cost firewall (three layers)
1. **Shared key** — all test rovers talk through one `FREEKNET_TEST_API_KEY`.
   Cap its spend with a credit limit in the OpenRouter dashboard. Resolution is
   `resolveApiKey(user)` in `server/handshake.ts`: test rovers → shared key;
   real users → their own encrypted key.
2. **Out of the live loop by default** — test rovers do **not** spawn, wander, or
   auto-handshake unless `FREEKNET_TEST_LIVE=1`. Enforced in three places so the
   world is identical to production: `listActiveRovers` (boot), `isEligible`
   (scheduler), and `onRoverChanged` (runtime activation).
3. **Per-run token budget** — `runSimulation` stops launching once the budget is
   reached. Soft cap: with concurrency C, up to C−1 in-flight conversations can
   overshoot before the pool notices.

### Batch simulation runner (`server/simulate.ts`)
- The conversation core was extracted out of `HandshakeScheduler.runHandshake`
  into a reusable, world-independent `converse(aUserId, bUserId, opts)` in
  `server/handshake.ts`. It inserts the handshake row, runs the 6 alternating
  LLM turns, persists the transcript, and returns `{ turnsDone, status,
  transcript, usage }`. `burnQuota` defaults to **false** so sim runs are
  repeatable (they don't consume the daily quota); the live `runHandshake` now
  wraps `converse` with `burnQuota: true` plus the spatial approach/linger/
  broadcast choreography.
- `runSimulation({ pairs, tokenBudget, concurrency })` loads active test rovers,
  builds unordered pairs (i<j), runs them through a small concurrency pool
  (default 3), and returns a `SimReport`: pairs run, turns, prompt/completion/
  total tokens, **estimated** USD cost (per model), per-conversation transcripts,
  and a `stoppedEarly` flag.
- Token usage now comes from the OpenRouter `usage` block (`server/openrouter.ts`
  returns `{ text, usage }`); mock mode synthesizes a ~4-chars/token estimate so
  the whole flow — including the cost report — works for free.

### Dev page (authoring + hand-drawing)
- `dev.html` + `src/dev.ts`, reachable at `/dev.html`, gated by
  `FREEKNET_DEV_TOOLS=1`. Reuses the existing `createDoodlePad()`.
- Lets you create / draw / edit persona+model+active / delete test rovers, then
  run a simulation and read transcripts + the token/cost report inline.
- Backed by `/api/dev/*` in `server/api.ts`. These routes have **no auth of their
  own** — the env flag is the gate. `applyRoverUpdate()` (shared with the
  user-facing `PUT /api/rover`) does the validation.

## Environment variables

| Var | Default | Effect |
| --- | --- | --- |
| `FREEKNET_DEV_TOOLS` | off | `1` mounts `/api/dev/*` + `/dev.html`. **Local dev only.** |
| `FREEKNET_TEST_API_KEY` | unset | shared OpenRouter key for all test rovers; cap spend in the dashboard |
| `FREEKNET_TEST_LIVE` | off | `1` lets test rovers spawn + auto-handshake in the live world |
| `FREEKNET_LLM_MOCK` | off | `1` = canned dialogue, no real calls (tokens estimated) |
| `FREEKNET_HANDSHAKE_FAST` | off | `1` = sweep every 2s, daily quota ignored |

> **Never set `FREEKNET_DEV_TOOLS=1` (or the test key / test-live) in
> production** — the dev routes are unauthenticated and `POST /api/dev/simulate`
> spends the shared key. Documented in `DEPLOYMENT.md`.

## Usage

Free dogfooding (no real tokens):
```bash
FREEKNET_DEV_TOOLS=1 FREEKNET_LLM_MOCK=1 npm start
# → http://localhost:5173/dev.html : add testers, draw, activate, "run simulation"
```

Real-token run: set `FREEKNET_TEST_API_KEY` to a dashboard-capped key, then run
a simulation with a `tokenBudget` to bound the run. Each handshake is ~6 turns ×
80-token cap ≈ ~480 tokens.

## Key files

- `server/db.ts` — `is_test` migration + helpers; `listActiveRovers` gates on `FREEKNET_TEST_LIVE`.
- `server/handshake.ts` — `resolveApiKey`, extracted `converse`, `isEligible` test-gate.
- `server/simulate.ts` — `runSimulation` (new).
- `server/openrouter.ts` — usage parsing, `estimateCostUsd`, static price map.
- `server/api.ts` — `applyRoverUpdate` refactor + `/api/dev/*` routes.
- `server/rovers.ts` — `onRoverChanged` test-gate.
- `dev.html`, `src/dev.ts`, `src/api.ts` (dev wrappers), `vite.config.js` (multi-page entry).
- `smoketest/{rovers,handshake,simulate}.ts`, `package.json` (`smoke:simulate`, `smoke:all`).
- **Deleted:** `server/seed.ts`.

## Verification status

`typecheck` ✓, `lint` ✓, production build ✓. Smoke tests passing:
`smoke:rovers`, `smoke:handshake` (live `converse` path + wire privacy), and the
new `smoke:simulate` (firewall holds, transcripts produced, token budget honored).

## Gotchas / future work

- The cost estimate uses a **static price map** (`PRICING` in `openrouter.ts`)
  for the 4 whitelisted models — prices drift; trust the OpenRouter dashboard for
  truth. Update the map when adding models.
- The dev page **UI itself** has no automated browser test; its `/api/dev/*`
  backend is fully covered. Manual click-through recommended before relying on it.
- Pairing is combinatorial (all i<j pairs up to the `pairs` limit), so it favors
  earlier rovers when `pairs` < total possible. Fine for testing; revisit if you
  want even coverage.
- The token budget is a soft cap (concurrency overshoot, see above). Use
  `concurrency: 1` for an exact cap.
- `model` is per-rover (set on the dev page); the simulation does not take a
  global model override.
