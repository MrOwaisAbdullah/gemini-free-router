import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.ts";
import { QuotaLedger } from "../src/ledger.ts";
import { JsonStore, SqliteStore, openStore, MemoryStore } from "../src/storage.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouterConfig, FleetModel } from "../src/types.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const CHAT_FLEET: FleetModel[] = [
  { model: "gem-a", rpm: 10, rpd: 50, tpm: 100_000, tier: "bulk", alias: "fast" },
  { model: "gem-b", rpm: 10, rpd: 500, tpm: 100_000, tier: "scarce" },
];

const EMB_FLEET: FleetModel[] = [
  { model: "gemini-embedding-1", rpm: 100, rpd: 1000, tpm: 30_000, tier: "bulk", modality: "embeddings" },
];

function makeCfg(fleet: FleetModel[], extra: Partial<RouterConfig> = {}): RouterConfig {
  return {
    project: "test",
    listen: { host: "127.0.0.1", port: 0 },
    gemini: { base_url: "https://example.invalid/v1beta", api_key_env: "GEMINI_API_KEY" },
    fleet,
    pacing: { max_queue_wait_s: 0, burn_curve: "front-loaded", max_in_flight_per_model: "auto" },
    fallback: { strategy: "remaining-budget" },
    learning: { auto_apply: false },
    modalities: ["chat"],
    ledger_path: join(mkdtempSync(join(tmpdir(), "gfr-")), "l.json"),
    dry_run: false,
    ...extra,
  };
}

function makeApp(cfg: RouterConfig, fetchImpl: typeof fetch) {
  const dir = mkdtempSync(join(tmpdir(), "gfr-"));
  const ledger = new QuotaLedger(cfg.fleet, new JsonStore(join(dir, "l.json")), 0, cfg.pacing);
  return createApp({ cfg, apiKey: "test-key", ledger, fetchImpl });
}

const chatBody = { model: "auto", messages: [{ role: "user", content: "hi" }] };

const GEMINI_OK = JSON.stringify({
  candidates: [{ content: { parts: [{ text: "pong" }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2, totalTokenCount: 9 },
});

function okFetch(): typeof fetch {
  return async () => new Response(GEMINI_OK, { status: 200 });
}

function framesOf(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (payload === "[DONE]" || !payload) continue;
    out.push(JSON.parse(payload) as Record<string, unknown>);
  }
  return out;
}

// ---------------------------------------------------------------------------
// POST /v1/embeddings
// ---------------------------------------------------------------------------

test("embeddings: translates OpenAI request to Gemini embedContent and back", async () => {
  const cfg = makeCfg(EMB_FLEET);
  const seen: string[] = [];
  const { app } = makeApp(cfg, async (url) => {
    seen.push(String(url));
    return new Response(
      JSON.stringify({
        data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
        usage: { promptTokenCount: 2, totalTokenCount: 2 },
      }),
      { status: 200 },
    );
  });
  const res = await app.fetch(
    new Request("http://x/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gemini-embedding-1", input: "hello world" }),
    }),
  );
  assert.equal(res.status, 200);
  assert.ok(seen[0]?.includes("embedContent"), `upstream url: ${seen[0]}`);
  const json = (await res.json()) as {
    object: string;
    data: Array<{ embedding: number[] }>;
    model: string;
    usage: { promptTokenCount: number };
  };
  assert.equal(json.object, "list");
  assert.equal(json.data[0].embedding.length, 3);
  assert.equal(json.model, "gemini-embedding-1");
  assert.equal(json.usage.promptTokenCount, 2);
});

test("embeddings: missing input → 400 invalid_request_error", async () => {
  const { app } = makeApp(makeCfg(EMB_FLEET), okFetch());
  const res = await app.fetch(
    new Request("http://x/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto" }),
    }),
  );
  assert.equal(res.status, 400);
  const json = (await res.json()) as { error: { type: string } };
  assert.equal(json.error.type, "invalid_request_error");
});

test("embeddings: fleet without embedding models → 500", async () => {
  const { app } = makeApp(makeCfg(CHAT_FLEET), okFetch());
  const res = await app.fetch(
    new Request("http://x/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", input: "hi" }),
    }),
  );
  assert.equal(res.status, 500);
});

// ---------------------------------------------------------------------------
// GFR_TOKEN auth middleware
// ---------------------------------------------------------------------------

test("auth: missing/wrong Bearer → 401 authentication_error", async () => {
  const { app } = makeApp(makeCfg(CHAT_FLEET, { auth: { token: "s3cret" } }), okFetch());

  const anon = await app.fetch(
    new Request("http://x/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chatBody),
    }),
  );
  assert.equal(anon.status, 401);
  const anonJson = (await anon.json()) as { error: { type: string } };
  assert.equal(anonJson.error.type, "authentication_error");

  const wrong = await app.fetch(
    new Request("http://x/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer nope" },
      body: JSON.stringify(chatBody),
    }),
  );
  assert.equal(wrong.status, 401);
});

test("auth: correct Bearer token passes", async () => {
  const { app } = makeApp(makeCfg(CHAT_FLEET, { auth: { token: "s3cret" } }), okFetch());
  const res = await app.fetch(
    new Request("http://x/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer s3cret" },
      body: JSON.stringify(chatBody),
    }),
  );
  assert.equal(res.status, 200);
});

test("auth: no token configured → open access", async () => {
  const { app } = makeApp(makeCfg(CHAT_FLEET), okFetch());
  const res = await app.fetch(
    new Request("http://x/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chatBody),
    }),
  );
  assert.equal(res.status, 200);
});

// ---------------------------------------------------------------------------
// x-gfr-tier preference routing
// ---------------------------------------------------------------------------

test("x-gfr-tier: bulk header overrides remaining-budget ranking", async () => {
  // gem-b has 10x the remaining RPD, so the default pick is gem-b.
  // Asking for `bulk` must promote gem-a (tier boost) instead.
  const defaultRun = makeApp(makeCfg(CHAT_FLEET), okFetch());
  const def = await defaultRun.app.fetch(
    new Request("http://x/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chatBody),
    }),
  );
  const defJson = (await def.json()) as { model: string };
  assert.equal(defJson.model, "gem-b");

  const tierRun = makeApp(makeCfg(CHAT_FLEET), okFetch());
  const tier = await tierRun.app.fetch(
    new Request("http://x/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-gfr-tier": "bulk" },
      body: JSON.stringify(chatBody),
    }),
  );
  const tierJson = (await tier.json()) as { model: string };
  assert.equal(tierJson.model, "gem-a");
});

test("x-gfr-tier: unknown tier value is ignored (falls back to ranking)", async () => {
  const { app } = makeApp(makeCfg(CHAT_FLEET), okFetch());
  const res = await app.fetch(
    new Request("http://x/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-gfr-tier": "banana" },
      body: JSON.stringify(chatBody),
    }),
  );
  const json = (await res.json()) as { model: string };
  assert.equal(json.model, "gem-b");
});

// ---------------------------------------------------------------------------
// SqliteStore
// ---------------------------------------------------------------------------

test("SqliteStore: save → load round-trip (or documented JSON fallback)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gfr-sql-"));
  const path = join(dir, "ledger.sqlite");
  const payload = { day: "2026-10-13", models: { "gem-a": { rpd: 42, doneForDay: false } } };

  let store: SqliteStore;
  try {
    store = new SqliteStore(path);
  } catch {
    // Runtime has no node:sqlite/bun:sqlite → openStore must fall back to JSON.
    const fallback = openStore(path);
    assert.ok(fallback instanceof JsonStore, "expected JsonStore fallback without sqlite runtime");
    fallback.save(payload);
    assert.deepEqual(fallback.load(), payload);
    return;
  }

  store.save(payload);
  assert.deepEqual(store.load(), payload);

  const reopened = new SqliteStore(path);
  assert.deepEqual(reopened.load(), payload, "sqlite state survives reopen");

  // openStore must route .sqlite paths to SqliteStore when the runtime allows.
  const viaHelper = openStore(path);
  assert.ok(viaHelper instanceof SqliteStore, "openStore(.sqlite) → SqliteStore");

  reopened.close();
});

test("MemoryStore: volatile round-trip, no file on disk", () => {
  const store = new MemoryStore();
  assert.equal(store.load(), null);
  store.save({ a: 1 });
  assert.deepEqual(store.load(), { a: 1 });
  store.close();
  assert.deepEqual(store.load(), { a: 1 });
});

// ---------------------------------------------------------------------------
// POST /admin/simulate — bug 3 (formula) + bug 4 (real-time clock)
// ---------------------------------------------------------------------------

test("simulate: rejects non-positive spec with 400", async () => {
  const { app } = makeApp(makeCfg(CHAT_FLEET), okFetch());
  const res = await app.fetch(
    new Request("http://x/admin/simulate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hours: 0, rps: 10, avg_tokens: 100 }),
    }),
  );
  assert.equal(res.status, 400);
});

test("simulate: 2 simulated hours finish in milliseconds with a sane utilization", async () => {
  const { app } = makeApp(makeCfg(CHAT_FLEET), okFetch());
  const started = Date.now();
  const res = await app.fetch(
    new Request("http://x/admin/simulate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hours: 2, rps: 1, avg_tokens: 50 }),
    }),
  );
  const elapsedMs = Date.now() - started;
  assert.equal(res.status, 200);
  const json = (await res.json()) as {
    hours: number;
    offered: number;
    served: number;
    rejected: number;
    utilization_percent: number;
    truncated: boolean;
  };

  // Bug 4: the old implementation slept 1s per arrival → 7200 real seconds.
  assert.ok(elapsedMs < 10_000, `expected accelerated clock, took ${elapsedMs}ms`);

  // offered = hours * 3600 * rps
  assert.equal(json.offered, 2 * 3600 * 1);
  assert.equal(json.served + json.rejected, json.offered);
  assert.equal(json.truncated, false);

  // Bug 3: old formula was served/(hours*rps*hours) → 7200/(2*1*2) = 180000%.
  assert.ok(json.utilization_percent > 0 && json.utilization_percent <= 100);
  const expected = Math.round((json.served / json.offered) * 10_000) / 100;
  assert.equal(json.utilization_percent, expected);
});

test("simulate: oversized spec is capped, never runs forever", async () => {
  const { app } = makeApp(makeCfg(CHAT_FLEET), okFetch());
  const started = Date.now();
  const res = await app.fetch(
    new Request("http://x/admin/simulate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hours: 500, rps: 1000, avg_tokens: 20 }),
    }),
  );
  const elapsedMs = Date.now() - started;
  assert.equal(res.status, 200);
  const json = (await res.json()) as { offered: number; truncated: boolean };
  assert.equal(json.truncated, true);
  assert.equal(json.offered, 100_000);
  assert.ok(elapsedMs < 30_000, `cap should bound runtime, took ${elapsedMs}ms`);
});

// ---------------------------------------------------------------------------
// GFR_DRY_RUN — bug 1 (parsed but never used)
// ---------------------------------------------------------------------------

test("dry-run: chat gets synthetic response, upstream never called, no quota spent", async () => {
  const cfg = makeCfg(CHAT_FLEET, { dry_run: true });
  const { app, ledger, metrics } = makeApp(cfg, async () => {
    throw new Error("upstream must not be called in dry-run");
  });
  const res = await app.fetch(
    new Request("http://x/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chatBody),
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-gfr-dry-run"), "1");
  const json = (await res.json()) as {
    model: string;
    choices: Array<{ message: { content: string } }>;
    usage: { prompt_tokens: number; total_tokens: number };
  };
  assert.ok(["gem-a", "gem-b"].includes(json.model));
  assert.ok(json.choices[0].message.content.includes("dry-run"));
  assert.ok(json.usage.prompt_tokens > 0);

  // Admission control ran, but the ledger must be untouched.
  assert.equal(metrics.served, 1);
  for (const s of ledger.snapshot()) {
    assert.equal(s.used.rpd, 0, `ledger spent quota on ${s.model}`);
    assert.equal(s.used.rpm, 0);
  }
});

test("dry-run: streaming honours include_usage with real synthetic counts", async () => {
  const cfg = makeCfg(CHAT_FLEET, { dry_run: true });
  const { app, ledger } = makeApp(cfg, async () => {
    throw new Error("upstream must not be called in dry-run");
  });
  const res = await app.fetch(
    new Request("http://x/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...chatBody, stream: true, stream_options: { include_usage: true } }),
    }),
  );
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type")?.includes("text/event-stream"));
  const text = await res.text();
  assert.ok(text.includes("data: [DONE]"));
  const fs = framesOf(text);
  const usageFrame = fs[fs.length - 1];
  const usage = usageFrame.usage as { prompt_tokens: number; completion_tokens: number };
  assert.ok(Array.isArray(usageFrame.choices) && usageFrame.choices.length === 0);
  assert.ok(usage.prompt_tokens > 0);
  assert.ok(usage.completion_tokens > 0);
  for (const s of ledger.snapshot()) assert.equal(s.used.rpd, 0);
});

test("dry-run: still enforces admission control (all models exhausted → 429)", async () => {
  const cfg = makeCfg(CHAT_FLEET, { dry_run: true });
  const { app, ledger } = makeApp(cfg, async () => {
    throw new Error("upstream must not be called in dry-run");
  });
  ledger.markDoneForDay("gem-a");
  ledger.markDoneForDay("gem-b");
  const res = await app.fetch(
    new Request("http://x/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chatBody),
    }),
  );
  assert.equal(res.status, 429);
  assert.ok(res.headers.get("retry-after"));
  const json = (await res.json()) as { error: { code: string } };
  assert.equal(json.error.code, "free_tier_exhausted");
});

test("dry-run: embeddings return a synthetic vector without calling upstream", async () => {
  const cfg = makeCfg(EMB_FLEET, { dry_run: true });
  const { app } = makeApp(cfg, async () => {
    throw new Error("upstream must not be called in dry-run");
  });
  const res = await app.fetch(
    new Request("http://x/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gemini-embedding-1", input: ["alpha", "beta"] }),
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-gfr-dry-run"), "1");
  const json = (await res.json()) as { object: string; data: Array<{ embedding: number[]; index: number }> };
  assert.equal(json.object, "list");
  assert.equal(json.data.length, 2);
  assert.equal(json.data[1].index, 1);
});

// ---------------------------------------------------------------------------
// GET /admin — bug 2 (HTML dashboard missing)
// ---------------------------------------------------------------------------

test("admin: Accept text/html renders the HTML dashboard", async () => {
  const { app } = makeApp(makeCfg(CHAT_FLEET), okFetch());
  const res = await app.fetch(
    new Request("http://x/admin", { headers: { accept: "text/html,application/xhtml+xml" } }),
  );
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type")?.includes("text/html"));
  const html = await res.text();
  assert.ok(html.includes("<!doctype html>"));
  assert.ok(html.includes("gem-a"), "dashboard lists fleet models");
  assert.ok(html.includes("gemini-free-router"));
  assert.ok(html.includes("Last parsed 429s"));
});

test("admin: default Accept returns JSON with learned log", async () => {
  const { app } = makeApp(makeCfg(CHAT_FLEET), okFetch());
  const res = await app.fetch(new Request("http://x/admin"));
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type")?.includes("application/json"));
  const json = (await res.json()) as {
    project: string;
    fleet: unknown[];
    metrics: { requests: number };
    learned: unknown[];
    pt_reset_ms: number;
  };
  assert.equal(json.project, "test");
  assert.equal(json.fleet.length, 2);
  assert.ok(Array.isArray(json.learned));
  assert.ok(json.pt_reset_ms > 0);
});

// ---------------------------------------------------------------------------
// stream_options.include_usage — bug 5 (usage: null in final chunk)
// ---------------------------------------------------------------------------

test("include_usage: final chunk carries real Gemini token counts", async () => {
  const sse = [
    'data: {"candidates":[{"content":{"parts":[{"text":"he"}]}}]}',
    'data: {"candidates":[{"content":{"parts":[{"text":"llo"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"totalTokenCount":7}}',
    "",
  ].join("\n");
  const { app } = makeApp(makeCfg(CHAT_FLEET), async () => new Response(sse, { status: 200 }));

  const res = await app.fetch(
    new Request("http://x/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...chatBody, stream: true, stream_options: { include_usage: true } }),
    }),
  );
  assert.equal(res.status, 200);
  const fs = framesOf(await res.text());

  // Content chunks must be present and marked usage:null (OpenAI wire format).
  const withText = fs.filter((f) => JSON.stringify(f).includes('"content":"he"'));
  assert.equal(withText.length, 1);
  assert.equal(withText[0].usage, null);

  // Trailing usage chunk: empty choices + real numbers, before [DONE].
  const last = fs[fs.length - 1];
  assert.deepEqual(last.choices, []);
  const usage = last.usage as { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  assert.equal(usage.prompt_tokens, 5);
  assert.equal(usage.completion_tokens, 2);
  assert.equal(usage.total_tokens, 7);
});

test("include_usage: absent → no usage fields on content chunks", async () => {
  const sse = [
    'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":1,"totalTokenCount":6}}',
    "",
  ].join("\n");
  const { app, ledger } = makeApp(makeCfg(CHAT_FLEET), async () => new Response(sse, { status: 200 }));
  const res = await app.fetch(
    new Request("http://x/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...chatBody, stream: true }),
    }),
  );
  const fs = framesOf(await res.text());
  for (const f of fs) assert.equal(f.usage, undefined);
  // Commit path must still see the real prompt count (5), not the estimate.
  const totalTpm = ledger.snapshot().reduce((sum, s) => sum + s.used.tpm, 0);
  assert.equal(totalTpm, 5);
});
