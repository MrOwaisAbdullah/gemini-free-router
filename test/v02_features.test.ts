import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "undici";
import { createApp } from "../src/server.ts";
import { QuotaLedger } from "../src/ledger.ts";
import { JsonStore } from "../src/storage.ts";
import { jitter, ambiguousBackoff } from "../src/time.ts";
import { createLogger, parseLogLevel, silentLogger } from "../src/log.ts";
import { configureKeepAlive, currentDispatcher, DEFAULT_POOL } from "../src/pool.ts";
import type { RouterConfig, FleetModel } from "../src/types.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const FLEET: FleetModel[] = [
  { model: "gem-a", rpm: 10, rpd: 500, tpm: 100_000, tier: "bulk" },
  { model: "gem-b", rpm: 10, rpd: 500, tpm: 100_000, tier: "bulk" },
];

const pacing: RouterConfig["pacing"] = {
  max_queue_wait_s: 0,
  burn_curve: "front-loaded",
  max_in_flight_per_model: "auto",
};

function makeCfg(fleet: FleetModel[], extra: Partial<RouterConfig> = {}): RouterConfig {
  return {
    project: "v02",
    listen: { host: "127.0.0.1", port: 0 },
    gemini: { base_url: "https://example.invalid/v1beta", api_key_env: "GEMINI_API_KEY" },
    fleet,
    pacing,
    fallback: { strategy: "remaining-budget" },
    learning: { auto_apply: false },
    modalities: ["chat"],
    ledger_path: join(mkdtempSync(join(tmpdir(), "gfr-")), "l.json"),
    dry_run: false,
    ...extra,
  };
}

function makeLedger(fleet: FleetModel[], path?: string): QuotaLedger {
  const dir = mkdtempSync(join(tmpdir(), "gfr-q-"));
  return new QuotaLedger(fleet, new JsonStore(path ?? join(dir, "l.json")), 0, pacing);
}

const GEMINI_OK = JSON.stringify({
  candidates: [{ content: { parts: [{ text: "pong" }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2, totalTokenCount: 9 },
});

interface LogLine {
  ts: string;
  level: string;
  event: string;
  [k: string]: unknown;
}

function captureLogger(level: "debug" | "info" | "warn" | "error" | "off" = "debug") {
  const lines: LogLine[] = [];
  const logger = createLogger({ level, sink: (l) => lines.push(JSON.parse(l) as LogLine) });
  return { logger, lines };
}

const chatBody = { model: "auto", messages: [{ role: "user", content: "hi" }] };

function chatReq(headers: Record<string, string> = {}): Request {
  return new Request("http://x/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(chatBody),
  });
}

// ---------------------------------------------------------------------------
// jitter (SPEC §7.3) — router-owned timers only
// ---------------------------------------------------------------------------

test("jitter: ±spread bounds, deterministic with an injected rand", () => {
  assert.equal(jitter(1000, 0.2, () => 0), 800);
  assert.equal(jitter(1000, 0.2, () => 1), 1200);
  assert.equal(jitter(1000, 0.2, () => 0.5), 1000);
  assert.equal(jitter(0), 0);
  assert.equal(jitter(-5), -5);
});

test("jitter: random draws stay inside the band and actually vary", () => {
  const draws = new Set<number>();
  for (let i = 0; i < 500; i++) {
    const v = jitter(1_000, 0.2);
    assert.ok(v >= 800 && v <= 1200, `out of band: ${v}`);
    draws.add(v);
  }
  assert.ok(draws.size > 10, `expected varied draws, got ${draws.size}`);
});

test("ambiguousBackoff: 1s → 60s capped, jittered, attempt floors at 1", () => {
  assert.equal(ambiguousBackoff(1, () => 0), 800);
  assert.equal(ambiguousBackoff(2, () => 0.5), 2000);
  assert.equal(ambiguousBackoff(0, () => 0.5), 1000);
  assert.equal(ambiguousBackoff(7, () => 1), 60_000);
  assert.equal(ambiguousBackoff(99, () => 1), 60_000);
  for (let attempt = 1; attempt <= 12; attempt++) {
    const v = ambiguousBackoff(attempt);
    assert.ok(v >= 800 && v <= 60_000, `attempt ${attempt} → ${v}`);
  }
});

// ---------------------------------------------------------------------------
// structured logger (SPEC §7.8 / §141)
// ---------------------------------------------------------------------------

test("logger: level filtering + JSON-line shape", () => {
  const { logger, lines } = captureLogger("warn");
  logger.log("hidden", { a: 1 }, "debug");
  logger.log("hidden", { a: 1 }, "info");
  logger.log("shown", { model: "gem-a", skipped: undefined }, "warn");
  logger.log("boom", undefined, "error");

  assert.equal(lines.length, 2);
  assert.equal(lines[0].event, "shown");
  assert.equal(lines[0].level, "warn");
  assert.equal(lines[0].model, "gem-a");
  assert.ok(!("skipped" in lines[0]), "undefined fields are dropped");
  assert.ok(!Number.isNaN(Date.parse(lines[0].ts)), "ts is ISO-8601");
  assert.equal(lines[1].event, "boom");
  assert.equal(lines[1].level, "error");
});

test("logger: unserializable fields never throw", () => {
  const lines: LogLine[] = [];
  const logger = createLogger({ level: "debug", sink: (l) => lines.push(JSON.parse(l) as LogLine) });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.doesNotThrow(() => logger.log("cyclic", { bad: cyclic }));
  assert.equal(lines[0].event, "cyclic");
  assert.equal(lines[0].log_error, "unserializable_fields");
});

test("logger: silentLogger writes nothing", () => {
  assert.equal(silentLogger.level, "off");
  assert.doesNotThrow(() => silentLogger.log("anything", { x: 1 }));
});

test("logger: parseLogLevel accepts aliases, rejects junk to warn", () => {
  assert.equal(parseLogLevel("debug"), "debug");
  assert.equal(parseLogLevel("INFO"), "info");
  assert.equal(parseLogLevel("0"), "off");
  assert.equal(parseLogLevel("false"), "off");
  assert.equal(parseLogLevel("nope"), "warn");
  assert.equal(parseLogLevel(undefined), "warn");
  assert.equal(parseLogLevel(undefined, "error"), "error");
});

test("logger: GFR_LOG env sets the default level", () => {
  const prev = process.env.GFR_LOG;
  process.env.GFR_LOG = "error";
  try {
    assert.equal(createLogger({ sink: () => {} }).level, "error");
    delete process.env.GFR_LOG;
    assert.equal(createLogger({ sink: () => {} }).level, "warn");
  } finally {
    if (prev === undefined) delete process.env.GFR_LOG;
    else process.env.GFR_LOG = prev;
  }
});

// ---------------------------------------------------------------------------
// rolling quality → fallback re-ranking (SPEC §7.4)
// ---------------------------------------------------------------------------

test("quality: equal budget with no samples keeps the budget order (regression)", () => {
  const ledger = makeLedger(FLEET);
  const names = ledger.candidates(10).map((m) => m.model);
  assert.deepEqual(names, ["gem-a", "gem-b"]);
  ledger.close();
});

test("quality: failures demote a model below an equal-budget peer", () => {
  const ledger = makeLedger(FLEET);
  for (let i = 0; i < 10; i++) ledger.noteOutcome("gem-a", false, 100);
  const names = ledger.candidates(10).map((m) => m.model);
  assert.deepEqual(names, ["gem-b", "gem-a"], "failing model must fall behind");
  ledger.close();
});

test("quality: successes promote a model above an equal-budget peer", () => {
  const ledger = makeLedger(FLEET);
  for (let i = 0; i < 10; i++) ledger.noteOutcome("gem-b", true, 0);
  const names = ledger.candidates(10).map((m) => m.model);
  assert.deepEqual(names, ["gem-b", "gem-a"]);
  ledger.close();
});

test("quality: latency counts against success (slow model ranks below neutral)", () => {
  const ledger = makeLedger(FLEET);
  for (let i = 0; i < 10; i++) ledger.noteOutcome("gem-a", true, 8_000);
  for (let i = 0; i < 10; i++) ledger.noteOutcome("gem-b", true, 10);
  const names = ledger.candidates(10).map((m) => m.model);
  assert.deepEqual(names, ["gem-b", "gem-a"]);
  ledger.close();
});

test("quality: snapshot exposes success/latency/samples, neutral before 3 samples", () => {
  const ledger = makeLedger(FLEET);
  const fresh = ledger.snapshot().find((s) => s.model === "gem-a")!.quality;
  assert.deepEqual(fresh, { success: 0.5, latency_ms: 0, samples: 0 });

  ledger.noteOutcome("gem-a", true, 100);
  const one = ledger.snapshot().find((s) => s.model === "gem-a")!.quality;
  assert.equal(one.samples, 1);
  assert.ok(one.success > 0.5 && one.success <= 1);
  assert.ok(one.latency_ms > 0);
  ledger.close();
});

test("quality: survives flush → restore across ledger restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "gfr-q-"));
  const path = join(dir, "l.json");
  const a = new QuotaLedger(FLEET, new JsonStore(path), 0, pacing);
  for (let i = 0; i < 5; i++) a.noteOutcome("gem-a", false, 50);
  a.flush();
  a.close();

  const b = new QuotaLedger(FLEET, new JsonStore(path), 0, pacing);
  const restored = b.snapshot().find((s) => s.model === "gem-a")!.quality;
  assert.equal(restored.samples, 5);
  assert.ok(restored.success < 0.5, "failures must not be forgotten across restarts");
  b.close();
});

// ---------------------------------------------------------------------------
// server wiring: quality feed, structured logs, ambiguous-429 backoff
// ---------------------------------------------------------------------------

test("server: a served request feeds quality and emits a structured log", async () => {
  const { logger, lines } = captureLogger("debug");
  const cfg = makeCfg(FLEET);
  const ledger = makeLedger(FLEET);
  const { app } = createApp({
    cfg,
    apiKey: "k",
    ledger,
    logger,
    fetchImpl: async () => new Response(GEMINI_OK, { status: 200 }),
  });

  const res = await app.fetch(chatReq());
  assert.equal(res.status, 200);
  const json = (await res.json()) as { model: string };

  const served = lines.find((l) => l.event === "served");
  assert.ok(served, `expected a served event, saw ${lines.map((l) => l.event).join(",")}`);
  assert.equal(served.model, json.model);
  assert.ok(typeof served.latency_ms === "number");

  const q = ledger.snapshot().find((s) => s.model === json.model)!.quality;
  assert.equal(q.samples, 1);
  assert.ok(q.success > 0.5);
  ledger.close();
});

test("server: ambiguous 429 logs the parsed signal and backs off 1s → 2s", async () => {
  const { logger, lines } = captureLogger("debug");
  const single: FleetModel[] = [{ model: "gem-a", rpm: 10, rpd: 500, tpm: 100_000, tier: "bulk" }];
  const cfg = makeCfg(single, { pacing: { ...pacing, max_queue_wait_s: 3 } });
  const ledger = makeLedger(single);
  const { app } = createApp({
    cfg,
    apiKey: "k",
    ledger,
    logger,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ error: { code: 429, message: "Busy right now, try again.", status: "RESOURCE_EXHAUSTED" } }),
        { status: 429, headers: { "content-type": "application/json" } },
      ),
  });

  const res = await app.fetch(chatReq());
  assert.equal(res.status, 429);

  const signals = lines.filter((l) => l.event === "quota_signal");
  assert.ok(signals.length >= 1, `expected quota_signal events, saw ${lines.map((l) => l.event).join(",")}`);
  const first = signals[0];
  assert.equal(first.kind, "unknown");
  assert.equal(first.model, "gem-a");
  const firstDelay = first.retry_delay_ms as number;
  assert.ok(firstDelay >= 800 && firstDelay <= 1_200, `attempt 1 backoff ${firstDelay}`);

  // The same model got a second bite inside the retry window → attempt 2 doubles.
  if (signals.length > 1) {
    const second = signals[1].retry_delay_ms as number;
    assert.ok(second > firstDelay, `attempt 2 (${second}) must exceed attempt 1 (${firstDelay})`);
    assert.ok(second <= 2_400, `attempt 2 backoff ${second}`);
  }
  const lastDelay = signals.at(-1)!.retry_delay_ms as number;
  assert.equal(res.headers.get("retry-after"), String(Math.ceil(lastDelay / 1000)));

  // Cooldown was applied → the ledger is not immediately re-serveable.
  assert.equal(ledger.canServe("gem-a", 10).ok, false);
  ledger.close();
});

test("server: known-kind 429 keeps honoring Google's retryDelay exactly", async () => {
  const { logger, lines } = captureLogger("debug");
  const single: FleetModel[] = [{ model: "gem-a", rpm: 10, rpd: 500, tpm: 100_000, tier: "bulk" }];
  const cfg = makeCfg(single);
  const ledger = makeLedger(single);
  const minuteBody: unknown = JSON.parse(
    readFileSync(fileURLToPath(new URL("./fixtures/429-minute.json", import.meta.url)), "utf8"),
  );
  const { app } = createApp({
    cfg,
    apiKey: "k",
    ledger,
    logger,
    fetchImpl: async () => new Response(JSON.stringify(minuteBody), { status: 429 }),
  });

  const res = await app.fetch(chatReq());
  assert.equal(res.status, 429);
  const signal = lines.find((l) => l.event === "quota_signal");
  assert.equal(signal?.kind, "minute");
  assert.equal(signal?.retry_delay_ms, 38_000, "RetryInfo 38s must be honored, not jittered");
  assert.equal(res.headers.get("retry-after"), "38");
  ledger.close();
});

test("admin + metrics expose the rolling quality signal", async () => {
  const cfg = makeCfg(FLEET);
  const ledger = makeLedger(FLEET);
  ledger.noteOutcome("gem-a", true, 120);
  ledger.noteOutcome("gem-a", false, 30);
  const { app } = createApp({ cfg, apiKey: "k", ledger, fetchImpl: async () => new Response(GEMINI_OK) });

  const html = await (
    await app.fetch(new Request("http://x/admin", { headers: { accept: "text/html" } }))
  ).text();
  assert.ok(html.includes("quality (ok · lat · n)"), "dashboard has a quality column");

  const admin = (await (await app.fetch(new Request("http://x/admin"))).json()) as {
    fleet: Array<{ model: string; quality: { success: number; samples: number } }>;
  };
  assert.equal(admin.fleet.find((f) => f.model === "gem-a")?.quality.samples, 2);

  const metrics = await (await app.fetch(new Request("http://x/metrics"))).text();
  assert.ok(metrics.includes('gfr_model_success_ema{model="gem-a"}'));
  assert.ok(metrics.includes('gfr_model_latency_ema_ms{model="gem-a"}'));
  ledger.close();
});

// ---------------------------------------------------------------------------
// keep-alive pool (SPEC §7.6)
// ---------------------------------------------------------------------------

test("pool: configureKeepAlive installs the global fetch dispatcher", () => {
  const agent = configureKeepAlive({ connections: 4, keepAliveTimeoutMs: 5_000 });
  try {
    assert.ok(agent instanceof Agent);
    assert.equal(currentDispatcher(), agent);
    // Node's fetch resolves its dispatcher from this well-known symbol — the
    // same one the undici package writes — which is what makes the pool real.
    assert.equal((globalThis as Record<PropertyKey, unknown>)[Symbol.for("undici.globalDispatcher.1")], agent);
    assert.ok(DEFAULT_POOL.connections > 0);
  } finally {
    void agent.close();
  }
});

test("pool: concurrent upstream calls reuse one socket", async () => {
  let connections = 0;
  const server = createServer((_req, res) => res.end("ok"));
  server.on("connection", () => connections++);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  const agent = configureKeepAlive({ connections: 1, keepAliveTimeoutMs: 10_000 });
  try {
    await Promise.all([1, 2, 3].map(() => fetch(`http://127.0.0.1:${port}/`).then((r) => r.text())));
    assert.equal(connections, 1, `expected one pooled socket, saw ${connections}`);
  } finally {
    await agent.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
