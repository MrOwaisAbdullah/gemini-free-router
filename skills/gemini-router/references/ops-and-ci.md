# Ops: fallback policy, CI wiring, quota persistence

## Fallback and failure policy

The router is a **local process**, so the app must stay up when it is not.
Classify its failures explicitly:

| Failure | Signal | App response |
| :--- | :--- | :--- |
| Fleet exhausted | 429 with `code=free_tier_exhausted` + `retry-after` | Walk your own provider fallback chain (e.g. another provider). Do **not** silently fall back to Google-native — that bypasses the ledger and hides the real condition. |
| Router down / unreachable | connection refused/reset/aborted, DNS failure, hung-read timeout | Treat as a **retryable transport error**, not a caller bug. Builtin `ConnectionError`, OpenAI SDK `APIConnectionError`/`APITimeoutError`, and message keywords should all route into the same failover path. |
| Router healthy | any 2xx | Normal path. |

Two rules that keep this honest:

1. **Env switch, not a hard dependency.** `GFR_BASE_URL` unset ⇒ legacy direct
   path. Deleting the router (or forgetting to start it) must degrade, not
   brick — and the switch makes rollout/rollback a one-variable change.
2. **Every Gemini caller goes through the router** — chat, judges, vision QA.
   One caller left on the direct path silently bypasses the quota ledger and
   burns the same per-project quota the router was scheduled around. In
   contentfte that is two variables: `GFR_BASE_URL` (chat) and
   `IMAGE_VLM_ENDPOINT` (vision, needs router >= 0.3.0).

## GitHub Actions wiring (verified pattern)

```yaml
concurrency:                       # serialize runs; concurrent runs would
  group: my-pipeline               # clobber each other's ledger cache save
  cancel-in-progress: false

steps:
  - uses: actions/setup-node@v4
    with:
      node-version: 22
      cache: npm
  - run: npm ci                    # installs the pinned gemini-free-router

  - name: Restore router quota ledger
    uses: actions/cache/restore@v4
    with:
      path: data/
      key: gfr-ledger-${{ github.run_id }}-${{ github.run_attempt }}
      restore-keys: |
        gfr-ledger-

  - name: Start gemini-free-router
    env:
      GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
      GFR_LOG: info
      GFR_LEARN: "1"
    run: |
      nohup ./node_modules/.bin/gemini-free-router --config router.yaml > router.log 2>&1 &
      echo $! > router.pid
      for i in $(seq 1 30); do
        if curl -sf http://127.0.0.1:8787/healthz > /dev/null; then
          echo "gemini-free-router up"
          exit 0
        fi
        sleep 1
      done
      echo "gemini-free-router failed to start:" >&2
      cat router.log >&2
      exit 1

  - name: Run app
    env:
      GFR_BASE_URL: http://127.0.0.1:8787/v1
      IMAGE_VLM_ENDPOINT: http://127.0.0.1:8787/v1/chat/completions   # vision callers
      GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
    run: <your run command>

  - name: Stop gemini-free-router (flush quota ledger)
    if: always()
    run: |
      if [ -f router.pid ]; then
        kill -TERM "$(cat router.pid)" || true
        sleep 2
      fi
      echo "--- router.log tail ---"
      tail -n 50 router.log || true

  - name: Save router quota ledger
    if: always() && hashFiles('data/**') != ''
    uses: actions/cache/save@v4
    with:
      path: data/
      key: gfr-ledger-${{ github.run_id }}-${{ github.run_attempt }}
```

Why each piece exists:

- **PID + SIGTERM**: `node_modules/.bin` shims `exec` node, so the recorded PID
  *is* the router process and SIGTERM reaches its ledger-flush handler. Sleeping
  2s afterwards lets the flush finish.
- **Health wait loop, not `sleep 5`**: start-up failures must fail the job with
  `router.log` dumped, not produce mystified downstream errors.
- **`if: always()` on stop + save**: quota spent during a failed run still
  counts — persist it either way.
- **Unique save key + `restore-keys` prefix**: the save can never collide with
  an already-restored key, and the restore always finds the most recent
  `gfr-ledger-*` entry.
- **Concurrency group**: two runs saving to a shared cache key race; serializing
  the workflow is what makes this safe.

### Why the ledger cache matters

Runners are ephemeral: without the cache every run starts at full free-tier
RPD and "forgets" both spend and learned limits. Restoring `data/` carries
sliding-window spend and learned limits across runs, so daily caps are enforced
across the whole day instead of per run.

## Integration gate (run after any router bump or config change)

Before the first real call, `GFR_DRY_RUN=1` answers synthetically — admission
control and all routes behave, but nothing is sent upstream and no quota is
spent (responses carry `x-gfr-dry-run: 1`).

1. Your client builder targets `http://127.0.0.1:8787/v1` (not Google).
2. One real completion with `model="auto"` → non-empty content; expect
   `ROUTER_OK` for the strong form of the check.
3. `GET /admin` → expected `plan`, and the merged `fleet[]`: appended models
   present, `disabled:` models absent.

The working example script is `scripts/test_router_integration.py` in the
contentfte SEO Blog Agent (same three checks, exits non-zero on failure). Keep
an equivalent next to your router config and re-run it whenever the
`gemini-free-router` version or `router.yaml` changes.

## Local development

```bash
npm run router                      # "gemini-free-router --config router.yaml"
# .env: GFR_BASE_URL=http://127.0.0.1:8787/v1 (+ IMAGE_VLM_ENDPOINT for vision)
python scripts/test_router_integration.py
```
