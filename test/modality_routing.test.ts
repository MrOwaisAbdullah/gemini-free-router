import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createApp } from "../src/server.ts";
import { QuotaLedger } from "../src/ledger.ts";
import { JsonStore } from "../src/storage.ts";
import { acquire } from "../src/scheduler.ts";
import { DEFAULT_FLEET } from "../src/config.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FleetModel, RouterConfig } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Modality routing — live-smoke finding (dev-log §1.17): chat traffic was
// scheduled onto gemini-embedding-001 because embedding models carry the
// fleet's largest budgets and nothing filtered them out of chat candidates.
// ---------------------------------------------------------------------------

// Deliberately skewed: the embeddings model dwarfs every chat budget, so an
// unfiltered ranking would pick it first on every request.
const MIXED_FLEET: FleetModel[] = [
  { model: "emb-huge", rpm: 1000, rpd: 100_000, tpm: 1_000_000, tier: "bulk", modality: "embeddings" },
  { model: "chat-a", rpm: 5, rpd: 10, tpm: 100_000, tier: "scarce" },
  { model: "chat-b", rpm: 5, rpd: 8, tpm: 100_000, tier: "bulk" },
];

function makeCfg(fleet: FleetModel[], extra: Partial<RouterConfig> = {}): RouterConfig {
  return {
    project: "test",
    listen: { host: "127.0.0.1", port: 0 },
    gemini: { base_url: "https://example.invalid/v1beta", api_key_env: "GEMINI_API_KEY" },
    fleet,
    pacing: { max_queue_wait_s: 0, burn_curve: "even", max_in_flight_per_model: "auto" },
    fallback: { strategy: "remaining-budget" },
    learning: { auto_apply: false },
    modalities: ["chat"],
    ledger_path: join(mkdtempSync(join(tmpdir(), "gfr-mod-")), "l.json"),
    dry_run: false,
    ...extra,
  };
}

function makeLedger(fleet: FleetModel[]): QuotaLedger {
  const dir = mkdtempSync(join(tmpdir(), "gfr-mod-"));
  return new QuotaLedger(fleet, new JsonStore(join(dir, "l.json")), 0);
}

test("candidates(): modality filter separates chat from embeddings", () => {
  const ledger = makeLedger(MIXED_FLEET);
  const all = ledger.candidates(100);
  assert.deepEqual(all.map((m) => m.model).sort(), ["chat-a", "chat-b", "emb-huge"]);

  const chat = ledger.candidates(100, undefined, Date.now(), "chat");
  assert.deepEqual(chat.map((m) => m.model).sort(), ["chat-a", "chat-b"]);

  const emb = ledger.candidates(100, undefined, Date.now(), "embeddings");
  assert.deepEqual(emb.map((m) => m.model), ["emb-huge"]);
});

test("acquire(): modality chat never reserves the (larger) embeddings model", async () => {
  const ledger = makeLedger(MIXED_FLEET);
  const acq = await acquire(ledger, 100, { maxWaitMs: 0, modality: "chat" });
  assert.ok(acq && "pick" in acq, "expected a pick");
  assert.ok(acq.pick.model.startsWith("chat-"), `picked ${acq.pick.model}`);
});

test("acquire(): explicit preferred embeddings model is ignored for chat", async () => {
  const ledger = makeLedger(MIXED_FLEET);
  const acq = await acquire(ledger, 100, {
    maxWaitMs: 0,
    modality: "chat",
    preferredModel: "emb-huge",
  });
  assert.ok(acq && "pick" in acq, "expected a pick");
  assert.notEqual(acq.pick.model, "emb-huge");
});

const GEMINI_OK = JSON.stringify({
  candidates: [{ content: { parts: [{ text: "pong" }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2, totalTokenCount: 9 },
});

test("chat endpoint: upstream URL targets a chat model, never the embeddings model", async () => {
  const cfg = makeCfg(MIXED_FLEET);
  const dir = mkdtempSync(join(tmpdir(), "gfr-mod-"));
  const ledger = new QuotaLedger(cfg.fleet, new JsonStore(join(dir, "l.json")), 0, cfg.pacing);
  const seen: string[] = [];
  const { app } = createApp({
    cfg,
    apiKey: "k",
    ledger,
    fetchImpl: async (url) => {
      seen.push(String(url));
      return new Response(GEMINI_OK, { status: 200 });
    },
  });
  const res = await app.fetch(
    new Request("http://x/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  assert.ok(seen[0].includes("chat-"), `upstream url: ${seen[0]}`);
  assert.ok(!seen[0].includes("emb-huge"), `upstream url: ${seen[0]}`);
  const json = (await res.json()) as { model: string };
  assert.ok(json.model.startsWith("chat-"), `served model: ${json.model}`);
});

test("chat endpoint: explicit request for the embeddings model falls back to chat", async () => {
  const cfg = makeCfg(MIXED_FLEET);
  const dir = mkdtempSync(join(tmpdir(), "gfr-mod-"));
  const ledger = new QuotaLedger(cfg.fleet, new JsonStore(join(dir, "l.json")), 0, cfg.pacing);
  const seen: string[] = [];
  const { app } = createApp({
    cfg,
    apiKey: "k",
    ledger,
    fetchImpl: async (url) => {
      seen.push(String(url));
      return new Response(GEMINI_OK, { status: 200 });
    },
  });
  const res = await app.fetch(
    new Request("http://x/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "emb-huge", messages: [{ role: "user", content: "hi" }] }),
    }),
  );
  assert.equal(res.status, 200);
  assert.ok(!seen[0].includes("emb-huge"), `upstream url: ${seen[0]}`);
  const json = (await res.json()) as { model: string };
  assert.notEqual(json.model, "emb-huge");
});

test("dry-run chat: picks a chat model, not the embeddings model", async () => {
  const cfg = makeCfg(MIXED_FLEET, { dry_run: true });
  const dir = mkdtempSync(join(tmpdir(), "gfr-mod-"));
  const ledger = new QuotaLedger(cfg.fleet, new JsonStore(join(dir, "l.json")), 0, cfg.pacing);
  const { app } = createApp({ cfg, apiKey: "k", ledger });
  const res = await app.fetch(
    new Request("http://x/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
    }),
  );
  assert.equal(res.status, 200);
  const json = (await res.json()) as { model: string };
  assert.ok(json.model.startsWith("chat-"), `dry-run model: ${json.model}`);
});

// ---------------------------------------------------------------------------
// DEFAULT_FLEET ground truth — every shipped model id must exist in Google's
// live model list (test/fixtures/api-models-2026-10-13.json). This is the
// regression guard for the two wrong ids found by the real-key smoke test
// (dev-log §1.17).
// ---------------------------------------------------------------------------

test("DEFAULT_FLEET: every id exists in Google's API with the right method", () => {
  const raw = JSON.parse(
    readFileSync(new URL("./fixtures/api-models-2026-10-13.json", import.meta.url), "utf8"),
  ) as { models: Array<{ name: string; methods: string[] }> };
  assert.ok(raw.models.length >= 50, "fixture looks truncated");
  const byName = new Map(raw.models.map((m) => [m.name, m.methods]));
  for (const m of DEFAULT_FLEET) {
    const methods = byName.get(`models/${m.model}`);
    assert.ok(methods, `fleet model ${m.model} missing from Google's model list`);
    const need = m.modality === "embeddings" ? "embedContent" : "generateContent";
    assert.ok(
      methods.includes(need),
      `${m.model} lacks ${need}; methods: ${methods.join(", ")}`,
    );
  }
});

test("DEFAULT_FLEET: chat fleet contains no embeddings models", () => {
  const chatModels = DEFAULT_FLEET.filter((m) => (m.modality ?? "chat") === "chat");
  assert.ok(chatModels.length >= 5);
  assert.equal(DEFAULT_FLEET.length, chatModels.length + DEFAULT_FLEET.filter((m) => m.modality === "embeddings").length);
  for (const m of DEFAULT_FLEET.filter((x) => x.modality === "embeddings")) {
    assert.equal(m.modality, "embeddings");
  }
});
