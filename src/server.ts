import { Hono } from "hono";
import type { Context } from "hono";
import { stream } from "hono/streaming";
import type { RouterConfig, OpenAIChatRequest, OpenAIEmbeddingRequest, FleetModel, GeminiResponse, QuotaSignal } from "./types.ts";
import { QuotaLedger } from "./ledger.ts";
import { openStore, MemoryStore } from "./storage.ts";
import { classify429 } from "./forensics.ts";
import { acquire, sleep } from "./scheduler.ts";
import { ambiguousBackoff } from "./time.ts";
import { silentLogger } from "./log.ts";
import type { Logger } from "./log.ts";
import {
  openaiToGemini,
  estimateInputTokens,
  geminiToOpenAI,
  geminiChunkToOpenAI,
  parseGeminiSseLine,
  sseFrame,
  openaiError,
  completionId,
  openaiToGeminiEmbedding,
  geminiToOpenAIEmbedding,
} from "./translate.ts";

export interface AppDeps {
  cfg: RouterConfig;
  apiKey: string;
  ledger?: QuotaLedger;
  /** injectable for tests */
  fetchImpl?: typeof fetch;
  /** structured JSON logger (SPEC §7.8); defaults to silent */
  logger?: Logger;
}

export interface AppMetrics {
  requests: number;
  upstream429: number;
  upstream5xx: number;
  queuedWaitMs: number;
  served: number;
  rejected: number;
}

export function createApp(deps: AppDeps): { app: Hono; ledger: QuotaLedger; metrics: AppMetrics } {
  const { cfg, apiKey } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const ledger = deps.ledger ?? new QuotaLedger(cfg.fleet, openStore(cfg.ledger_path), 5_000, cfg.pacing);
  const metrics: AppMetrics = {
    requests: 0,
    upstream429: 0,
    upstream5xx: 0,
    queuedWaitMs: 0,
    served: 0,
    rejected: 0,
  };
  // Per-app 429 learn log (isolated between app instances / tests).
  const learnLog: LearnLogEntry[] = [];
  const log = deps.logger ?? silentLogger;
  // Consecutive unclassifiable-429 count per model → capped exponential backoff.
  const ambiguous429 = new Map<string, number>();
  /** Quality EMA feed; a success also clears the model's ambiguous-backoff streak. */
  const note = (model: string, ok: boolean, latencyMs: number): void => {
    ledger.noteOutcome(model, ok, latencyMs);
    if (ok) ambiguous429.delete(model);
  };

  /**
   * Classify + apply an upstream 429 (SPEC §130/§132). Caller has already
   * unreserved. Returns the signal so the caller can build Retry-After.
   */
  const handle429 = (model: string, body: unknown, latencyMs: number): QuotaSignal => {
    const signal = classify429(body);
    ledger.noteOutcome(model, false, latencyMs);
    if (cfg.learning.auto_apply) ledger.applySignal(signal, model);
    if (signal.kind === "daily") {
      ledger.markDoneForDay(model);
    } else if (signal.kind === "minute" || signal.kind === "token_minute") {
      ledger.setCooldown(model, signal.retryDelayMs);
    } else {
      // Ambiguous 429: capped exponential backoff (1s–60s, jittered) so the
      // fleet can't be looped into hammering a model we can't classify.
      const attempt = (ambiguous429.get(model) ?? 0) + 1;
      ambiguous429.set(model, attempt);
      signal.retryDelayMs = ambiguousBackoff(attempt);
      ledger.setCooldown(model, signal.retryDelayMs);
    }
    learnLog.push({ t: new Date().toISOString(), model, ...signal });
    // SPEC §132: the parsed signal itself, as structured JSON.
    log.log(
      "quota_signal",
      {
        model,
        kind: signal.kind,
        quota_id: signal.quotaId,
        quota_metric: signal.quotaMetric,
        learned_limit: signal.learnedLimit,
        retry_delay_ms: signal.retryDelayMs,
      },
      "warn",
    );
    return signal;
  };

  const app = new Hono();

  app.use("*", async (c, next) => {
    if (cfg.auth?.token) {
      const auth = c.req.header("authorization") ?? "";
      if (auth !== `Bearer ${cfg.auth.token}`) {
        // Must be *returned*: a middleware that responds without returning
        // makes Hono report "nothing returned from handler" → 500, not 401.
        return c.json(openaiError(401, "invalid api key", "authentication_error"), 401);
      }
    }
    await next();
  });

  app.get("/healthz", (c) => c.json({ ok: true, project: cfg.project }));

  app.get("/v1/models", (c) => {
    const data = cfg.fleet.flatMap((m) => {
      const base = {
        id: m.model,
        object: "model" as const,
        created: 0,
        owned_by: "google",
      };
      return m.alias ? [base, { ...base, id: m.alias }] : [base];
    });
    c.header("content-type", "application/json");
    return c.body(JSON.stringify({ object: "list", data }));
  });

  app.post("/v1/chat/completions", async (c) => {
    metrics.requests += 1;
    let body: OpenAIChatRequest;
    try {
      body = (await c.req.json()) as OpenAIChatRequest;
    } catch {
      return c.json(openaiError(400, "invalid JSON body", "invalid_request_error"), 400);
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return c.json(openaiError(400, "messages required", "invalid_request_error"), 400);
    }

    const est = estimateInputTokens(body);
    const preferTier = tierHint(c.req.header("x-gfr-tier"));
    const isStream = Boolean(body.stream);
    const maxWaitMs = Math.max(0, cfg.pacing.max_queue_wait_s) * 1000;

    const rejectExhausted = () => {
      metrics.rejected += 1;
      const resetMs = ledger.nextPtResetMs();
      const waitSec = Math.min(Math.max(resetMs, 1000), 86_400_000);
      c.header("retry-after", String(Math.ceil(waitSec / 1000)));
      log.log("rejected", { reason: "fleet_exhausted", est, pt_reset_ms: resetMs }, "warn");
      return c.json(
        openaiError(
          429,
          `gemini-free-router: all models exhausted or busy; next PT reset in ${Math.round(resetMs / 60000)}m`,
          "rate_limit_error",
          "free_tier_exhausted",
        ),
        429,
      );
    };

    // Dry run (GFR_DRY_RUN=1): run admission control only. No upstream call,
    // no reservation, no commit — the ledger stays untouched, so dry-run
    // traffic can never consume real free-tier budget.
    if (cfg.dry_run) {
      const pick = pickModelReadonly(ledger, est, preferTier, resolveModel(body.model, cfg));
      if (!pick) return rejectExhausted();
      metrics.served += 1;
      c.header("x-gfr-dry-run", "1");
      if (isStream) return syntheticStream(c, body, pick.model, est);
      return c.json(syntheticCompletion(pick.model, est));
    }

    const acq = await acquire(ledger, est, {
      maxWaitMs,
      preferTier,
      preferredModel: resolveModel(body.model, cfg),
    });

    if (!acq || "waitExhausted" in acq) {
      return rejectExhausted();
    }

    const modelName = acq.pick.model;
    metrics.queuedWaitMs += 0;

    const controller = new AbortController();
    // Client disconnect cancels upstream to stop wasted TPM.
    onClientClose(c, () => controller.abort());

    const geminiReq = openaiToGemini(body);
    const endpoint = isStream ? "streamGenerateContent?alt=sse" : "generateContent";
    const url = `${cfg.gemini.base_url}/models/${modelName}:${endpoint}`;
    const init: RequestInit = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(geminiReq),
      signal: controller.signal,
    };

    let upstream: Response;
    const upstreamStart = Date.now();
    try {
      upstream = await fetchImpl(url, init);
    } catch (e) {
      ledger.unreserve(modelName, est);
      metrics.rejected += 1;
      const msg = e instanceof Error ? e.message : String(e);
      ledger.noteOutcome(modelName, false, Date.now() - upstreamStart);
      log.log("upstream_error", { model: modelName, status: "fetch_failed", detail: msg }, "error");
      return c.json(openaiError(502, `upstream fetch failed: ${msg}`, "api_error"), 502);
    }
    const upstreamLatencyMs = () => Date.now() - upstreamStart;

    if (upstream.status === 429) {
      metrics.upstream429 += 1;
      let errBody: unknown = null;
      try {
        errBody = await upstream.json();
      } catch {
        /* ignore */
      }
      ledger.unreserve(modelName, est);
      const signal = handle429(modelName, errBody, upstreamLatencyMs());
      // One immediate fallback attempt to the next model (bounded).
      const retry = await acquire(ledger, est, {
        maxWaitMs: Math.min(2_000, maxWaitMs),
        preferTier,
        signal: controller.signal,
      });
      if (retry && "pick" in retry) {
        return proxyUpstream(c, {
          cfg,
          apiKey,
          fetchImpl,
          ledger,
          metrics,
          modelName: retry.pick.model,
          est,
          body,
          isStream,
          controller,
          _retrySameModel: true,
          log,
          note,
          on429: handle429,
        });
      }
      metrics.rejected += 1;
      c.header("retry-after", String(Math.ceil(signal.retryDelayMs / 1000)));
      log.log(
        "rejected",
        { reason: "upstream_quota", model: modelName, kind: signal.kind, retry_delay_ms: signal.retryDelayMs },
        "warn",
      );
      return c.json(
        openaiError(
          429,
          `gemini-free-router: upstream ${signal.kind} quota on ${modelName}; retry in ${Math.ceil(signal.retryDelayMs / 1000)}s`,
          "rate_limit_error",
          signal.kind,
        ),
        429,
      );
    }

    if (!upstream.ok) {
      metrics.upstream5xx += 1;
      ledger.unreserve(modelName, est);
      ledger.noteOutcome(modelName, false, upstreamLatencyMs());
      let detail = "";
      try {
        detail = (await upstream.text()).slice(0, 500);
      } catch {
        /* ignore */
      }
      log.log(
        "upstream_error",
        { model: modelName, status: upstream.status, detail: detail.slice(0, 200) },
        "error",
      );
      return c.json(
        openaiError(upstream.status, `upstream error ${upstream.status}: ${detail}`, "api_error"),
        upstream.status as 400 | 401 | 403 | 404 | 500 | 502 | 503,
      );
    }

    return proxyUpstream(c, {
      cfg,
      apiKey,
      fetchImpl,
      ledger,
      metrics,
      modelName,
      est,
      body,
      isStream,
      controller,
      upstream,
      startedAt: upstreamStart,
      log,
      note,
      on429: handle429,
    });
  });

  app.post("/v1/embeddings", async (c) => {
    metrics.requests += 1;
    let body: OpenAIEmbeddingRequest;
    try {
      body = (await c.req.json()) as OpenAIEmbeddingRequest;
    } catch {
      return c.json(openaiError(400, "invalid JSON body", "invalid_request_error"), 400);
    }
    if (!body.input) {
      return c.json(openaiError(400, "input required", "invalid_request_error"), 400);
    }
    // Filter fleet to embedding models only
    const embeddingModels = cfg.fleet.filter((m) => m.modality === "embeddings");
    if (embeddingModels.length === 0) {
      return c.json(openaiError(500, "no embedding models configured", "internal_error"), 500);
    }
    // Use the first embedding model
    const model = embeddingModels[0].model;
    // Dry run: synthetic vector, upstream never called (see chat handler).
    if (cfg.dry_run) {
      metrics.served += 1;
      c.header("x-gfr-dry-run", "1");
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      const promptTokens = Math.max(16, Math.ceil(inputs.join(" ").length / 4));
      return c.json({
        object: "list" as const,
        data: inputs.map((_, i) => ({
          object: "embedding" as const,
          index: i,
          embedding: new Array<number>(8).fill(0),
        })),
        model,
        usage: { promptTokenCount: promptTokens, totalTokenCount: promptTokens },
      });
    }
    const emb = openaiToGeminiEmbedding(body);
    const url = `${cfg.gemini.base_url}${emb.endpoint}`;
    const controller = new AbortController();
    onClientClose(c, () => controller.abort());
    const embStart = Date.now();
    try {
      const upstream = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(emb.body),
        signal: controller.signal,
      });
      if (!upstream.ok) {
        const text = await upstream.text().catch(() => "");
        note(model, false, Date.now() - embStart);
        log.log("upstream_error", { model, status: upstream.status, modality: "embeddings" }, "error");
        return c.json(
          openaiError(upstream.status, `upstream error: ${text.slice(0, 300)}`, "api_error"),
          upstream.status as 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503,
        );
      }
      const json = await upstream.json() as { data: Array<{ embedding: number[]; index: number }>; usage: { promptTokenCount: number; totalTokenCount: number } };
      const openaiResp = geminiToOpenAIEmbedding(json, model);
      metrics.served += 1;
      note(model, true, Date.now() - embStart);
      log.log("served", { model, latency_ms: Date.now() - embStart, modality: "embeddings" }, "debug");
      return c.json(openaiResp);
    } catch (e) {
      metrics.rejected += 1;
      note(model, false, Date.now() - embStart);
      log.log("upstream_error", { model, status: "fetch_failed", modality: "embeddings" }, "error");
      return c.json(openaiError(502, `upstream fetch failed: ${e instanceof Error ? e.message : String(e)}`, "api_error"), 502);
    }
  });

  app.get("/admin", (c) => {
    const payload = {
      project: cfg.project,
      fleet: ledger.snapshot(),
      metrics,
      learned: learnLog.slice(-50),
      pt_reset_ms: ledger.nextPtResetMs(),
    };
    // README promises "JSON or HTML Accept header" — browsers get the dashboard.
    if ((c.req.header("accept") ?? "").includes("text/html")) {
      return c.html(renderAdminHtml(payload));
    }
    return c.json(payload);
  });

  app.get("/metrics", (c) => {
    const lines = [
      `# TYPE gfr_requests_total counter`,
      `gfr_requests_total ${metrics.requests}`,
      `# TYPE gfr_upstream_429_total counter`,
      `gfr_upstream_429_total ${metrics.upstream429}`,
      `# TYPE gfr_upstream_5xx_total counter`,
      `gfr_upstream_5xx_total ${metrics.upstream5xx}`,
      `# TYPE gfr_served_total counter`,
      `gfr_served_total ${metrics.served}`,
      `# TYPE gfr_rejected_total counter`,
      `gfr_rejected_total ${metrics.rejected}`,
      `# TYPE gfr_pt_reset_ms gauge`,
      `gfr_pt_reset_ms ${ledger.nextPtResetMs()}`,
    ];
    for (const s of ledger.snapshot()) {
      const l = s.model.replace(/[^a-zA-Z0-9_]/g, "_");
      lines.push(`gfr_model_rpd_remaining{model="${s.model}"} ${s.remaining.rpd}`);
      lines.push(`gfr_model_rpm_remaining{model="${s.model}"} ${s.remaining.rpm}`);
      lines.push(`gfr_model_tpm_remaining{model="${s.model}"} ${s.remaining.tpm}`);
      lines.push(`gfr_model_used_rpd{model="${s.model}"} ${s.used.rpd}`);
      lines.push(`gfr_model_in_flight{model="${s.model}"} ${s.used.inFlight}`);
      lines.push(`gfr_model_success_ema{model="${s.model}"} ${s.quality.success}`);
      lines.push(`gfr_model_latency_ema_ms{model="${s.model}"} ${s.quality.latency_ms}`);
      void l;
    }
    c.header("content-type", "text/plain; version=0.0.4");
    return c.body(lines.join("\n") + "\n");
  });

  app.post("/admin/simulate", async (c) => {
    metrics.requests += 1;
    let spec: { hours: number; rps: number; avg_tokens: number };
    try {
      spec = (await c.req.json()) as { hours: number; rps: number; avg_tokens: number };
    } catch {
      return c.json(openaiError(400, "invalid JSON body", "invalid_request_error"), 400);
    }
    if (
      !Number.isFinite(spec.hours) ||
      !Number.isFinite(spec.rps) ||
      !Number.isFinite(spec.avg_tokens) ||
      spec.hours <= 0 ||
      spec.rps <= 0 ||
      spec.avg_tokens <= 0
    ) {
      return c.json(openaiError(400, "hours, rps, and avg_tokens must be positive", "invalid_request_error"), 400);
    }
    // Throwaway in-memory ledger: a simulation must never touch the real one.
    const simLedger = new QuotaLedger(cfg.fleet, new MemoryStore(), 0, cfg.pacing);
    const totalRequested = Math.ceil(spec.hours * 3600 * spec.rps);
    const total = Math.min(totalRequested, MAX_SIM_REQUESTS);
    const arrivalInterval = 1_000 / spec.rps;
    // Virtual clock: time advances by one inter-arrival gap per request, so a
    // simulated day runs in milliseconds instead of 24 real hours.
    let simNow = Date.now();
    // Honour avg_tokens: estimate is ceil(chars/4) + 4 (plus the 16 floor).
    const content = "x".repeat(Math.max(1, (Math.round(spec.avg_tokens) - 4) * 4));
    const emb: OpenAIChatRequest = {
      model: "auto",
      messages: [{ role: "user", content }],
      temperature: 0.2,
    };
    const est = estimateInputTokens(emb);
    let served = 0;
    let rejected = 0;
    for (let i = 0; i < total; i++) {
      simNow += arrivalInterval;
      const acq = await acquire(simLedger, est, {
        maxWaitMs: 0, // virtual clock → never sleep in real time
        preferTier: undefined,
        now: simNow,
      });
      if (acq && "pick" in acq) {
        served++;
        // Must commit against the *picked* model — "auto" is not a fleet entry.
        simLedger.commit(acq.pick.model, est, est);
      } else {
        rejected++;
      }
    }
    simLedger.close();
    const offered = served + rejected;
    // Utilization = share of *offered* load the fleet could absorb.
    // (The old formula divided `hours` out twice: served/(hours*rps*hours).)
    const utilization = offered > 0 ? (served / offered) * 100 : 0;
    return c.json({
      hours: spec.hours,
      rps: spec.rps,
      avg_tokens: spec.avg_tokens,
      offered,
      served,
      rejected,
      truncated: total < totalRequested,
      utilization_percent: Math.round(utilization * 100) / 100,
    });
  });

  return { app, ledger, metrics };
}

function tierHint(h: string | undefined): string | undefined {
  if (!h) return undefined;
  const t = h.toLowerCase();
  return t === "bulk" || t === "standard" || t === "scarce" ? t : undefined;
}

function resolveModel(requested: string | undefined, cfg: RouterConfig): string | undefined {
  if (!requested || requested === "auto" || requested === "gemini-free-router") return undefined;
  const direct = cfg.fleet.find((m) => m.model === requested);
  if (direct) return direct.model;
  const aliased = cfg.fleet.find((m) => m.alias === requested);
  return aliased?.model;
}

/** Hard ceiling so a fat-fingered `/admin/simulate` cannot pin the event loop. */
const MAX_SIM_REQUESTS = 100_000;

/**
 * Dry-run pick: identical ranking to `acquire()` (tier boost + remaining
 * budget) but read-only — `candidates()` never reserves, so no quota is spent.
 */
function pickModelReadonly(
  ledger: QuotaLedger,
  est: number,
  preferTier: string | undefined,
  preferredModel: string | undefined,
): FleetModel | undefined {
  const candidates = ledger.candidates(est, preferTier);
  if (preferredModel) {
    const wanted = candidates.find((m) => m.model === preferredModel);
    if (wanted) return wanted;
  }
  return candidates[0];
}

const DRY_RUN_TEXT =
  "[gemini-free-router dry-run] synthetic response — upstream Gemini was not called and no quota was spent.";
const DRY_RUN_COMPLETION_TOKENS = 18;

function syntheticCompletion(model: string, est: number) {
  return {
    id: completionId(),
    object: "chat.completion" as const,
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant" as const, content: DRY_RUN_TEXT },
        finish_reason: "stop" as const,
      },
    ],
    usage: {
      prompt_tokens: est,
      completion_tokens: DRY_RUN_COMPLETION_TOKENS,
      total_tokens: est + DRY_RUN_COMPLETION_TOKENS,
    },
  };
}

/** Dry-run SSE: same frame sequence as a real stream, no upstream reader. */
function syntheticStream(c: Context, body: OpenAIChatRequest, model: string, est: number): Response {
  const id = completionId();
  const created = Math.floor(Date.now() / 1000);
  const includeUsage = Boolean(body.stream_options?.include_usage);
  const chunk = (choices: unknown[], usage?: unknown) => {
    const out: Record<string, unknown> = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices,
    };
    if (includeUsage) out.usage = usage ?? null;
    return out;
  };
  c.header("content-type", "text/event-stream");
  c.header("cache-control", "no-cache");
  c.header("x-accel-buffering", "no");
  return stream(c, async (out) => {
    await out.write(sseFrame(chunk([{ index: 0, delta: { role: "assistant", content: DRY_RUN_TEXT }, finish_reason: null }])));
    await out.write(sseFrame(chunk([{ index: 0, delta: {}, finish_reason: "stop" }])));
    if (includeUsage) {
      // Trailing OpenAI usage frame: empty `choices`, real (synthetic) counts.
      await out.write(
        sseFrame(
          chunk([], {
            prompt_tokens: est,
            completion_tokens: DRY_RUN_COMPLETION_TOKENS,
            total_tokens: est + DRY_RUN_COMPLETION_TOKENS,
          }),
        ),
      );
    }
    await out.write("data: [DONE]\n\n");
    await out.close();
  });
}

function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Zero-dependency `/admin` dashboard (Accept: text/html). */
function renderAdminHtml(p: {
  project: string;
  fleet: ReturnType<QuotaLedger["snapshot"]>;
  metrics: AppMetrics;
  learned: LearnLogEntry[];
  pt_reset_ms: number;
}): string {
  const rows = p.fleet
    .map((s) => {
      const pct =
        s.configured.rpd > 0 ? Math.round(((s.configured.rpd - s.remaining.rpd) / s.configured.rpd) * 100) : 0;
      const q = s.quality;
      const qText =
        q.samples === 0
          ? "—"
          : `${Math.round(q.success * 100)}% · ${Math.round(q.latency_ms)}ms · n=${q.samples}`;
      return `<tr${s.doneForDay ? ' class="dead"' : ""}>
  <td>${esc(s.model)}</td>
  <td>${s.remaining.rpd} / ${s.configured.rpd}</td>
  <td>${s.used.rpm} / ${s.effective.rpm}</td>
  <td>${s.used.tpm} / ${s.effective.tpm}</td>
  <td>${s.used.inFlight}</td>
  <td><span class="bar"><span style="width:${pct}%"></span></span>${pct}%</td>
  <td>${qText}</td>
  <td>${s.doneForDay ? "done for day" : esc(new Date(s.msToPtReset).toISOString().slice(11, 19))}</td>
</tr>`;
    })
    .join("\n");
  const learned = p.learned
    .slice(-20)
    .reverse()
    .map(
      (l) =>
        `<li><code>${esc(l.t)}</code> ${esc(l.model)} → ${esc(l.kind ?? "unknown")}${
          l.learnedLimit !== undefined ? ` limit=${esc(l.learnedLimit)}` : "" }</li>`,
    )
    .join("\n");
  const m = p.metrics;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="30">
<title>gemini-free-router — ${esc(p.project)}</title>
<style>
  :root { color-scheme: dark; }
  body { font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background:#0d1117; color:#e6edf3; margin:0; padding:24px; }
  h1 { font-size:18px; margin:0 0 4px; } h2 { font-size:14px; margin:24px 0 8px; color:#7d8590; text-transform:uppercase; letter-spacing:.08em; }
  .meta { color:#7d8590; } table { border-collapse:collapse; width:100%; }
  th,td { text-align:left; padding:6px 10px; border-bottom:1px solid #21262d; }
  th { color:#7d8590; font-weight:600; }
  tr.dead td { color:#f85149; }
  .bar { display:inline-block; width:80px; height:8px; background:#21262d; border-radius:4px; overflow:hidden; vertical-align:middle; margin-right:8px; }
  .bar > span { display:block; height:100%; background:#2ea043; }
  .cards { display:flex; gap:12px; flex-wrap:wrap; }
  .card { background:#161b22; border:1px solid #21262d; border-radius:6px; padding:10px 14px; min-width:120px; }
  .card b { display:block; font-size:20px; } .card span { color:#7d8590; font-size:12px; }
  ul { margin:0; padding-left:18px; color:#7d8590; } a { color:#58a6ff; }
</style>
</head>
<body>
<h1>gemini-free-router — ${esc(p.project)}</h1>
<div class="meta">PT reset in <b>${Math.round(p.pt_reset_ms / 60000)}m</b> · auto-refresh 30s · <a href="/admin">JSON</a> · <a href="/metrics">metrics</a></div>
<h2>Router</h2>
<div class="cards">
  <div class="card"><b>${m.requests}</b><span>requests</span></div>
  <div class="card"><b>${m.served}</b><span>served</span></div>
  <div class="card"><b>${m.rejected}</b><span>rejected</span></div>
  <div class="card"><b>${m.upstream429}</b><span>upstream 429</span></div>
  <div class="card"><b>${m.upstream5xx}</b><span>upstream 5xx</span></div>
</div>
<h2>Fleet</h2>
<table>
<thead><tr><th>model</th><th>RPD left</th><th>RPM (used/limit)</th><th>TPM (used/limit)</th><th>in-flight</th><th>day burned</th><th>quality (ok · lat · n)</th><th>PT reset</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<h2>Last parsed 429s</h2>
${learned ? `<ul>${learned}</ul>` : "<div class='meta'>none</div>"}
</body>
</html>`;
}

interface ProxyCtx {
  cfg: RouterConfig;
  apiKey: string;
  fetchImpl: typeof fetch;
  ledger: QuotaLedger;
  metrics: AppMetrics;
  modelName: string;
  est: number;
  body: OpenAIChatRequest;
  isStream: boolean;
  controller: AbortController;
  upstream?: Response;
  _retrySameModel?: boolean;
  /** epoch ms when the upstream call started (for quality latency) */
  startedAt?: number;
  log: Logger;
  /** upstream outcome hook: quality EMA + ambiguous-429 backoff reset */
  note?: (model: string, ok: boolean, latencyMs: number) => void;
  /** classify + apply a 429 seen on the same-model retry path */
  on429?: (model: string, body: unknown, latencyMs: number) => QuotaSignal;
}

interface LearnLogEntry {
  t: string;
  model: string;
  kind?: string;
  learnedLimit?: number;
  modelName?: string;
  quotaId?: string;
  quotaMetric?: string;
  retryDelayMs?: number;
}

async function proxyUpstream(c: Context, ctx: ProxyCtx): Promise<Response> {
  const { cfg, ledger, metrics, modelName, est, body, isStream, controller, log } = ctx;
  const note = ctx.note ?? ((model: string, ok: boolean, latencyMs: number) => ledger.noteOutcome(model, ok, latencyMs));
  // If we had a same-model retry request, fetch a fresh upstream.
  let startedAt = ctx.startedAt ?? Date.now();
  if (ctx._retrySameModel) {
    ctx._retrySameModel = false;
    startedAt = Date.now();
    let upstream: Response;
    try {
      upstream = await ctx.fetchImpl(`${cfg.gemini.base_url}/models/${modelName}:${isStream ? "streamGenerateContent?alt=sse" : "generateContent"}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": ctx.apiKey },
        body: JSON.stringify(openaiToGemini(body)),
        signal: controller.signal,
      });
    } catch (e) {
      ledger.unreserve(modelName, est);
      metrics.rejected += 1;
      note(modelName, false, Date.now() - startedAt);
      return c.json(
        openaiError(502, `upstream fetch failed: ${e instanceof Error ? e.message : String(e)}`, "api_error"),
        502,
      );
    }
    if (!upstream.ok) {
      ledger.unreserve(modelName, est);
      const latency = Date.now() - startedAt;
      if (upstream.status === 429 && ctx.on429) {
        // Same-model retry hit another 429 — classify it like the first one
        // (cool-downs, learned limits, and the structured signal log).
        let body: unknown = null;
        try {
          body = await upstream.json();
        } catch {
          /* ignore */
        }
        const signal = ctx.on429(modelName, body, latency);
        metrics.upstream429 += 1;
        metrics.rejected += 1;
        c.header("retry-after", String(Math.ceil(signal.retryDelayMs / 1000)));
        return c.json(
          openaiError(
            429,
            `gemini-free-router: upstream ${signal.kind} quota on ${modelName}; retry in ${Math.ceil(signal.retryDelayMs / 1000)}s`,
            "rate_limit_error",
            signal.kind,
          ),
          429,
        );
      }
      note(modelName, false, latency);
      const text = await upstream.text().catch(() => "");
      log.log("upstream_error", { model: modelName, status: upstream.status }, "error");
      return c.json(
        openaiError(upstream.status, `upstream error: ${text.slice(0, 300)}`, "api_error"),
        upstream.status as 429,
      );
    }
    ctx.upstream = upstream;
  }
  const upstream = ctx.upstream!;

  if (!isStream) {
    const json = (await upstream.json()) as Parameters<typeof geminiToOpenAI>[0];
    const usage = json.usageMetadata?.promptTokenCount ?? est;
    ledger.commit(modelName, est, usage);
    metrics.served += 1;
    note(modelName, true, Date.now() - startedAt);
    log.log("served", { model: modelName, latency_ms: Date.now() - startedAt, stream: false }, "debug");
    return c.json(geminiToOpenAI(json, modelName));
  }

  // Streaming: translate Gemini SSE → OpenAI chunks without buffering.
  const id = completionId();
  const created = Math.floor(Date.now() / 1000);
  const includeUsage = Boolean(body.stream_options?.include_usage);
  const reader = upstream.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  // Accumulated Gemini usage — the final include_usage chunk must carry real
  // counts (OpenAI clients read them for billing/validation), never null.
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  let totalTokens: number | undefined;
  const noteUsage = (g: GeminiResponse): void => {
    const u = g.usageMetadata;
    if (!u) return;
    if (typeof u.promptTokenCount === "number") promptTokens = u.promptTokenCount;
    if (typeof u.candidatesTokenCount === "number") completionTokens = u.candidatesTokenCount;
    if (typeof u.totalTokenCount === "number") totalTokens = u.totalTokenCount;
  };
  let abortedByClient = false;
  let streamFailed = false;
  onClientClose(c, () => {
    abortedByClient = true;
  });

  c.header("content-type", "text/event-stream");
  c.header("cache-control", "no-cache");
  c.header("x-accel-buffering", "no");
  return stream(c, async (out) => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const g = parseGeminiSseLine(line);
          if (!g) continue;
          noteUsage(g);
          const chunk = geminiChunkToOpenAI(g, modelName, id, created, includeUsage);
          await out.write(sseFrame(chunk));
        }
      }
      if (buf) {
        const g = parseGeminiSseLine(buf);
        if (g) {
          noteUsage(g);
          await out.write(sseFrame(geminiChunkToOpenAI(g, modelName, id, created, includeUsage)));
        }
      }
      if (includeUsage) {
        // OpenAI: one trailing chunk with empty `choices` and real usage,
        // immediately before `data: [DONE]`.
        const p = promptTokens ?? est;
        const comp = completionTokens ?? 0;
        const total = totalTokens ?? p + comp;
        await out.write(
          sseFrame({
            id,
            object: "chat.completion.chunk",
            created,
            model: modelName,
            choices: [],
            usage: { prompt_tokens: p, completion_tokens: comp, total_tokens: total },
          }),
        );
      }
      await out.write("data: [DONE]\n\n");
    } catch {
      /* client disconnect / upstream abort */
      streamFailed = !(abortedByClient || controller.signal.aborted);
    } finally {
      if (abortedByClient || controller.signal.aborted) {
        ledger.release(modelName, est);
      } else {
        ledger.commit(modelName, est, promptTokens ?? est);
        metrics.served += 1;
        note(modelName, !streamFailed, Date.now() - startedAt);
        if (!streamFailed) {
          log.log("served", { model: modelName, latency_ms: Date.now() - startedAt, stream: true }, "debug");
        }
      }
      await out.close();
    }
  });
}

function onClientClose(c: { raw?: unknown; req?: { raw?: { signal?: AbortSignal } } }, cb: () => void): void {
  const raw = c.raw as { addEventListener?: (t: string, l: () => void) => void } | undefined;
  if (raw?.addEventListener) {
    raw.addEventListener("close", cb);
    return;
  }
  c.req?.raw?.signal?.addEventListener?.("abort", cb);
}

export { sleep };