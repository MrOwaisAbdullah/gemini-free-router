# router.yaml field reference

Everything the contentfte integration actually exercises, verified against
router 0.4.1 — plus the env surface from the README. Minimum viable file is
`listen` + a `GEMINI_API_KEY` in the environment; the rest is what makes it
survive real traffic. The full annotated schema is `router.example.yaml`
(ships in the package); behavior is specified in `docs/SPEC.md`.

```yaml
project: my-app
listen: { host: 127.0.0.1, port: 8787 }
# plan: pro              # free is the default; pro scales built-in defaults ×4
fleet_mode: merge        # replace (default: list = whole fleet) | merge (overlay)
fleet:
  - { model: gemini-flash-latest, rpm: 5, rpd: 20, tpm: 250000, tier: scarce }
disabled:
  - some-dead-model
pacing: { max_queue_wait_s: 30, burn_curve: even }
learning: { auto_apply: true }
modalities: [chat]
ledger_path: ./data/ledger.sqlite
```

## Fields

| Field | Meaning |
| :--- | :--- |
| `project` | Label carried in logs/admin output. |
| `listen.host` / `listen.port` | Bind address. Default port is `8787`; clients then use `http://127.0.0.1:8787/v1`. |
| `plan` | `free` (default) or `pro` — `pro` scales the **built-in default** limits ×4 (Google's published Pro-vs-free ratio); the 429 learner then converges to your console's real numbers. Env `GFR_PLAN` overrides. |
| `fleet_mode` | `replace` (**default**): your `fleet` list IS the whole fleet. `merge`: built-in defaults stay; listed ids override only the fields given, unknown ids are appended, `disabled` ids are removed. The resolved fleet is **validated at boot** — a bad limit, unknown tier, duplicate id, or incomplete new model fails fast. Explicit numbers you write are never scaled by the plan. |
| `fleet[]` | `{ model, rpm, rpd, tpm, tier, alias?, modality? }` per entry. Declare **every model your app requests that is not built-in** — for an unknown requested model the router auto-picks a different candidate (`resolveModel` fallback), which is silent and easy to miss. `tier` labels quota value (`bulk`/`standard`/`scarce`); `alias` exposes a short name on `/v1/models` (built-ins: `fast`, `embed`). |
| `disabled[]` | Models kept out of service and failover. Dead-but-listed models burn failover slots and can surface as empty `content_filter` responses (observed live). |
| `pacing.max_queue_wait_s` | How long a request may wait in the scheduler queue before it is treated as un-servable (then your failover policy takes over). |
| `pacing.burn_curve: even` | Spread quota burn across the day — at most `ceil(elapsed/24h × rpd)` requests are allowed so far, rather than bursting at the front (`front-loaded` = no pacing). |
| `learning.auto_apply` | `true` == `GFR_LEARN=1`: auto-apply limits learned from real 429 payloads — converges on the account's true rpm/rpd/tpm instead of guessed defaults. **Editing rpm/rpd/tpm for a model clears its learned value.** |
| `modalities` | `[chat]` for this integration (the built-in fleet also carries embeddings models). |
| `ledger_path` | SQLite ledger holding all quota state (sliding windows + learned limits). Flushed on SIGTERM — that is what CI relies on (see `ops-and-ci.md`). Keep it out of git. |

## Environment variables

| Var | Effect |
| :--- | :--- |
| `GEMINI_API_KEY` | Required. The single key the whole fleet runs on. |
| `GFR_HOST` / `GFR_PORT` | Override the bind address. |
| `GFR_LEDGER` | Override the ledger path. |
| `GFR_TOKEN` | Start the router with it set and clients must send `Authorization: Bearer <GFR_TOKEN>` (wrong/missing → `401`). |
| `GFR_PLAN` | `free` (default) or `pro` — `pro` scales the **built-in default** limits ×4. |
| `GFR_LEARN=1` | Same as `learning.auto_apply: true`. |
| `GFR_MAX_QUEUE_WAIT_S` | Same as `pacing.max_queue_wait_s`. |
| `GFR_BURN_CURVE` | `even` (default) or `front-loaded`. |
| `GFR_DRY_RUN=1` | Synthetic responses: admission control still runs (exhausted models still 429) but nothing is sent upstream and no quota is spent; every response carries `x-gfr-dry-run: 1`. |
| `GFR_LOG` | `debug|info|warn|error|off` — structured JSON lines on stderr. |
| `GFR_POOL_CONNECTIONS` / `GFR_POOL_KEEPALIVE_MS` / `GFR_POOL_CONNECT_MS` | Upstream keep-alive pool tuning (undici Agent). |

## Model selection semantics

- `model: "auto"` → the router picks the healthiest fleet model per request.
- `model: "<name>"` → served by that model if it is in the (merged) fleet;
  otherwise auto-picked — see the `fleet[]` footgun above.
- `model: "<alias>"` → built-in aliases `fast` (gemini-3.1-flash-lite) and
  `embed` (gemini-embedding-001); any fleet entry can define its own.
- `x-gfr-tier: bulk|standard|scarce` header → QoS preference for ranking.
- 429 from the router carries `code=free_tier_exhausted` + `retry-after` when
  the whole fleet is out of quota for now.

## The shallow-probe trap (why `disabled:` exists)

A model can answer `"Say OK"` with HTTP 200 and still be unusable on real
instructions — e.g. a consumer's gemma-4-31b-it returned 200 with **empty
content** (`finishReason=STOP`) or verbose planning text that ignored the
prompt. A 200 never triggers router failover, so such a model poisons every
auto-pick. Probe with a real instruction and require the exact string back:

```bash
curl -s -H "x-goog-api-key: $GEMINI_API_KEY" -H "content-type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"Reply with exactly: ROUTER_OK"}]}]}' \
  https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent
```

Disable anything that doesn't return exactly `ROUTER_OK`. The contentfte
`router.yaml` keeps both gemma-4 models disabled with the probe evidence in a
comment.

## Observability

- `GET /healthz` — liveness only. **Not sufficient** as an integration check.
- `GET /v1/models` — configured fleet plus aliases.
- `GET /admin` — JSON with `plan`, `fleet_mode`, `fleet[]` (models actually
  being served after merge + disabled exclusions) and ledger state; renders an
  auto-refreshing HTML dashboard when the client sends `Accept: text/html`.
- `GET /metrics` — Prometheus metrics.
- `POST /admin/simulate` — what-if quota simulation on a throwaway in-memory
  ledger (virtual clock; capped at 100k requests; never touches your real
  ledger or Google quota).
