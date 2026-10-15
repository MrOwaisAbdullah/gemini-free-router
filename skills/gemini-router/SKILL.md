---
name: gemini-router
description: |
  Integrate the `gemini-free-router` npm package — a local, OpenAI-compatible
  scheduling proxy in front of the Gemini free tier: queues requests instead of
  burning 429s, learns real per-model RPM/RPD/TPM limits, and fails over across
  a merged fleet of free models off ONE Gemini API key. Covers install and
  `router.yaml`, pointing OpenAI SDK clients at `http://127.0.0.1:8787/v1`,
  the version floors that matter (>=0.3.0 vision image parts, >=0.4.0 function
  calling, >=0.4.1 Gemini tool-schema dialect), persisting the quota ledger
  across CI runs, and debugging the silent failure modes (empty 200 completions
  from dropped tools, models ignoring images, 429 `free_tier_exhausted`).
  Use when users ask to add gemini-free-router, route Gemini through a local
  proxy, share free-tier Gemini quota across a fleet of models, persist router
  quota in GitHub Actions, or debug router-served requests that return empty
  content / ignore images / drop tool calls.
---

# gemini-free-router integration

`gemini-free-router` is a per-model **RPM/RPD/TPM scheduling proxy** between
your app and the Gemini API. Google free-tier quotas are **per project**, not
per key — key rotation buys nothing — so the router is the real lever: it
schedules requests preemptively, queues up to `max_queue_wait_s` instead of
bursting into 429s, **learns true limits from real 429 payloads**, and fails
over across a merged fleet of free models. One `GEMINI_API_KEY` is the only
credential; your app talks OpenAI-compatible HTTP
(`/v1/chat/completions`) to `http://127.0.0.1:8787`.

Ops endpoints on the same port: `GET /healthz` (liveness) and `GET /admin`
(JSON: `plan`, `fleet_mode`, `fleet[]`, quota ledger state).

## Version floors (check FIRST — older versions fail SILENTLY)

| You need | Minimum | Symptom if older |
| :--- | :--- | :--- |
| Plain text chat | 0.2.x works | — |
| **Vision** (images in messages) | **0.3.0** | `image_url` parts are silently DROPPED — the model answers from text alone, no error |
| **Function calling / tools** | **0.4.0** | `tools`/`tool_choice` silently dropped, `tool_calls` never mapped — HTTP 200 with EMPTY content |
| **Strict tool schemas** (Pydantic/zod) | **0.4.1** | 400: Gemini's `Schema` is a strict OpenAPI subset (rejects `additionalProperties: false`, `$defs`/`$ref`, `anyOf`-null Optionals) |

`npm ls gemini-free-router` must show the floor for your feature set — 0.2.x
"works" until it silently eats your images and tools. Current published
version: **`0.4.1`** (the contentfte SEO Blog Agent runs `^0.4.1`).

> Full `router.yaml` field reference: `references/config.md`.
> CI wiring, fallback policy, quota persistence: `references/ops-and-ci.md`.

## Integration in 6 steps

### 1. Install
```bash
npm i gemini-free-router     # pin >=0.4.1 if you use tools or vision
```

### 2. Configure `router.yaml`
```yaml
project: my-app
listen: { host: 127.0.0.1, port: 8787 }
# plan: pro              # free is the default; pro scales built-in defaults ×4

fleet_mode: merge        # overlay mode — the DEFAULT is replace (list = whole fleet)
fleet:
  # Declare every model YOUR app requests that is not built-in. Unknown
  # requested models make the router auto-pick a different model for that
  # request (resolveModel falls back to any candidate) — a quiet footgun.
  - { model: gemini-flash-latest, rpm: 5, rpd: 20, tpm: 250000, tier: scarce }

disabled: []             # keep known-dead models out of failover slots

pacing: { max_queue_wait_s: 30, burn_curve: even }
learning: { auto_apply: true }    # == GFR_LEARN=1; converge from real 429s
modalities: [chat]
ledger_path: ./data/ledger.sqlite # all quota state; flushed on SIGTERM
```

Two lessons that cost real debugging:
- **Shallow health probes lie.** A model can 200 a `"Say OK"` probe and then
  return EMPTY content — or verbose planning text that ignores the prompt — on
  real instructions. A 200 never triggers failover, so such a model poisons
  every auto-pick. Probe with
  `Reply with exactly: ROUTER_OK` and `disabled:` anything that doesn't return
  the exact string.
- Editing rpm/rpd/tpm for a model **clears its learned limits** — only touch
  them when you have real evidence.

### 3. Run and verify the router itself
```bash
GEMINI_API_KEY=... npx gemini-free-router --config router.yaml
curl -sf http://127.0.0.1:8787/healthz
curl -s  http://127.0.0.1:8787/admin     # plan, fleet_mode, fleet[]
```

Env: `GEMINI_API_KEY` (required) · `GFR_PORT` · `GFR_TOKEN` (start the router
with it to require clients to send it as their bearer token) · `GFR_PLAN=free|pro`
(pro scales built-in default limits ×4) · `GFR_LEARN=1` · `GFR_LOG=info`.

### 4. Point clients at it (OpenAI-compatible)
```python
from openai import AsyncOpenAI
client = AsyncOpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key=os.environ.get("GFR_TOKEN", "unused"),
)
resp = await client.chat.completions.create(model="auto", messages=[...])
```
- `model: "auto"` → the router picks the healthiest fleet model; or request a
  specific fleet model by name (built-in aliases: `fast` = gemini-3.1-flash-lite,
  `embed` = gemini-embedding-001; any fleet entry can define its own).
- **Vision**: standard `image_url` data-URI parts, same endpoint (needs ≥0.3.0).
- **Tools**: standard OpenAI function-calling (needs ≥0.4.0; Gemini 3
  `thoughtSignature`-signed calls are memoized and replayed by the router).
- Point **every** Gemini caller at the router (chat, judges, vision QA) — one
  caller left on the direct Google path silently bypasses the quota ledger.
- Keep an env switch so unsetting one variable returns to your legacy direct
  path (the router must never be a hard dependency for the app to start).

### 5. Verify for real (integration gate)
Do NOT trust a green health check. Run a round trip through YOUR client path:
1. client constructed from your own config builder targets
   `http://127.0.0.1:8787/v1` (not Google);
2. one real completion `model="auto"` → expect `ROUTER_OK`;
3. `/admin` reports the expected `plan` and the merged fleet — including any
   models you appended (present) and disabled (absent).

Tip: exercise the gate once with `GFR_DRY_RUN=1` first — every route answers
synthetically (no upstream call, no quota spent; responses carry
`x-gfr-dry-run: 1`).

The [contentfte SEO Blog Agent](https://github.com/MrOwaisAbdullah/ContentFTE)'s
`scripts/test_router_integration.py` is the working pattern; keep an equivalent
script next to your router config.

### 6. Persist quota across CI runs (GitHub Actions)
Ephemeral runners reset quota unless the ledger is cached:
- restore `data/` before starting the router (restore-keys `gfr-ledger-`);
- start the router backgrounded, wait on `/healthz` (loop, don't sleep-once);
- after the app step: `kill -TERM` the router (it flushes the ledger on
  SIGTERM), then save `data/` under a **unique run-scoped cache key** — with
  `if: always()` so failed runs still persist the spend;
- serialize runs (concurrency group) so parallel cache saves don't clobber.

> Full workflow snippet (copy-paste-ready): `references/ops-and-ci.md`.

## Troubleshooting

| Symptom | Likely cause | Fix |
| :--- | :--- | :--- |
| 200 with EMPTY content, 0 tokens ("agent returns nothing") | tools dropped by router <0.4.0 | upgrade to ≥0.4.0 |
| 400 `INVALID_ARGUMENT` on tool schemas | strict JSON-Schema dialect vs router <0.4.1 | upgrade to ≥0.4.1 |
| Model answers from the prompt alone, never mentions the image | image parts dropped by router <0.3.0 | upgrade to ≥0.3.0 |
| Model replies with an essay/planning text instead of the instruction | broken model auto-picked | probe with the exact-string check, then `disabled:` |
| Immediate 429 `code=free_tier_exhausted` (+ `retry-after`) | whole fleet out of quota | app-side fallback chain — see `references/ops-and-ci.md` |
| Client connection refused / hangs | router not running or started after the client | `/healthz`, start order |
| Wrong model actually served the request | requested model not in fleet (auto-pick fallback) | append it to `fleet:` (merge mode) |
