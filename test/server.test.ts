import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.ts";
import { JsonStore } from "../src/storage.ts";
import { QuotaLedger } from "../src/ledger.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouterConfig } from "../src/types.ts";

const cfg: RouterConfig = {
  project: "test",
  listen: { host: "127.0.0.1", port: 0 },
  gemini: { base_url: "https://example.invalid/v1beta", api_key_env: "GEMINI_API_KEY" },
  fleet: [
    { model: "gem-a", rpm: 10, rpd: 50, tpm: 100_000, tier: "bulk" },
    { model: "gem-b", rpm: 10, rpd: 5, tpm: 100_000, tier: "scarce" },
  ],
  pacing: { max_queue_wait_s: 0, burn_curve: "even", max_in_flight_per_model: "auto" },
  fallback: { strategy: "remaining-budget" },
  dry_run: false,
  learning: { auto_apply: true },
  modalities: ["chat"],
  ledger_path: join(mkdtempSync(join(tmpdir(), "gfr-int-")), "l.json"),
};

function makeApp(fetchImpl: typeof fetch) {
  const dir = mkdtempSync(join(tmpdir(), "gfr-int-"));
  const ledger = new QuotaLedger(cfg.fleet, new JsonStore(join(dir, "l.json")), 0);
  return createApp({ cfg, apiKey: "test-key", ledger, fetchImpl });
}

const chatBody = {
  model: "auto",
  messages: [{ role: "user", content: "hi" }],
};

test("non-streaming chat round-trip via stubbed Gemini", async () => {
  const { app } = makeApp(async (url) => {
    assert.ok(String(url).includes("generateContent"));
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: "pong" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2, totalTokenCount: 9 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  const res = await app.fetch(
    new Request("http://x/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chatBody),
    }),
  );
  assert.equal(res.status, 200);
  const json = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage: { prompt_tokens: number };
    model: string;
  };
  assert.equal(json.choices[0].message.content, "pong");
  assert.equal(json.usage.prompt_tokens, 7);
  assert.equal(json.model, "gem-a"); // highest remaining RPD
});

test("429 daily on first model falls back to second model", async () => {
  const calls: string[] = [];
  const { app } = makeApp(async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("gem-a")) {
      return new Response(
        JSON.stringify({
          error: {
            code: 429,
            message: "quota\n\nQuota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 50, model: gem-a\nPlease retry in 3600s.",
            status: "RESOURCE_EXHAUSTED",
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.QuotaFailure",
                violations: [
                  {
                    quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
                    quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
                    quotaDimensions: { model: "gem-a" },
                  },
                ],
              },
              { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "3600s" },
            ],
          },
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: "ok-b" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 1, totalTokenCount: 8 },
      }),
      { status: 200 },
    );
  });
  const res = await app.fetch(
    new Request("http://x/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chatBody),
    }),
  );
  assert.equal(res.status, 200);
  const json = (await res.json()) as { choices: Array<{ message: { content: string } }>; model: string };
  assert.equal(json.choices[0].message.content, "ok-b");
  assert.equal(json.model, "gem-b");
  assert.equal(calls.length, 2);
});

test("streaming translates Gemini SSE to OpenAI chunks", async () => {
  const nd = [
    'data: {"candidates":[{"content":{"parts":[{"text":"he"}]}}]}',
    'data: {"candidates":[{"content":{"parts":[{"text":"llo"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"totalTokenCount":7}}',
  ].join("\n");
  const { app } = makeApp(async () => new Response(nd + "\n", { status: 200 }));
  const res = await app.fetch(
    new Request("http://x/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...chatBody, stream: true }),
    }),
  );
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type")?.includes("text/event-stream"));
  const text = await res.text();
  assert.ok(text.includes('"content":"he"'));
  assert.ok(text.includes('"content":"llo"'));
  assert.ok(text.includes("data: [DONE]"));
});

test("all-exhausted returns OpenAI-shaped 429 with Retry-After", async () => {
  const { app, ledger } = makeApp(async () => new Response("never", { status: 200 }));
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
  const json = (await res.json()) as { error: { type: string; code: string } };
  assert.equal(json.error.type, "rate_limit_error");
  assert.equal(json.error.code, "free_tier_exhausted");
});

test("/v1/models and /healthz and /metrics", async () => {
  const { app } = makeApp(async () => new Response("{}", { status: 200 }));
  const health = await app.fetch(new Request("http://x/healthz"));
  assert.equal(health.status, 200);
  const models = (await (await app.fetch(new Request("http://x/v1/models"))).json()) as {
    data: Array<{ id: string }>;
  };
  assert.equal(models.data.length, 2);
  const metrics = await app.fetch(new Request("http://x/metrics"));
  assert.equal(metrics.status, 200);
  assert.ok((await metrics.text()).includes("gfr_requests_total"));
});
