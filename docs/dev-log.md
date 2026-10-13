# Development Log — Gemini Free-Tier Router

Chronological record of every error encountered during development, its root cause,
and the fix. Covers the v0.2 hardening session (2026-10-12 → 2026-10-13).

**Current status (after the bug-fix session + the SPEC §7 hardening session):**

| Check | Result |
|---|---|
| `npx tsc --noEmit` | 0 errors (was 34) |
| `npx eslint .` | 0 errors (was 6) |
| `npm test` | 88/88 pass (was 27/27, with a broken 28th file) |

CI is green on GitHub: run #1 (`test` + `lint`, 16s, ubuntu/Node 22.x) passed on
push `d3e63be`, 2026-10-13. The `docker build` item no longer depends on this
machine — it is now a third CI job (build + container `/healthz` smoke); close
§3.4's last box once that job's first run is green.

---

## 1. Errors encountered & solutions

### 1.1 Duplicate `tierHint` → `SyntaxError` (baseline blocker)

- **Symptom:** `SyntaxError: Identifier 'tierHint' has already been declared` at
  `src/server.ts:536` — the file could not even be parsed; zero tests could run.
- **Root cause:** The initial commit (`298446b`) contained the same
  `function tierHint()` twice (lines 390 and 536). The commit message claimed
  "all 27 tests passing" but the committed file was broken.
- **Complication:** A `git checkout HEAD -- src/server.ts` during debugging
  *re-introduced* the duplicate, because the baseline itself was broken. Lesson:
  verify a restored baseline parses before trusting it.
- **Solution:** Deleted the second declaration, keeping the one used by the
  `x-gfr-tier` header path (`server.ts:132`).

### 1.2 Server test 2: `500 !== 200` ("429 daily falls back to second model")

- **Symptom:** The fallback test expected `200` but got `500`; a trailing
  `TypeError: Cannot read properties of undefined (reading 'json')` appeared after
  the TAP output.
- **Misdiagnosis (time lost here):** Initially blamed the 429 handler
  (`markDoneForDay`) and the `learnLog` scope change. Re-adding `markDoneForDay`
  did not help — it was already correctly present in the baseline.
- **Root cause:** The 429-fallback call to `proxyUpstream()` passed **neither**
  `upstream` **nor** `_retrySameModel: true`. Inside `proxyUpstream`,
  `ctx._retrySameModel` was falsy so no fresh fetch happened, and
  `let upstream = ctx.upstream!` evaluated to `undefined`; the next line
  `await upstream.json()` threw → Hono returned 500.
  The normal (non-429) path at `server.ts:248` passed `upstream`, which is why
  every other test passed.
- **Solution:** Added `_retrySameModel: true` to the fallback ctx so
  `proxyUpstream` re-fetches from the newly picked model. The existing
  `_retrySameModel` branch was purpose-built for this and was simply never
  wired up.
- **Verification:** server tests 5/5, full suite 27/27.

### 1.3 34 TypeScript errors (`tsc --noEmit`)

Grouped by cause:

| # | Errors | Root cause | Solution |
|---|---|---|---|
| a | `Cannot find name 'OpenAIEmbeddingRequest'`, `'openaiToGeminiEmbedding'`, `'geminiToOpenAIEmbedding'` | Embeddings code existed but was never imported | Added to the `types.ts` / `translate.ts` import lists in `server.ts` |
| b | `Cannot find name 'GeminiRequest'`, `'GeminiContent'` (translate.ts) | These types were **referenced but never defined anywhere** | Defined `GeminiContent`, `GeminiRequest`, `GeminiResponse` in `src/types.ts` and imported them in `translate.ts` |
| c | `Cannot find name 'controller'` (embeddings route) | `controller` was declared only in the chat handler scope; embeddings route used it without declaring | Added `new AbortController()` + `onClientClose(c, () => controller.abort())` to the embeddings route |
| d | `TS2769: No overload matches` on `c.json(..., upstream.status)` | `upstream.status` is `number`; Hono expects literal status unions | Cast to `400 \| 401 \| 403 \| 404 \| 429 \| 500 \| 502 \| 503` (same pattern as the chat route) |
| e | `TS2345: Argument of type 'number' is not assignable to '{ burn_curve ... }'` ×5 | The `pacing` constructor param was inserted as the **3rd** positional arg, shifting `flushEveryMs`; every existing call site passed a number there | Reordered `QuotaLedger` constructor to `(fleet, store, flushEveryMs, pacing)`; production call sites now pass `cfg.pacing` as 4th arg; test call sites (`..., 0`) stay valid |
| f | `usageMetadata` / `promptFeedback` not on inferred types; implicit `any` on `p` | Inline structural types in `geminiToOpenAI`/`parseGeminiSseLine` had **misplaced braces** (`candidates?: { content?: ... }[]` instead of an array of candidates) and omitted `finishReason`/`promptFeedback`/`usageMetadata` | Switched all four signatures to the new `GeminiResponse` type |
| g | `TS2345` on `emb` in `/admin/simulate` | `role: "user"` widened to `string`, not the `"user"` literal | Annotated `const emb: OpenAIChatRequest` |

### 1.4 Ledger tests failing after the constructor reorder (2/9 → then 7/9)

- **Symptom:** "reserve/commit within limits" and "RPM window blocks burst"
  failed with `req 2` / `burst 2` (expected reserve to succeed).
- **Root cause:** Two stacked causes:
  1. Tests build ledgers as `new QuotaLedger(fleet, store, 0)`. Before the
     reorder, `0` landed in the `pacing` slot — and because `(0).burn_curve` is
     `undefined`, the burn-curve check silently never ran. After the reorder,
     `0` correctly became `flushEveryMs` and the default `pacing = { burn_curve: "even" }`
     became **active** in tests for the first time.
  2. The `even` burn implementation itself was broken (see 1.5).
- **Solution:**
  - Constructor default changed to `front-loaded` (no pacing unless explicitly
    configured). Production still passes `cfg.pacing` explicitly (config default
    remains `even`), so behavior is config-driven where it matters.
  - Fixed the `even` algorithm (1.5) and moved the `rpd-exhausted` check *before*
    the burn check so true exhaustion sets `doneForDay` instead of returning a
    wait.
- **Verification:** ledger tests 9/9 with the burn curve genuinely testable.

### 1.5 Burn-curve `even` implementation was permanently blocking models

- **Symptom (found during 1.4):** With `even` active, a model refused all
  requests after only `ceil(rpd/24)` total requests for the day.
- **Root cause:** The check was `if (s.rpd > ceil(lim.rpd / 24)) block`.
  `s.rpd` is a **day-cumulative counter that never decreases within the day**,
  so once it crossed the (tiny) hourly cap the condition stayed true forever —
  the model was bricked until the PT midnight reset. It also ignored *time*:
  2 requests in the first minute and 2 requests at 23:00 were treated alike.
- **Solution:** Stateless time-based pacing:

  ```ts
  elapsedMs = 86_400_000 - msUntilPtMidnight(now)
  allowed   = max(1, ceil((elapsedMs / 86_400_000) * lim.rpd))
  if (s.rpd >= allowed) → { waitMs: ms until next slot, reason: "rpd-hourly-cap" }
  ```

  At any point in the PT day at most `ceil(elapsed/24h × rpd)` requests have
  been used; the wait resolves as allowance grows. `candidates()` and
  `minWaitMs()` already consume `canServe()` results, so the scheduler picks the
  wait up for free. Documented in README; `GFR_BURN_CURVE=even|front-loaded`
  env override added in `config.ts` (README had promised it — it never existed).

### 1.6 ESLint: 6 errors (first lint run of the project)

| Location | Error | Solution |
|---|---|---|
| `scheduler.ts:28` | `no-useless-assignment` — initial value of `last` never read (loop body always assigns before the break) | `let last!: ReserveResult;` (definite-assignment assertion) |
| `server.ts:364` | unused `now` in `/admin/simulate` | removed |
| `server.ts:437` | `no-explicit-any` — `proxyUpstream(c: any, ...)` | typed as Hono `Context` (`import type { Context } from "hono"`) — compiled clean immediately |
| `server.ts:468` | `prefer-const` — `let upstream` never reassigned | `const` |
| `translate.ts:73` | `no-extra-boolean-cast` — `!!` in a ternary condition | dropped the outer `!!` |
| `translate.ts:206` | `no-explicit-any` — `(d: any)` in embedding SSE mapper | cast `JSON.parse` result to `{ data?: Array<{ embedding: number[]; index: number }> }` |

Tooling note: ESLint 9 flat config (`eslint.config.mjs`) with
`js.configs.recommended` + `typescript-eslint` `recommended`, verified against
typescript-eslint docs via Context7.

### 1.7 Dockerfile was unbuildable

- **Symptom:** `RUN npx tsc` followed by `CMD ["node", "dist/src/server.js"]`.
- **Root cause:** `tsconfig.json` sets `"noEmit": true`, so `npx tsc` type-checks
  and emits **nothing** — `dist/` never exists and the container crashes on start.
- **Solution:** The project runs TypeScript directly (Node ≥ 22.18 native type
  stripping — confirmed via Node.js docs: flagless since 22.18.0; `bin/gfr.mjs`
  and the `start` script already rely on this). Rewrote the Dockerfile as a
  single stage: `npm ci --omit=dev`, copy `src/`, `CMD ["node", "src/cli.ts"]`.

### 1.8 CI workflow broken on ubuntu (2 defects)

1. **Test step:** `node --test "test\*.test.ts"` — Windows backslash glob, no
   match on ubuntu. Fix: `npm test` (the package script uses the correct
   forward-slash glob; GitHub's Node.js guidance also standardizes on `npm test`).
2. **Lint step:** `npx eslint . --ext .ts` — ESLint was not a dependency and no
   config existed, and `--ext` is removed in flat-config ESLint 9. Fix: added
   `eslint`, `@eslint/js`, `typescript-eslint` devDeps + `eslint.config.mjs`,
   step is now plain `npx eslint .`; also added `cache: npm` to `setup-node`.

### 1.9 `learnLog` test-isolation change (initially misdiagnosed)

- **Context:** Moving `learnLog` from module scope into `createApp()` (per-app
  state) appeared to break test 2. It did not — 1.2's missing `_retrySameModel`
  was the real cause; module-level shared state had been *masking* a bug that
  only surfaces on the fallback path.
- **Research basis:** Node test-runner best practices (Tavily) — "no shared
  mutable state, no execution order dependencies"; Hono factory pattern
  (Context7) — app-scoped state inside the app factory.
- **Final state:** `const learnLog: LearnLogEntry[] = []` inside `createApp()`;
  every app instance (and therefore every test) gets an isolated log.
  Verified: 27/27 after the move.

### 1.10 Duplicate `reqToBody` created during cleanup

- **Symptom:** Would have been `SyntaxError: Identifier 'reqToBody' has already
  been declared`.
- **Cause:** An edit meant to *delete* the dead helper accidentally prepended a
  second copy above `export { sleep }`.
- **Solution:** Removed both — the helper was unused (`noUnusedLocals` was off,
  so `tsc` never complained).

### 1.11 README duplicated "Optional headers" paragraph

- The burn-curve docs edit re-appended the "Optional headers" line already
  present under Endpoints. Removed the duplicate.

### 1.12 Windows/PowerShell environment failures (session-long)

Workarounds used throughout (not project bugs, but they shaped the workflow):

| Broken | Workaround |
|---|---|
| `&&` / `||` → `ParserError` | chain with `;` or run separate calls |
| `grep`, `head`, `tail`, `wc` → not found | use the `grep` tool / `findstr` / dedicated read tools |
| `pwsh` → not recognized | plain `node`, `npx`, `powershell -Command` |
| `$LASTEXITCODE` interpolated by outer shell → `-eq : not recognized` | run commands separately; check output directly |
| Paths with spaces break `findstr`/`Get-Content` | use tool-based file reads |
| `git stash` mid-debug restored a broken baseline | `git stash pop` + re-verify parse before running tests |

---

### 1.13 High-priority bug-fix session (2026-10-13)

Fixes for the five "advertised-but-missing" items in §3.1, plus three defects
found while writing their tests.

### 1.13.1 `GFR_DRY_RUN` parsed but never read (bug 1)

- **Symptom:** `config.ts` set `cfg.dry_run` from `GFR_DRY_RUN=1`, but
  `server.ts` never referenced it — dry-run mode was a no-op that still called
  Google.
- **Root cause:** The flag was plumbed through config and never wired into a
  request path (SPEC §141 promises "dry-run mode … without spending quota").
- **Solution:** Dry-run branches in both `POST /v1/chat/completions` and
  `POST /v1/embeddings`, *before* `acquire()`:
  - `pickModelReadonly()` reuses `ledger.candidates()` (identical ranking:
    tier boost + remaining budget) — `candidates()` never reserves, so the
    ledger stays byte-for-byte untouched. Verified in tests by asserting
    `used.rpd === 0` on every model after a dry-run call.
  - Non-streaming → `syntheticCompletion()`; streaming → `syntheticStream()`
    (same frame sequence as a real stream, including the `include_usage`
    trailer); embeddings → zero vector.
  - Responses carry `x-gfr-dry-run: 1`.
  - Admission control still applies: an exhausted fleet still returns `429`.
- **Design note:** dry-run deliberately does *not* touch the local ledger
  either — otherwise dry-run traffic would consume the real RPD/RPM budget it
  is supposed to be simulating. Full "day of traffic" what-if stays in
  `/admin/simulate`, which uses a throwaway ledger.

### 1.13.2 `/admin` HTML dashboard missing (bug 2)

- **Symptom:** README promised "JSON or HTML Accept header"; `GET /admin`
  always returned JSON. No `text/html` path existed in *either* commit
  (`git show 298446b:src/server.ts` has none) — it was never committed, not
  merely "lost in a restore".
- **Root cause:** the renderer was written but only ever lived in the working
  tree, so the next `git checkout` dropped it.
- **Solution:** `renderAdminHtml()` in `server.ts` — a zero-dependency page
  (no assets, no build step) with per-model RPD/RPM/TPM/in-flight tables, a
  day-burn bar, PT-reset countdown, router counters, the last parsed 429s,
  `<meta http-equiv="refresh" content="30">`, and an escape hatch back to the
  JSON view. Content negotiation is one line:
  `if ((c.req.header("accept") ?? "").includes("text/html")) return c.html(...)`.

### 1.13.3 Duplicate `/admin` and `/metrics` routes (found during 1.13.2)

- **Symptom:** none visible — this one was silent.
- **Root cause:** `server.ts` registered **both** `/admin` and `/metrics`
  twice. Hono matches the *first* registration, so the richer second copies
  (the ones with the `learned` log and the `gfr_model_in_flight` gauge) were
  dead code: `/admin` never showed parsed 429s and `/metrics` never exported
  in-flight counts, contradicting the README and SPEC §141.
- **Solution:** deleted the first (poorer) pair, kept the second, added
  HTML to the survivor. Both endpoints now serve every documented field.

### 1.13.4 `/admin/simulate` divided by hours twice (bug 3)

- **Symptom:** `utilization_percent` returned absurd values (e.g. `180000`)
  for any spec with `hours ≠ 1`.
- **Root cause:** `served / (spec.hours * spec.rps * spec.hours)` — `hours`
  appeared twice; the denominator is neither offered load nor capacity.
- **Solution:** `utilization_percent = served / offered × 100` where
  `offered = ceil(hours × 3600 × rps)` (capped, see 1.13.5). Reported
  alongside explicit `offered` / `served` / `rejected` counts so the number is
  auditable. Regression test asserts `utilization_percent ≤ 100` for
  `hours: 2`, which the old formula fails at 180000%.

### 1.13.5 `/admin/simulate` ran in real time (bug 4)

- **Symptom:** one simulated hour took one real hour — the endpoint was
  unusable (SPEC asks for "a day of traffic" in one call: 86400 real seconds).
- **Root cause:** `await sleep(1000/rps)` inside the loop — real timers, real
  clock, plus a **second** real-time trap: `acquire(..., { maxWaitMs: 5_000 })`
  could sleep up to 5s *per rejected request*.
- **Solution:** virtual clock.
  - `acquire()` gained an optional `opts.now` (`AcquireOpts`); every ledger
    call (`reserve` / `candidates` / `minWaitMs`) and the deadline now go
    through `const clock = () => opts.now ?? Date.now()`, so production
    behaviour is bit-identical when the option is omitted.
  - The loop advances `simNow += 1000/rps` per arrival instead of sleeping,
    and passes `maxWaitMs: 0` so it can never wait in real time.
  - Cap: `MAX_SIM_REQUESTS = 100_000` with a `truncated: boolean` flag — a
    fat-fingered `{hours: 500, rps: 1000}` no longer pins the event loop.
  - Simulated ledger now uses a new `MemoryStore` (was `openStore(path +
    ".sim")`, which read/wrote real files next to the production ledger).
- **Verification:** 2 simulated hours at 1 rps (7200 arrivals) complete in
  milliseconds (test asserts `< 10s`; previously 7200s).

### 1.13.6 Two extra defects inside `/admin/simulate` (found by inspection)

| Defect | Effect | Fix |
|---|---|---|
| `simLedger.commit(emb.model, …)` used `emb.model === "auto"` | `"auto"` is not a fleet entry → `commit()` no-oped → `inFlight` never decremented → the in-flight cap filled after `max(2, rpm/2)` requests and *everything* afterwards was rejected | commit against `acq.pick.model` |
| `avg_tokens` was validated but never used | the simulated traffic was always the 16-token `"hello"` | request content length is derived from `avg_tokens` so `estimateInputTokens` lands on the requested size |

### 1.13.7 Streaming `include_usage` sent `usage: null` (bug 5)

- **Symptom:** the final SSE chunk before `[DONE]` was
  `{ choices: [], usage: null }` — OpenAI clients that read
  `stream_options.include_usage` got nulls.
- **Root cause:** two layers of stub: the trailer hard-coded `usage: null`,
  and `geminiChunkToOpenAI` contained an **empty** `if (done && includeUsage)`
  branch (comments only — the TODO never got a body).
- **Solution:**
  - `server.ts` accumulates Gemini's `usageMetadata` across frames
    (`promptTokenCount` / `candidatesTokenCount` / `totalTokenCount`, merged
    per field because Gemini often emits them only on the last frame).
  - The trailer now emits `usage: { prompt_tokens, completion_tokens,
    total_tokens }`, falling back to `est` for the prompt count.
  - `geminiChunkToOpenAI` now implements the OpenAI wire format properly:
    content chunks carry `usage: null` when `include_usage` is set.
  - Ledger commit switched from the old prompt-only `lastUsage` to
    `promptTokens ?? est` (same value, now sourced from the accumulator).

### 1.13.8 `GFR_TOKEN` auth returned **500 instead of 401** (found by the new test)

- **Symptom:** the first new auth test got `500 !== 401`.
- **Root cause:** the middleware did `c.json(...); return;` — in Hono a
  middleware that ends the response must **return** the response object.
  Returning `undefined` without calling `next()` makes Hono throw
  `Nothing is returned from the handler` → 500. So every unauthorized request
  with `GFR_TOKEN` configured returned a server error instead of
  `authentication_error`, and the 401 path had simply never been tested.
- **Solution:** `return c.json(openaiError(401, …), 401)`.
- **Lesson:** this is exactly why the §3.3 coverage list mattered — the
  feature was "implemented" and unusable.

### 1.13.9 The untracked `embeddings_simulate_auth_tier_sqlite.test.ts` was broken

- **Symptom:** `npm test` reported `# fail 1` before any of this work: the
  file failed to parse (`ERR_INVALID_TYPESCRIPT_SYNTAX: Property assignment
  expected`) from an orphaned `.then((r) => r.json())` left behind by a
  previous partial rewrite.
- **Solution:** deleted it and wrote `test/coverage_gaps.test.ts` from
  scratch — 21 tests covering every §3.3 gap **and** acting as regression
  tests for all five fixes above. Full suite: 48/48.
- **Environment note:** Node 22.18's flagless type-stripping is *not* a
  full TypeScript parser; malformed leftovers fail at module-load time and
  take the whole test file down, so parse errors surface as a single
  `not ok 1 - test\…` rather than a per-test failure.

### 1.14 SPEC §7 / v0.2 hardening session (2026-10-13)

Closes every item in §3.2 (SPEC §7 gaps) plus the §3.4 version bump.

#### 1.14.1 Rolling quality re-ranking (§7.4)

- **Gap:** `candidates()` ranked by `tierBoost + remaining` only — SPEC §7.4 wants
  chains "re-ranked continuously by *remaining daily budget* + recent quality
  (rolling success/latency)".
- **Solution:** `ModelState.quality = { emaOk, emaLatencyMs, samples }`, fed by
  `ledger.noteOutcome(model, ok, latencyMs)` (EMA α = 0.2). Rank is now
  `tierBoost + remaining × (0.5 + q)`, where
  `q = emaOk × 2000 / (2000 + emaLatencyMs)` and `q` stays neutral `0.5` until
  3 samples exist.
- **Backwards compatibility:** neutral `q` makes the weight exactly `1.0×`, so the
  pre-existing budget ordering (and every old test) is unchanged until real
  traffic arrives. Verified by three ranking tests: failures demote, successes
  promote, and latency costs.
- **Surfaced everywhere it matters:** `LedgerSnapshot.quality`, `/admin`'s new
  "quality (ok · lat · n)" column, `gfr_model_success_ema` /
  `gfr_model_latency_ema_ms` gauges, and the `flush()`/`restore()` persistence
  path (a restart must not forget which models were failing).
- **Why not a plain sort by quality:** `remaining` can differ by 25× between
  models; budget must stay dominant, with quality breaking ties among peers —
  exactly the SPEC wording.

#### 1.14.2 Jitter for router-owned timers (§7.3)

- `jitter(ms, spread = 0.2)` in `src/time.ts`, applied to the queue-poll sleep in
  `acquire()`, the ledger flush interval, and the ambiguous-429 backoff.
- **Deliberately *not* applied to Google's `RetryInfo.retryDelay`** — README and
  SPEC §129 promise it is honored exactly (0s → 5s floor). Locked by the test
  "known-kind 429 keeps honoring Google's retryDelay exactly" (38 000ms, no jitter).
- **Bug in the first draft:** `min(jitter(min(window, 250)), 250, budget)` jittered
  *before* capping, so every draw above 250 was clamped back down — the sleep
  distribution was skewed low instead of symmetric. Rewrote as
  `cap = min(window, 250, budget); wait = min(jitter(cap), budget)`, which keeps
  the distribution symmetric and can never sleep past the caller's deadline.

#### 1.14.3 Ambiguous 429 backoff (§130) — and the retry path was dropping 429 forensics

- SPEC §130: "if still ambiguous → capped exponential backoff (1s–60s, jittered)".
  Previously `kind: "unknown"` produced *no* cooldown, so the fallback loop could
  hammer a model nobody could classify. Added `ambiguousBackoff(attempt)`
  (1s, 2s, 4s … capped 60s, ±20% jitter) plus a per-model attempt counter that
  resets the next time that model succeeds.
- **Found while testing it:** the same-model retry inside `proxyUpstream()`
  (`_retrySameModel`) treated every non-OK response as a generic upstream error —
  a 429 there was never classified, never cooled down, never logged, and never
  counted in `metrics.upstream429`. Extracted the whole 429 path into a single
  `handle429(model, body, latencyMs)` closure in `createApp()` and routed **both**
  entry points through it (`on429` on `ProxyCtx`).
- **Why one closure, not copy-paste:** the backoff counter, `learnLog`, and the
  structured log live in `createApp()`'s scope while two call sites need them.

#### 1.14.4 Golden fixture corpus (§7.5 / §249)

- `test/fixtures/429-corpus.json` manifest + `test/forensics_corpus.test.ts`
  driver: every `429-*.json` fixture must be listed (orphan check in both
  directions) and must classify exactly as declared (kind, quotaId, quotaMetric,
  learnedLimit, model, minimum retry delay).
- Two new payloads to complete SPEC §249's required set: `429-missing-details.json`
  (no `details` array — metric/limit/model live only in the message) and
  `429-ambiguous.json` (no metric, no quotaId, no delay → `unknown`).
- Plus an adversarial "never throws" test (null, numbers, arrays, wrong-typed
  `details`, garbage `retryDelay`) that also asserts the 5s floor.

#### 1.14.5 Classifier: trust `quotaMetric`, parse what's in the message (§126/§130)

- SPEC §130: "Conflicting signals → trust `quotaMetric` over `quotaId`". The old
  code checked `quotaId PerDay` first, so a payload whose *metric* said tokens but
  whose *id* said PerDay classified as `daily`. Rewritten as a family decision:
  `family = metricFamily ?? idFamily`, then day/minute is resolved *within* the
  requests family only.
- **Found by the corpus test:** `quotaMetric` came back `undefined` for the
  missing-details fixture — Google sometimes omits `details` entirely. The metric
  is now also read from the message (`Quota exceeded for metric: …`), which is
  what lets that fixture learn its `limit:` instead of falling into `unknown`.
- `retryDelay` present with no family signal now classifies as `minute` (delay
  honored, 5s floor) instead of `unknown` — SPEC §129's "retryDelay < ~10min →
  minute throttle", and it correctly covers `retryDelay: 0s`. Only genuinely
  signal-less payloads stay `unknown` (→ §1.14.3 backoff).

#### 1.14.6 Structured JSON logger (§7.8 / §141)

- `src/log.ts`: one JSON object per line on **stderr** (`ts`, `level`, `event`,
  plus event fields), `GFR_LOG=debug|info|warn|error|off`, CLI default `info`,
  embed default `warn`, `createApp` default `silentLogger` (tests stay quiet
  unless they inject a capture logger).
- Cycle-safe: a `JSON.stringify` throw logs a `log_error` field instead of
  escaping into the request path.
- **Kept `console.log` for the banner on purpose** — mixing human text into the
  JSON stream would break `jq` on a redirected log file. Two streams, two jobs.
- Events wired: `listening`, `served` (model + latency, streaming and not),
  `quota_signal` (SPEC §132's structured parsed signal), `rejected`
  (`fleet_exhausted` / `upstream_quota`), `upstream_error`.

#### 1.14.7 Keep-alive pool (§7.6 / §135)

- `src/pool.ts` installs an undici `Agent` as the *global* dispatcher
  (`connections: 16`, `keepAliveTimeout: 30s`, `pipelining: 1`, connect timeout
  10s; all overridable via `GFR_POOL_*`). Node's `fetch` resolves its dispatcher
  from the shared well-known symbol `Symbol.for("undici.globalDispatcher.1")`, so
  this covers every upstream call without threading a `dispatcher` through each
  `fetch`.
- **Verified empirically, not assumed:** a scratch script set `connections: 1`
  and fired 3 concurrent fetches at a local server — exactly **1** TCP connection
  was accepted. That proof is now the test "concurrent upstream calls reuse one
  socket".
- `undici@^7.30.0` added to `dependencies` (the project's first new runtime dep).

#### 1.14.8 Infra, version, smoke test

- `package.json` version `0.1.0` → `0.2.0`; added the `lint` script.
- **ESLint's first error of the session:** `no-undef: 'console'/'process' is not
  defined` in `smoke-upstream.mjs`. typescript-eslint only turns `no-undef` off
  for TS files, so plain `.mjs` scripts have no Node globals declared. Fixed in
  `eslint.config.mjs` with a `files: ["**/*.mjs", "**/*.js"]` block declaring the
  Node globals (rather than special-casing one file).
- Added `.dockerignore` — the build context was shipping `node_modules`, `data/`,
  docs, and tests.
- **Environment-blocked on this machine:** no `docker` CLI, so `docker build`
  cannot run locally. Rather than leave it blocked, `docker` was added as a CI
  job (GitHub runners ship Docker): image build + boot + `/healthz` probe — see
  §3.4; its first green run closes the item. CI did not need a local `gh` either —
  it ran on GitHub itself once the code was pushed (§3.4, run #1 green).
- **Repo hygiene:** the `license` field said MIT but there was **no LICENSE file** —
  added one (MIT, 2026 Owais Abdullah), plus README badges (CI/license/node), a
  README Docker section (the Dockerfile existed but was never documented), and
  `package.json` `author`/`repository`/`bugs`/`homepage` fields.
- **Live smoke test** (fake upstream answering an ambiguous 429 —
  `smoke-upstream.mjs` + `smoke-config.json`): banner on stdout; on stderr
  `{"event":"listening",…}`, `{"event":"quota_signal","kind":"unknown","retry_delay_ms":1092}`,
  and both `rejected` reasons; `/admin` HTML served with the quality column;
  `gfr_model_success_ema` exported; the second request correctly short-circuited
  to `fleet_exhausted` while the model was in backoff.

### 1.15 Fleet maintainability — models & limits without code edits (2026-10-13)

**Requirement:** models get released and deprecated, and Google revises free-tier
limits — both must be maintainable without editing `src/config.ts`.

- **Design — `fleet_mode` + `disabled` (`config.ts`):**
  - `replace` (default): the config file's `fleet` *is* the whole fleet. The old
    semantics were already "replace", and staying there was deliberate: flipping
    the default to merge would have silently injected 11 default models into
    existing single-model configs (like `smoke-config.json`), changing which
    models absorb quota — the kind of quiet breakage that mis-schedules traffic.
  - `merge`: config entries overlay `DEFAULT_FLEET` by model id — listed ids
    override only the fields they provide, unknown ids (new models) are
    appended, `disabled: [ids]` drops deprecated ones.
- **Boot-time validation (`validateFleet`):** a misconfigured fleet must not
  run — non-numeric or negative `rpm/rpd/tpm`, unknown `tier`/`modality`,
  duplicate ids, an empty fleet (e.g. after disabling everything), and
  incomplete appended models all throw with the model id in the message. A
  `fleet_mode` typo (`mrege`) throws naming the allowed values instead of
  silently running in replace mode.
- **Learned limits vs config edits (`ledger.ts`):** `limits()` prefers values
  self-learned from 429 payloads — which would let a *stale* learned value
  shadow a user's config edit forever. `ModelState.learnedCfg` now records the
  configured limits each learned value was derived against; `restore()` drops
  learned values whose marker no longer matches the current config (your edit
  wins on restart), and adopts the current config as the baseline for
  pre-marker ledger files so their *next* edit invalidates them too.
- **Tests (`test/fleet_maint.test.ts`, 12):** replace-mode regression, merge
  override/append, `disabled` in both modes, empty-after-disabled, all five
  validation errors, the shipped `router.example.yaml` staying loadable, and
  three learned-vs-config restart scenarios (kept / invalidated / legacy file).
- Docs: README "Maintaining the fleet", `router.example.yaml` header comment,
  llms.txt bullet.

---

## 2. Verification commands

```sh
npx tsc --noEmit        # typecheck (expect: no output)
npx eslint .            # lint (expect: no output) — or: npm run lint
npm test                # 88 tests, expect "# pass 88 / # fail 0"
```

Live smoke (local fake upstream answering an ambiguous 429):

```sh
# terminal 1 — fake Gemini that always 429s (see §1.14.8)
node smoke-upstream.mjs
# terminal 2
GEMINI_API_KEY=fake GFR_LOG=debug node src/cli.ts --config smoke-config.json
curl -i localhost:8791/v1/chat/completions -H 'content-type: application/json' \
     -d '{"model":"auto","messages":[{"role":"user","content":"hi"}]}'
# stderr must show: {"event":"quota_signal","kind":"unknown","retry_delay_ms":~1000,...}
```

---

## 3. Remaining tasks

### 3.1 Bugs / advertised-but-missing behavior (high priority) — ✅ all fixed

- [x] **`GFR_DRY_RUN` does nothing.** → wired into chat + embeddings; see
      §1.13.1 (`x-gfr-dry-run: 1`, admission control only, ledger untouched).
- [x] **`/admin` HTML dashboard missing.** → `renderAdminHtml()` restored;
      see §1.13.2. (Also un-shadowed the duplicate route — §1.13.3.)
- [x] **`/admin/simulate` utilization formula bug.** → now `served / offered`;
      see §1.13.4.
- [x] **`/admin/simulate` runs in real time.** → virtual clock via
      `acquire({ now })` + 100k cap; see §1.13.5.
- [x] **Streaming `stream_options.include_usage` sends `usage: null`.** →
      real counts accumulated from Gemini `usageMetadata`; see §1.13.7.

Found and fixed along the way: `GFR_TOKEN` auth returned 500 instead of 401
(§1.13.8), duplicate `/admin` + `/metrics` routes (§1.13.3), and two
`/admin/simulate` defects (§1.13.6).

### 3.2 SPEC §7 gaps (v0.2 scope) — ✅ all closed

- [x] **Fallback quality re-ranking** (§7.4): rolling success/latency EMA in the
      ledger re-ranks candidates (`remaining × (0.5 + q)`, neutral before 3
      samples); see §1.14.1. Exposed on `/admin`, `/metrics`, and snapshots.
- [x] **Timer jitter** (§7.3): `jitter()` on queue polls, the ledger flush tick,
      and the ambiguous-429 backoff — never on Google's `retryDelay`; see
      §1.14.2 (includes the skew bug found in the first draft).
- [x] **Golden fixture corpus** (§7.5): `test/fixtures/429-*.json` (6 payloads)
      + `429-corpus.json` manifest + manifest-driven runner with an orphan check;
      see §1.14.4. (Inline forensics tests kept as documentation.)
- [x] **Structured logs** (§7.8): `src/log.ts` JSON lines on stderr, `GFR_LOG`,
      `quota_signal` event for §132; see §1.14.6.
- [x] **Keep-alive pool** (§7.6): undici `Agent` as global dispatcher, proven to
      collapse concurrent calls onto one socket; see §1.14.7.

Also closed while implementing the above: ambiguous-429 exponential backoff
(§130), metric-over-id classification, message-only `quotaMetric` parsing, and
429 forensics being silently skipped on the same-model retry path (§1.14.3–5).

### 3.3 Test coverage — ✅ complete (88 tests)

- [x] `test/fleet_maint.test.ts` (12) — fleet `replace`/`merge`/`disabled`
      semantics, boot-time validation errors, `router.example.yaml` load, and
      learned-limit invalidation across restarts (§1.15).
- [x] `test/coverage_gaps.test.ts` (21) — `POST /v1/embeddings` happy/400/500,
      `POST /admin/simulate` validation + accelerated-clock formula regression +
      100k cap, `GFR_TOKEN` auth 401/401/200/open, `x-gfr-tier` ranking,
      `SqliteStore` round-trip + `JsonStore` fallback, `MemoryStore`, dry-run ×4,
      admin HTML/JSON ×2, `include_usage` ×2.
- [x] `test/forensics_corpus.test.ts` (8) — golden 429 corpus with orphan check
      + adversarial never-throws net (SPEC §249).
- [x] `test/v02_features.test.ts` (20) — jitter bounds, ambiguous-backoff cap,
      logger levels/shape/cycle-safety/`GFR_LOG`, quality ranking ×4 + snapshot +
      flush/restore, server wiring (quality feed, `quota_signal`, backoff growth,
      exact `retryDelay` honoring, admin/metrics surfacing), pool dispatcher +
      single-socket reuse.
- [x] Pre-existing suites: scheduler, ledger, translate, forensics, server,
      storage.

### 3.4 Infra

- [x] `package.json` version bumped `0.1.0` → `0.2.0` (matches spec/README);
      `lint` script and `.dockerignore` added (§1.14.8).
- [x] **Git remote + CI** — code pushed to
      `github.com/MrOwaisAbdullah/gemini-free-router`; GitHub Actions run #1 on
      `d3e63be` passed **both jobs** (`test` + `lint`, 16s total, ubuntu-latest /
      Node 22.x), 2026-10-13. The workflow's first-ever execution was green, so
      `.github/workflows/ci.yml` is now proven rather than assumed.
- [x] **Repo metadata** — `LICENSE` (MIT file), README badges + Docker section,
      `package.json` `author`/`repository`/`bugs`/`homepage` (§1.14.8).
- [ ] **Docker build — moved into CI** (local machine has no `docker` CLI, so a
      third job `docker` in `.github/workflows/ci.yml` now runs on every push:
      `docker build --pull` + boot the container with a dummy key + poll
      `/healthz` for ≤30s, printing `docker logs` either way). Close this box on
      the first green `docker` job run.

### 3.5 Roadmap (SPEC §17, out of current scope)

- **v0.3** — budget allocator / QoS tiers (beyond the `x-gfr-tier` header),
  `custom` burn-curve curves, dry-run simulator polish.
- **v1.0** — docs site, benchmark report ("requests/day extracted from one free
  key"), community model-limit registry.
