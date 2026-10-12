import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classify429, parseRetryDelay } from "../src/forensics.ts";

const fix = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"));

test("parseRetryDelay handles decimal seconds and bare numbers", () => {
  assert.equal(parseRetryDelay("36.429760048s"), 36429.760048);
  assert.equal(parseRetryDelay("38s"), 38000);
  assert.equal(parseRetryDelay("0s"), 0);
  assert.equal(parseRetryDelay(undefined), undefined);
});

test("daily 429 (quotaId PerDay + retryDelay 36s) classifies as daily, learns limit", () => {
  const s = classify429(fix("429-daily.json"));
  assert.equal(s.kind, "daily");
  assert.equal(s.quotaId, "GenerateRequestsPerDayPerProjectPerModel-FreeTier");
  assert.equal(s.learnedLimit, 20);
  assert.equal(s.model, "gemini-3.6-flash");
  assert.ok(s.retryDelayMs >= 36000);
});

test("minute 429 classifies as minute, not daily (OmniRoute#9504 regression)", () => {
  const s = classify429(fix("429-minute.json"));
  assert.equal(s.kind, "minute");
  assert.equal(s.learnedLimit, 15);
  assert.equal(s.model, "gemini-3.5-flash-lite");
});

test("token-per-minute 429 classifies as token_minute", () => {
  const s = classify429(fix("429-token-minute.json"));
  assert.equal(s.kind, "token_minute");
  assert.equal(s.learnedLimit, 250000);
});

test("retryDelay 0s is floored to 5s (never spin)", () => {
  const s = classify429(fix("429-bare-retry0.json"));
  assert.ok(s.retryDelayMs >= 5000);
});

test("garbage bodies do not throw", () => {
  assert.equal(classify429(null).kind, "unknown");
  assert.equal(classify429("nope").kind, "unknown");
  assert.equal(classify429({}).kind, "unknown");
});
