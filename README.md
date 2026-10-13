# gemini-free-router

**Squeeze 100% out of Gemini's free tier — per-model RPM/RPD/TPM scheduling for a single API key.**

An OpenAI-compatible proxy that runs on **one Gemini API key / one Cloud project** and schedules its free-tier quotas preemptively — instead of bursting into a 429 and rotating keys. Google quotas are per **project**, not per key, so key rotation buys nothing; efficient scheduling is the only real lever.

> ⚠️ Free-tier inputs/outputs may be used by Google to train models. Don't send sensitive data.
> This tool **does not multiply quotas** and does not rotate keys — it uses your single entitlement efficiently.

## Quickstart

Requires Node >= 22.18 (or Bun).

```bash
export GEMINI_API_KEY=your-key
npx gemini-free-router
```

Point any OpenAI client at `http://127.0.0.1:8787/v1`:

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="router")
print(client.chat.completions.create(
    model="auto",  # or a fleet model / alias like "fast"
    messages=[{"role": "user", "content": "hi"}],
).choices[0].message.content)
```

## What it does

| Dimension | How it's scheduled |
|---|---|
| **RPM** | Sliding 60s window per model; requests queue (bounded wait) instead of firing into a 429 |
| **RPD** | Per-model daily counter that resets at **midnight Pacific** (not local midnight) |
| **TPM** | Input-token sliding window — estimated pre-call, corrected with actual `promptTokenCount` post-call |
| **429s** | Parsed via forensics (`quotaId` + `quotaMetric` + `RetryInfo` + `limit:` in the message; on conflict `quotaMetric` wins over `quotaId`). Daily exhaustion → model done-for-day; minute throttle → honor `retryDelay` exactly (0s → 5s floor); unclassifiable payloads → capped exponential backoff (1s–60s, jittered); learned limits self-correct the fleet table |
| **Fallback** | Models re-ranked continuously by remaining daily budget **× rolling quality** (EMA of success rate and latency); exhausted models drop out for the day |

## Endpoints

- `POST /v1/chat/completions` — OpenAI-compatible, streaming (SSE) and non-streaming
- `GET /v1/models` — configured fleet (+ aliases)
- `GET /admin` — per-model remaining budget, PT-reset countdown, learned limits, and rolling quality (`ok% · latency · n`) (JSON, or HTML when the client sends `Accept: text/html` — browsers auto-refresh every 30s)
- `GET /metrics` — Prometheus
- `GET /healthz`
- `POST /admin/simulate` — what-if quota simulation over a throwaway in-memory ledger: `{hours, rps, avg_tokens}` in, `{offered, served, rejected, utilization_percent, truncated}` out. Runs on a virtual clock (a simulated day takes milliseconds, not 24h) and is capped at 100k requests; it never touches your real ledger or Google quota.
- `POST /v1/embeddings` — OpenAI ⇄ Gemini `embedContent` translation

Optional headers: `x-gfr-tier: bulk|standard|scarce` (QoS preference), `Authorization: Bearer $GFR_TOKEN` (if `GFR_TOKEN` set; wrong/missing token → `401`).

### Dry-run mode

`GFR_DRY_RUN=1` makes the proxy answer **synthetically**: admission control still runs against the ledger (so exhausted models still return `429`), but no request is sent to Gemini and no quota is reserved or committed. Every dry-run response carries `x-gfr-dry-run: 1` so you can tell it apart.

### Logging

Structured **JSON lines on stderr** — one object per line with `ts`, `level`, `event` and event fields — so stdout keeps only the human startup banner. Level is `GFR_LOG=debug|info|warn|error|off` (default `info` from the CLI, `warn` when the app is embedded).

```bash
GFR_LOG=debug npx gemini-free-router 2>>router.jsonl
```

Events: `listening`, `served` (`model`, `latency_ms`), `quota_signal` (the parsed 429: `kind`, `quota_id`, `quota_metric`, `learned_limit`, `retry_delay_ms`), `rejected`, `upstream_error`.

Router-owned timers (queue polls, ledger flush tick, ambiguous-429 backoff) are **jittered ±20%** so concurrent clients and replicas don't retry in lockstep. Google's own `RetryInfo.retryDelay` is never jittered — it is honored exactly.

## Config

See `router.example.yaml`. Env overrides: `GFR_HOST`, `GFR_PORT`, `GFR_LEDGER`, `GFR_TOKEN`, `GFR_MAX_QUEUE_WAIT_S`, `GFR_LEARN=1` (auto-apply limits learned from 429 payloads), `GFR_BURN_CURVE=even|front-loaded`, `GFR_DRY_RUN=1` (synthetic responses, no upstream calls), `GFR_LOG=debug|info|warn|error|off` (structured JSON logs on stderr), `GFR_POOL_CONNECTIONS` / `GFR_POOL_KEEPALIVE_MS` / `GFR_POOL_CONNECT_MS` (upstream keep-alive pool).

Default burn curve: `even` — spreads RPD across the Pacific day so at most `ceil(elapsed/24h × rpd)` requests are allowed so far (prevents burst-then-recover). `front-loaded` has no pacing; full RPD available immediately.

Default fleet (free-tier, captured 2026-10-12 — verify yours in AI Studio; last-verified dates matter):

| Model | RPM | TPM | RPD | Tier |
|---|---|---|---|---|
| gemini-3.1-flash-lite | 15 | 250K | 500 | bulk |
| gemini-3.5-flash-lite | 15 | 250K | 500 | bulk |
| gemini-2.5-flash-lite | 10 | 250K | 20 | bulk |
| gemini-2.5/3/3.5/3.6/3.7/3.8-flash | 5 | 250K | 20 | standard/scarce |

## Safety posture

- Binds to `127.0.0.1` by default.
- Never spins on `retryDelay: 0s` (floored to 5s).
- Unclassifiable 429s back off exponentially (1s → 60s, jittered) instead of hammering.
- Single-project by design: efficiency, not circumvention.

## Development

```bash
npm i
npm run typecheck
npm run lint
npm test
npm start
```

429 classification is regression-tested against a golden fixture corpus in `test/fixtures/` (day, minute, token-minute, `retryDelay: 0s`, missing `details`, ambiguous) — when Google changes an error shape, drop the payload in there and add its expectations to `test/fixtures/429-corpus.json`.

Spec: see [SPEC.md](./SPEC.md). MIT.
