# gemini-free-router

[![CI](https://github.com/MrOwaisAbdullah/gemini-free-router/actions/workflows/ci.yml/badge.svg)](https://github.com/MrOwaisAbdullah/gemini-free-router/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.18-brightgreen.svg)](https://nodejs.org)

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

> **AI agents:** [`skills/gemini-router/SKILL.md`](./skills/gemini-router/SKILL.md)
> is an integration skill for this package — install, `router.yaml`, client
> wiring, the version floors that fail silently (≥0.3.0 vision, ≥0.4.0 function
> calling, ≥0.4.1 strict schemas), and persisting the quota ledger in CI.

### Docker

```bash
docker build -t gemini-free-router .
docker run -p 8787:8787 -e GEMINI_API_KEY=your-key gemini-free-router
```

The image runs the router on `0.0.0.0:8787` (that binding is baked in via `GFR_HOST`). CI builds the image and probes `/healthz` on every push, so a green build means the container boots.

## What it does

| Dimension | How it's scheduled |
|---|---|
| **RPM** | Sliding 60s window per model; requests queue (bounded wait) instead of firing into a 429 |
| **RPD** | Per-model daily counter that resets at **midnight Pacific** (not local midnight) |
| **TPM** | Input-token sliding window — estimated pre-call, corrected with actual `promptTokenCount` post-call |
| **429s** | Parsed via forensics (`quotaId` + `quotaMetric` + `RetryInfo` + `limit:` in the message; on conflict `quotaMetric` wins over `quotaId`). Daily exhaustion → model done-for-day; minute throttle → honor `retryDelay` exactly (0s → 5s floor); unclassifiable payloads → capped exponential backoff (1s–60s, jittered); learned limits self-correct the fleet table |
| **Fallback** | Models re-ranked continuously by remaining daily budget **× rolling quality** (EMA of success rate and latency); exhausted models drop out for the day |
| **Vision** | OpenAI `image_url` parts translate to Gemini `inline_data` (base64 data URIs) or `file_data` (http/https/gs URLs, mime inferred from extension). Measured media cost is ~1100 tokens/image regardless of size, so the pre-call estimate is flat per image and corrected with the actual `promptTokenCount` after the call |
| **Function calling** | OpenAI `tools`/`tool_choice` translate to Gemini `functionDeclarations`/`toolConfig`; `tool_calls` ⇄ `functionCall`/`functionResponse` in both directions (SSE deltas included), so agent SDKs keep their tool loops intact. Gemini 3's `thoughtSignature` is memoized per tool_call id and re-attached when the client replays the call (Gemini 400s a signed call replayed without it) |

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

### Maintaining the fleet

Models get released and deprecated, and Google revises free-tier limits — you maintain both in config, never in code:

```yaml
# router.yaml
fleet_mode: merge            # overlay onto the built-in defaults
disabled:                    # drop deprecated models by id
  - gemini-2.5-flash-lite
fleet:
  - { model: gemini-2.5-flash, rpm: 8, rpd: 50 }                          # retune: override just what changed
  - { model: gemini-4-flash, rpm: 5, rpd: 20, tpm: 250000, tier: scarce } # new model: unknown ids are appended
```

```bash
gemini-free-router --config router.yaml
```

- **`replace` (default):** whatever you list under `fleet` *is* the whole fleet — configs that already do this keep behaving identically.
- **`merge`:** built-in defaults stay; listed ids override only the fields they give, unknown ids are appended, `disabled` ids are removed.
- The resolved fleet is **validated at boot** — a bad limit, unknown tier, duplicate id, or incomplete new model fails fast with a message naming the entry (a misconfigured fleet must not run).
- **Learned limits never outlive a config edit:** values self-learned from 429 payloads normally override the configured numbers, but changing a model's `rpm`/`rpd`/`tpm` in config clears its stale learned values on restart — your new numbers take effect immediately.

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
npm start        # runs TypeScript directly (Node >= 22.18 type stripping)
npm run build    # emit dist/ — required only to run bin/gfr.mjs from a checkout
```

The published package ships compiled JavaScript in `dist/` (Node refuses to strip
TypeScript from files under `node_modules`); `npm pack`/`npm publish` build it
automatically via the `prepack` script.

**Package**: `npm i gemini-free-router` — version `0.4.1`, published to npmjs.com.

429 classification is regression-tested against a golden fixture corpus in `test/fixtures/` (day, minute, token-minute, `retryDelay: 0s`, missing `details`, ambiguous) — when Google changes an error shape, drop the payload in there and add its expectations to `test/fixtures/429-corpus.json`.

## License

MIT — see [LICENSE](./LICENSE).

 Spec: see [docs/SPEC.md](./docs/SPEC.md).
