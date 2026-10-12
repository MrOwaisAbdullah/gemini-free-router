# Gemini Free-Tier Router — Spec (v0.2)

**Status:** research complete 2026-10-12 · spec v0.2, not approved · research + plan only, no code yet
**For:** Owais Abdullah · **Inspired by:** ContentFTE's `blog_agent/custom_runner.py` (`FallbackAgentRunner`) · **Consumed later by:** ContentFTE via OpenAI `base_url` swap
**v0.1 → v0.2 changes:** real 429 payload forensics, self-learning ledger, TPM=input-tokens correction, Hono streaming mechanics, security/testing sections, numbering fixes, refreshed competitor table

---

## 1. The idea in one line

An open-source, OpenAI-compatible proxy that runs on **one Gemini API key / one Cloud project** and squeezes ~100% of the free tier out of it — per-model RPM/RPD/TPM scheduling, request pacing, and quota-aware fallbacks — instead of the industry's standard pattern of bursting into a 429 and rotating keys.

Tagline: *Squeeze 100% out of Gemini's free tier — per-model RPM/RPD/TPM scheduling for a single API key.*

---

## 2. Problem

ContentFTE already runs a quota-aware fallback chain (`FallbackAgentRunner`) that treats each Gemini model as its own quota bucket. It works, but:

- It's **embedded** in the OpenAI Agents SDK pipeline — not reusable by anyone else.
- It's **reactive**: fixed 10-min/5-min cooldowns after a 429, not preemptive.
- It tracks **requests only** — no TPM dimension.
- Daily counters reset at **local midnight**, but Google resets RPD at **midnight Pacific**.
- A flat safety margin (limit − 5) wastes quota instead of pacing it.

The OSS ecosystem (researched 2026-10-12, re-verified same day — see §3) has many routers, but every one of them is a **multi-key / multi-project rotator** or a **multi-provider failover proxy**. Nobody schedules one project's per-model free-tier quotas preemptively.

---

## 3. Competitive landscape (researched + re-verified 2026-10-12)

| Project | Shape | Verdict |
|---|---|---|
| LiteLLM Router (BerriAI/litellm, ~48–61k★, MIT) | OpenAI-compatible proxy + SDK | Per-deployment RPM/TPM caps, fallbacks, cooldowns. Multi-key/multi-provider. **No RPD dimension**, reactive, no per-model daily ledger. ~3–4ms overhead — the latency bar to match. |
| one-api / New API (QuantumNous/new-api, ~50k★, **AGPL-3.0**) / Veloera | Multi-channel key-rotation gateways | Rotation across keys/channels. No per-model free-tier scheduling. AGPL matters if embedding. |
| SlimeyD/gemini-delegator (MIT, 1★) | Embedded Python library | **Closest thing that exists**: per-key per-model daily counters, tiered 429 cooldowns, model fallback chains, PT-midnight reset. But explicitly **multi-key** ("up to 8 projects") — it pools projects, it doesn't maximize one. |
| Mirrowel/LLM-API-Key-Proxy (557★) | Universal gateway | Quota groups + baseline tracking, but multi-credential. |
| gemini-balance family (snailyp, popular) | Gemini proxy | Multi-key polling, dashboards. **License red flag**: CC BY-NC 4.0 (no commercial use). |
| OmniRoute (diegosouzapw) | Multi-provider router | Useful **prior art for 429 classification** — and a cautionary tale: issue #9504 shows real Gemini free-tier 429s misclassified (day vs minute) when classification trusts `quotaId` text alone (§7.4). |
| gemini-cli (google-gemini) | Official CLI | Has its own `classifyGoogleError` / retry-with-backoff — prior art for error taxonomy, but not a proxy and per-user, not a quota ledger. |
| gemini-api-rotator, open-free-router, free-llm-proxy-router, onegw, red-router | Libs/proxies | All multi-provider failover or multi-key rotation. Cooldowns reactive. |
| 4pixeltechbr/awesome-ai-free-tiers (8★, MIT) | Directory, not a router | CI-audited free-tier limit tables + fallback architecture docs — good reference material. |

**Verdict: the "nothing for single key" claim holds.** No project does preemptive per-model quota scheduling (RPM sliding windows + RPD counters + TPM estimation + 429 forensics + pacing) for one key/project. Everyone else multiplies entitlements; this project *uses one entitlement efficiently*.

---

## 4. Official mechanics the router must respect

Sources: `ai.google.dev/gemini-api/docs/rate-limits` (checked live 2026-10-12) + real captured 429 payloads.

- **Quotas are per Cloud PROJECT, not per API key.** Key rotation inside one project buys nothing — the core insight the design exploits, and why multi-key tools mislead here.
- **RPD resets at midnight Pacific Time** (America/Los_Angeles — handle PDT/PST via `Intl`, never a hard-coded UTC-8).
- Three dimensions: **RPM, TPM (input tokens), RPD** — exceeding any one triggers a 429. Google also evaluates **spend-based** limits on a rolling 10-minute window for paid tiers (Free tier: N/A) — noted so tier transitions don't confuse the ledger.
- Google adjusts free-tier limits without notice (e.g. the Dec 2025 reductions: 2.0 Flash free RPD 500 → 100). **The table below is defaults, not truth** — the ledger self-corrects from 429 forensics (§7.5).
- 429 body shape (verified against real payloads, Aug 2026 captures):
  - HTTP 429, `status: "RESOURCE_EXHAUSTED"`.
  - `details[]` containing `google.rpc.QuotaFailure` with `violations[]`: `quotaMetric` (e.g. `generativelanguage.googleapis.com/generate_content_free_tier_requests` or `..._generate_content_free_tier_input_token_count`), `quotaId` (e.g. `GenerateRequestsPerDayPerProjectPerModel-FreeTier`, `GenerateRequestsPerMinutePerProjectPerModel-FreeTier`, `GenerateContentInputTokensPerModelPerMinute-FreeTier`), `quotaDimensions` `{location, model}`, `quotaValue`.
  - `google.rpc.RetryInfo` with `retryDelay` (e.g. `"38s"`, `"36.429760048s"`).
  - `message` text often embeds the authoritative numbers: `Quota exceeded for metric: …, limit: 20, model: gemini-3.6-flash\nPlease retry in 36.429760048s.` — **parse `limit:` and `model:`; this is the self-learning signal.**
- **Real per-model free-tier table — Owais's AI Studio project, captured 2026-10-12** (per project per model; `0` = no free tier on this project). Default fleet config:
  - *Chat/text, usable:* Gemini 3.1 Flash Lite **15 RPM / 250K TPM / 500 RPD**; Gemini 3.5 Flash Lite **15 / 250K / 500**; Gemini 2.5 Flash Lite **10 / 250K / 20**; Gemini 2.5 Flash, 3 Flash, 3.5 Flash, 3.6 Flash, 3.7 Flash, 3.8 Flash **5 / 250K / 20** each; Antigravity (Agents) **60 / 100K / 100**
  - *Chat/text, no free tier (0/0/0):* Gemini 2.5 Pro, 3.1 Pro, 2 Flash, 2 Flash Lite, Deep Research Pro Preview, Computer Use Preview
  - *Embeddings:* Gemini Embedding 1 & 2 **100 RPM / 30K TPM / 1K RPD** each
  - *Open weights:* Gemma 4 26B & 31B **30 RPM / 16K TPM / 14.4K RPD** each
  - *TTS/Transcribe:* 2.5/3.1/3.8 Flash TTS variants **3 / 10K / 10**; 3.5 Transcribe **3 / 10K / 25**
  - *Live API (unlimited RPM/RPD, TPM-capped):* 2.5 Flash Native Audio Dialog (1M TPM), 3 Flash Live (65K), 3.8 Live + Extended Thinking (65K), 3.5 Live Translate + Transcribe Live (20K)
  - *No free tier:* all Nano Banana image models, Veo, Lyria, Omni, Imagen; Map grounding 0 across the board
- Keep the table current in the README with a **last-verified date per row** — it's a link magnet; people hunt for this data.

---

## 5. Goals / non-goals

**Goals**
- Maximize utilization of one project's free-tier quotas across the Gemini model fleet.
- Drop-in OpenAI-compatible (`base_url` swap) so any client works.
- Preemptive: a well-behaved client should essentially never see a 429 the ledger could have prevented.
- Self-correcting: learn real limits from 429 payloads instead of hardcoding a table that rots.
- Observable: per-model remaining budget, reset countdowns, parsed 429 signals, learned-vs-configured limits.
- Honest posture on ToS (see §12).

**Non-goals**
- Multi-project key pooling — deliberate exclusion. That's the gray zone ("bypassing rate limits" guides); this project's position is *use your entitlement efficiently*, not *multiply it*.
- Billing, resale, per-user quota accounting.
- Multi-provider support — Gemini-only for v1. Modalities are opt-in via config: chat completions (v0.1) → embeddings (v0.2; 100 RPM / 1K RPD free is genuinely generous) → transcribe/translate/live (later). The ledger is keyed per (model, dimension), so new modalities plug in without redesign.

---

## 6. Stack (TypeScript)

**TypeScript — Hono on Bun, with Node compatibility. SQLite (WAL) for the ledger. Docker image. MIT license. Published as an npm package with a `bin` entry so `npx gemini-free-router` boots the proxy.**

Why TypeScript over Python: npm distribution was the deciding factor — a one-command `npx` install is the smoothest distribution story, and TypeScript is Owais's primary stack. The proxy speaks HTTP (OpenAI-compatible), so ContentFTE's Python pipeline consumes it via `base_url` regardless of implementation language.

- Runtime: **Bun-first** (cold-start speed matters for an npx CLI; built-in SQLite), Node compat via Hono.
- Proxy core: streaming passthrough — Hono `stream(c, …)` + `stream.pipe(upstreamReadable)` (verified in Hono docs; never buffer full responses). `StreamingApi.onAbort` for client-disconnect → abort upstream fetch (§7.6).
- Ledger: hot in-memory counters + **write-behind SQLite (WAL)**; atomic reservation per model so concurrent requests can't double-spend. The proxy path never blocks on disk I/O.
- Config: YAML fleet file + env overrides; `modalities: [chat]` to start.
- Packaging: npm `bin` + Docker (GHCR + Docker Hub) + GitHub releases via Actions (provenance-enabled).

Considered and set aside:
- **Python (FastAPI + httpx, PyPI)** — ecosystem precedent (LiteLLM) and the ContentFTE ledger ports directly; loses on distribution (`pipx`/`uvx` clunkier than `npx`; weaker PyPI discovery for this audience).
- **Go** — best raw throughput, heaviest solo build; unnecessary at free-tier request volumes.

---

## 7. Architecture

### 7.1 Edge proxy
`POST /v1/chat/completions`, `GET /v1/models`, SSE streaming passthrough. Translates to Gemini (OpenAI-compat endpoint or native `generateContent`). `GET /v1/models` lists the configured fleet with aliases. Support `stream_options.include_usage` (emit a final chunk with `usage` corrected from Gemini's response metadata).

### 7.2 Quota ledger
Per model: RPM sliding 60-second window; RPD counter (resets 00:00 America/Los_Angeles); TPM estimator — **input tokens only**: estimate prompt tokens pre-call (chars/4 heuristic is fine at free-tier sizes), correct with `usage.prompt_tokens` post-call; track output tokens separately for observability (they don't count against free-tier TPM). SQLite-backed, atomic reservations so concurrent workers can't double-spend. Also cap **in-flight requests per model** (≤ RPM/4 by default) so slow generations don't pile up into an RPM burst.

### 7.3 Scheduler / pacer
Leaky bucket per model. If a request would breach RPM, queue it until the window opens (bounded wait, default 30s, then drop with a proper 429 + `Retry-After`) instead of firing into a 429. Spread RPD across 24h with a configurable burn-rate curve (`even` | `front-loaded` | custom) instead of burst-then-recover. Jitter all timers to avoid synchronized retry storms.

### 7.4 Fallback engine
Chains re-ranked continuously by *remaining daily budget* + recent quality (rolling success/latency). A model exhausted for the day drops out for the day (not a 10-minute cooldown). 5xx → one same-model retry, then next model.

### 7.5 429 forensics (hardened)
On 429, extract the full signal tuple — **never classify on `quotaId` text alone** (real bug class: OmniRoute #9504, day-vs-minute misclassification):

1. Parse `quotaId`, `quotaMetric`, `quotaDimensions.{model,location}`, `RetryInfo.retryDelay`, and the `limit: N` / `model: X` embedded in `message`.
2. Classification matrix:
   - `quotaId` contains `PerDay` **or** `quotaMetric` ends `_requests` with `retryDelay` ≥ ~1h **or** message says "retry in" hours → **daily exhaustion** → mark model done-for-day (until PT midnight) and switch.
   - `quotaId` contains `PerMinute` / `InputTokens…PerMinute` **or** `retryDelay` < ~10min → **minute throttle** → honor `retryDelay` exactly (schedule re-entry at now + delay, never spin on `retryDelay: 0s` — treat 0 as 5s floor).
   - Conflicting signals → trust `quotaMetric` over `quotaId`; if still ambiguous → capped exponential backoff (1s→60s, jittered).
3. **Self-learning:** when `limit: N` is present and `N` differs from configured `rpm`/`rpd` for that model+dimension, write the learned value to the ledger (`learned_limits` table), flag drift in logs and `/admin`, and optionally persist an updated fleet snapshot for the user to adopt.
4. Log the parsed signal (structured JSON) for the dashboard and the golden fixture corpus.

### 7.6 Upstream lifecycle
Keep-alive connection pool to Google. On client disconnect mid-stream (`onAbort`), **abort the upstream fetch immediately** — stopped generations stop burning TPM. Never buffer: pipe `ReadableStream` straight through.

### 7.7 Budget allocator (v0.3)
QoS tiers: reserve scarce flash-class RPD for "hard" requests (caller-flagged via header or classified), route bulk/classifier traffic to lite/gemma. Nobody in the ecosystem does this.

### 7.8 Admin + observability
`/admin` dashboard (per-model remaining RPD/RPM/TPM, next PT-reset countdown, learned-vs-configured limits, last parsed 429), Prometheus `/metrics`, structured logs, **dry-run mode** that simulates a day of traffic against the ledger without spending quota.

### 7.9 Security posture
- The process holds the Gemini API key: **bind to `127.0.0.1` by default**; expose externally only with an explicit flag.
- Optional `GFR_TOKEN` bearer auth on all routes; `/admin` always requires it when bound non-localhost.
- Never log the API key, Authorization headers, or full prompt bodies (log lengths/hashes only).

---

## 8. Request flow

1. Request arrives with optional routing hints (quality tier header, max queue wait).
2. Scheduler picks the best model with headroom on all three dimensions (respecting QoS tier if flagged).
3. Reserve quota atomically; proxy the call with streaming passthrough; `onAbort` wired.
4. Success → commit usage with actual input-token counts. 429 → forensic handling (§7.5) → re-route or queue. 5xx → one same-model retry, then next model.
5. If truly exhausted everywhere, return 429 to the caller with `Retry-After` set to the next window/PT-midnight — in **OpenAI error shape** (`{"error":{"code":429,"message":…,"type":"rate_limit_error"}}`) so OpenAI SDKs handle it natively. Never a naked failure.

---

## 9. Config sketch (YAML)

```yaml
project: single            # one GCP project by design
listen: 127.0.0.1:8787    # localhost by default
fleet:
  - model: gemini-3.1-flash-lite
    rpm: 15                # community defaults, user-overridable
    rpd: 500
    tpm: 250000
    tier: bulk             # bulk | standard | scarce
  - model: gemini-3.5-flash
    rpm: 5
    rpd: 20
    tpm: 250000
    tier: scarce
pacing:
  max_queue_wait_s: 30
  burn_curve: even         # even | front-loaded | custom
  max_in_flight_per_model: auto   # default rpm/4
fallback:
  strategy: remaining-budget   # re-rank by leftover RPD, then quality
learning:
  auto_apply: false        # learn from 429 `limit:`; apply only on user approval
modalities: [chat]         # embeddings in v0.2
```

---

## 10. What to port from ContentFTE — and what to fix

**Port:** per-model fleet list with independent buckets; reserve-before-run (pre-increment) semantics; performance-based re-ranking; the Google-Sheets-persistence lesson (survive restarts) — but with SQLite instead of Sheets.

**Fix:** reset at 00:00 **America/Los_Angeles**, not local midnight; add the **TPM (input-token)** dimension; replace fixed 10/5-minute cooldowns with **quotaId+quotaMetric forensics**; replace the flat safety margin with **pacing**; add **self-learning limits**; decouple from the Agents SDK into a standalone proxy; handle **client disconnect** upstream.

---

## 11. ToS / safety posture (deliberate product decisions)

- README + admin banner: **free-tier inputs/outputs may be used by Google to train models** — don't send sensitive data. (Several existing projects already carry this warning.)
- Single-project by design; document *why* multi-project pooling is the gray zone this project avoids. Defensible positioning: efficiency, not circumvention.
- Conservative defaults; never spin on `retryDelay: 0s`; back off and surface.
- npm/GitHub README explicitly states the tool does **not** multiply quotas and does not rotate keys.

---

## 12. Publishing: GitHub repo + npm (both, different jobs)

- **GitHub repo (canonical home)** — source of truth, stars, issues, README as landing page, SEO surface, awesome-list eligibility. `MrOwaisAbdullah/gemini-free-router`.
- **npm package (distribution)** — `gemini-free-router` with a `bin` entry so `npx gemini-free-router` boots the proxy. npm keywords are SEO surface #2. Publish from the repo via GitHub Actions on release tags (provenance-enabled). Also push the Docker image to GHCR + Docker Hub from the same workflow.

---

## 13. Naming (checked against npm registry 2026-10-12, re-verified ~20:35 PKT)

- `gemini-free-router` — AVAILABLE ✅ (recommended)
- `freequota`, `quota-ledger`, `lastdrop`, `tierzero`, `gemini-ledger` — AVAILABLE
- `free-tier-router` — TAKEN
- GitHub `MrOwaisAbdullah/gemini-free-router` — FREE

**Recommendation: `gemini-free-router`.** Exact-match for what people search ("gemini free tier router"), self-describing in awesome-lists and search results. `freequota` is the brandable fallback. The ledger is the differentiator; the name should say so.

---

## 14. OSS SEO playbook

- Exact phrase "Gemini free-tier router" in repo name, GitHub description, README H1, npm description.
- GitHub topics: `gemini`, `gemini-api`, `free-tier`, `llm-router`, `openai-compatible`, `rate-limiting`, `quota-management`, `llm-proxy`, `selfhosted`. Mirror as npm keywords.
- README as landing page: the real quota table (§4 — a link magnet), vs-table vs LiteLLM/one-api/gemini-delegator, `npx` quickstart, benchmark numbers, **last-verified dates** on the quota table.
- Awesome-list PRs: awesome-ai-free-tiers, awesome-gemini, awesome-llm, awesome-ai-gateway.
- Launch distribution: Dev.to + Hashnode (existing channels), Show HN, r/selfhosted.
- Docs site with `llms.txt` (dogfood the agent-readiness tactic from the SEO pack).
- Keep the quota table current — a maintained quota reference earns recurring backlinks.

---

## 15. Performance requirements

The router must be effectively invisible next to model latency:
- **p99 added proxy overhead < 5ms** (excluding upstream model time). LiteLLM publicly claims ~3–4ms — match or beat it.
- Streaming passthrough — pipe the response stream, never buffer it.
- Keep-alive connection pool to Google; hot in-memory ledger; **write-behind SQLite (WAL)** — the proxy path never blocks on disk I/O.
- Bun runtime for fast `npx` cold start.
- Benchmark in CI (k6 or autocannon): sustained RPS, p50/p99 overhead, memory footprint. Publish the numbers in the README — they're marketing.

---

## 16. Testing strategy

- **Golden 429 corpus** — real captured payloads (day, minute, TPM-per-minute, ambiguous, `retryDelay: 0s`, missing `details`) as fixtures; every forensics classifier change runs against them. This is the regression net for the OmniRoute-style misclassification bug.
- **Ledger property tests** — under randomized concurrent load, committed usage never exceeds configured limits in dry-run simulation; reservations are atomic (no double-spend).
- **PT-reset tests** — PDT and PST boundaries, DST transitions, restart-within-window persistence.
- **Streaming tests** — SSE passthrough correctness, `include_usage` final chunk, client-disconnect aborts upstream (assert upstream fetch signal fired).
- **Compat smoke test** — official `openai` Python/JS SDKs pointed at the proxy complete a chat round-trip and a streaming round-trip.

---

## 17. Milestones

- **v0.1** — proxy + ledger (RPM/RPD) + budget-ordered fallback chains + SQLite + Docker. Dogfood in ContentFTE via `base_url` swap.
- **v0.2** — TPM estimation (input tokens), pacer/queue, 429 forensics + self-learning, `/admin` dashboard, `/metrics`, golden fixture corpus, embeddings modality.
- **v0.3** — budget allocator / QoS tiers, burn-rate curves, dry-run simulator.
- **v1.0** — docs site, benchmark report ("requests/day extracted from one free key"), community model-limit registry.

---

## 18. Open questions for Owais

1. ~~Proxy vs library~~ — decided: **proxy**, shipped as an npm binary (`npx gemini-free-router`).
2. ~~Language~~ — decided: **TypeScript** (npm distribution + primary stack).
3. Runtime: **Bun-first** with Node compat, or Node-only for maximum compatibility?
4. v0.1 chat-only confirmed; embeddings in v0.2 — good?
5. Name: `gemini-free-router` (recommended, available) vs `freequota` (available, brandable)?
6. `learning.auto_apply` default: `false` (proposed — user adopts learned limits) or `true` (fully self-correcting)?

---

## 19. Appendix — research notes

- Official rate limits: `ai.google.dev/gemini-api/docs/rate-limits` (checked 2026-10-12) — per-project, PT reset, three dimensions, spend-based rolling window for paid tiers.
- Real 429 payloads with `quotaId` / `quotaMetric` / `retryDelay` / embedded `limit:` numbers: OmniRoute issue #9504 (captures from 2026-08-01).
- Hono streaming API (`stream`, `streamText`, `pipe`, `onAbort`, `streamSSE`): Hono v4 docs via Context7.
- Dec 2025 free-tier quota reductions (context for why the table must self-correct): aifreeapi.com 2026 rate-limit guide.
- Prior competitor report: `~/workspace/research_notes/gemini-free-tier-router-competitors-20261012-1427/report.md` · per-source notes in `notes/sources.md`.
