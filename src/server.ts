import { Hono } from "hono";
import { stream } from "hono/streaming";
import type { RouterConfig, OpenAIChatRequest } from "./types.ts";
import { QuotaLedger } from "./ledger.ts";
import { openStore } from "./storage.ts";
import { classify429 } from "./forensics.ts";
import { acquire, sleep } from "./scheduler.ts";
import {
  openaiToGemini,
  estimateInputTokens,
  geminiToOpenAI,
  geminiChunkToOpenAI,
  parseGeminiSseLine,
  sseFrame,
  openaiError,
  completionId,
} from "./translate.ts";

export interface AppDeps {
  cfg: RouterConfig;
  apiKey: string;
  ledger?: QuotaLedger;
  /** injectable for tests */
  fetchImpl?: typeof fetch;
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
  const ledger = deps.ledger ?? new QuotaLedger(cfg.fleet, openStore(cfg.ledger_path));
  const metrics: AppMetrics = {
    requests: 0,
    upstream429: 0,
    upstream5xx: 0,
    queuedWaitMs: 0,
    served: 0,
    rejected: 0,
  };

  const app = new Hono();

  app.use("*", async (c, next) => {
    if (cfg.auth?.token) {
      const auth = c.req.header("authorization") ?? "";
      if (auth !== `Bearer ${cfg.auth.token}`) {
        c.json(openaiError(401, "invalid api key", "authentication_error"), 401);
        return;
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

  app.get("/admin", (c) => {
    return c.json({
      project: cfg.project,
      fleet: ledger.snapshot(),
      metrics,
      pt_reset_ms: ledger.nextPtResetMs(),
    });
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
      void l;
    }
    c.header("content-type", "text/plain; version=0.0.4");
    return c.body(lines.join("\n") + "\n");
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
    const maxWaitMs = Math.max(0, cfg.pacing.max_queue_wait_s) * 1000;

    const acq = await acquire(ledger, est, {
      maxWaitMs,
      preferTier,
      preferredModel: resolveModel(body.model, cfg),
    });

    if (!acq || "waitExhausted" in acq) {
      metrics.rejected += 1;
      const resetMs = ledger.nextPtResetMs();
      const waitSec = Math.min(Math.max(resetMs, 1000), 86_400_000);
      c.header("retry-after", String(Math.ceil(waitSec / 1000)));
      return c.json(
        openaiError(
          429,
          `gemini-free-router: all models exhausted or busy; next PT reset in ${Math.round(resetMs / 60000)}m`,
          "rate_limit_error",
          "free_tier_exhausted",
        ),
        429,
      );
    }

    const modelName = acq.pick.model;
    metrics.queuedWaitMs += 0;

    const controller = new AbortController();
    // Client disconnect cancels upstream to stop wasted TPM.
    onClientClose(c, () => controller.abort());

    const geminiReq = openaiToGemini(body);
    const isStream = Boolean(body.stream);
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
    try {
      upstream = await fetchImpl(url, init);
    } catch (e) {
      ledger.unreserve(modelName, est);
      metrics.rejected += 1;
      const msg = e instanceof Error ? e.message : String(e);
      return c.json(openaiError(502, `upstream fetch failed: ${msg}`, "api_error"), 502);
    }

    if (upstream.status === 429) {
      metrics.upstream429 += 1;
      let errBody: unknown = null;
      try {
        errBody = await upstream.json();
      } catch {
        /* ignore */
      }
      const signal = classify429(errBody);
      ledger.unreserve(modelName, est);
      learnLog.push({ t: new Date().toISOString(), model: modelName, ...signal });
      if (cfg.learning.auto_apply) ledger.applySignal(signal, modelName);
      if (signal.kind === "daily") {
        ledger.markDoneForDay(modelName);
      } else if (signal.kind === "minute" || signal.kind === "token_minute") {
        ledger.setCooldown(modelName, signal.retryDelayMs);
      }
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
        });
      }
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

    if (!upstream.ok) {
      metrics.upstream5xx += 1;
      ledger.unreserve(modelName, est);
      let detail = "";
      try {
        detail = (await upstream.text()).slice(0, 500);
      } catch {
        /* ignore */
      }
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
    const emb = openaiToGeminiEmbedding(body);
    const url = `${cfg.gemini.base_url}${emb.endpoint}`;
    try {
      const upstream = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(emb.body),
        signal: controller.signal,
      });
      if (!upstream.ok) {
        const text = await upstream.text().catch(() => "");
        return c.json(openaiError(upstream.status, `upstream error: ${text.slice(0, 300)}`, "api_error"), upstream.status);
      }
      const json = await upstream.json() as { data: Array<{ embedding: number[]; index: number }>; usage: { promptTokenCount: number; totalTokenCount: number } };
      const openaiResp = geminiToOpenAIEmbedding(json, model);
      metrics.served += 1;
      return c.json(openaiResp);
    } catch (e) {
      metrics.rejected += 1;
      return c.json(openaiError(502, `upstream fetch failed: ${e instanceof Error ? e.message : String(e)}`, "api_error"), 502);
    }
  });

  app.get("/admin", (c) => {
    return c.json({
      project: cfg.project,
      fleet: ledger.snapshot(),
      metrics,
      learned: learnLog.slice(-50),
      pt_reset_ms: ledger.nextPtResetMs(),
    });
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
    if (spec.hours <= 0 || spec.rps <= 0 || spec.avg_tokens <= 0) {
      return c.json(openaiError(400, "hours, rps, and avg_tokens must be positive", "invalid_request_error"), 400);
    }
    const simLedger = new QuotaLedger(cfg.fleet, openStore(cfg.ledger_path + ".sim"), 0);
    const now = Date.now();
    let served = 0;
    let rejected = 0;
    const arrivalInterval = 1_000 / spec.rps;
    for (let i = 0; i < spec.hours * 3600 * spec.rps; i++) {
      await sleep(arrivalInterval);
      const emb = {
        model: "auto",
        messages: [{ role: "user", content: "hello" }],
        temperature: 0.2,
      };
      const acq = await acquire(simLedger, estimateInputTokens(emb), {
        maxWaitMs: 5_000,
        preferTier: undefined,
      });
      if (acq && !("waitExhausted" in acq)) {
        served++;
        simLedger.commit(emb.model, estimateInputTokens(emb), estimateInputTokens(emb));
      } else {
        rejected++;
      }
    }
    const utilization = (served / (spec.hours * spec.rps * spec.hours)) * 100;
    return c.json({
      hours: spec.hours,
      rps: spec.rps,
      avg_tokens: spec.avg_tokens,
      served,
      rejected,
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
}

interface LearnLogEntry {
  t: string;
  model: string;
  kind?: string;
  learnedLimit?: number;
  modelName?: string;
}

let learnLog: LearnLogEntry[] = [];

async function proxyUpstream(c: any, ctx: ProxyCtx): Promise<Response> {
  const { cfg, ledger, metrics, modelName, est, body, isStream, controller } = ctx;
  // If we had a same-model retry request, fetch a fresh upstream.
  if (ctx._retrySameModel) {
    ctx._retrySameModel = false;
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
      return c.json(
        openaiError(502, `upstream fetch failed: ${e instanceof Error ? e.message : String(e)}`, "api_error"),
        502,
      );
    }
    if (!upstream.ok) {
      ledger.unreserve(modelName, est);
      const text = await upstream.text().catch(() => "");
      return c.json(
        openaiError(upstream.status, `upstream error: ${text.slice(0, 300)}`, "api_error"),
        upstream.status as 429,
      );
    }
    ctx.upstream = upstream;
  }
  let upstream = ctx.upstream!;

  if (!isStream) {
    const json = (await upstream.json()) as Parameters<typeof geminiToOpenAI>[0];
    const usage = json.usageMetadata?.promptTokenCount ?? est;
    ledger.commit(modelName, est, usage);
    metrics.served += 1;
    return c.json(geminiToOpenAI(json, modelName));
  }

  // Streaming: translate Gemini SSE → OpenAI chunks without buffering.
  const id = completionId();
  const created = Math.floor(Date.now() / 1000);
  const includeUsage = Boolean(body.stream_options?.include_usage);
  const reader = upstream.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let lastUsage: number | undefined;
  let abortedByClient = false;
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
          if (g.usageMetadata?.promptTokenCount) lastUsage = g.usageMetadata.promptTokenCount;
          const chunk = geminiChunkToOpenAI(g, modelName, id, created, includeUsage);
          await out.write(sseFrame(chunk));
        }
      }
      if (buf) {
        const g = parseGeminiSseLine(buf);
        if (g) {
          if (g.usageMetadata?.promptTokenCount) lastUsage = g.usageMetadata.promptTokenCount;
          await out.write(sseFrame(geminiChunkToOpenAI(g, modelName, id, created, includeUsage)));
        }
      }
      if (includeUsage) {
        await out.write(sseFrame({ id, object: "chat.completion.chunk", created, model: modelName, choices: [], usage: null }));
      }
      await out.write("data: [DONE]\n\n");
    } catch {
      /* client disconnect / upstream abort */
    } finally {
      if (abortedByClient || controller.signal.aborted) {
        ledger.release(modelName, est);
      } else {
        ledger.commit(modelName, est, lastUsage ?? est);
        metrics.served += 1;
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

function tierHint(h: string | undefined): string | undefined {
  if (!h) return undefined;
  const t = h.toLowerCase();
  return t === "bulk" || t === "standard" || t === "scarce" ? t : undefined;
}

function reqToBody<T>(): T {
  // Helper for type assertions
  return {} as T;
}

export { sleep };