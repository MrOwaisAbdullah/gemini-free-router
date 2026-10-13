import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classify429 } from "../src/forensics.ts";

/**
 * Golden 429 corpus (SPEC §249): real captured payloads — day, minute,
 * TPM-per-minute, ambiguous, `retryDelay: 0s`, missing `details` — driven by
 * `429-corpus.json`. Every classifier change must pass this net; add a fixture
 * + manifest entry rather than writing a bespoke assertion.
 */
const dir = fileURLToPath(new URL("./fixtures/", import.meta.url));
const manifest = JSON.parse(readFileSync(`${dir}429-corpus.json`, "utf8")) as Record<
  string,
  Record<string, unknown>
>;

test("golden 429 corpus: every fixture is covered (no orphan, no phantom entries)", () => {
  const files = readdirSync(dir)
    .filter((f) => f.startsWith("429-") && f.endsWith(".json") && f !== "429-corpus.json")
    .sort();
  assert.deepEqual(Object.keys(manifest).sort(), files);
  assert.ok(files.length >= 6, `expected ≥6 fixtures, found ${files.length}`);
});

for (const [name, expected] of Object.entries(manifest)) {
  test(`golden 429 corpus: ${name} → ${expected.kind}`, () => {
    const body: unknown = JSON.parse(readFileSync(`${dir}${name}`, "utf8"));
    const s = classify429(body);
    assert.equal(s.kind, expected.kind, `kind for ${name}`);
    for (const key of ["quotaId", "quotaMetric", "model"] as const) {
      if (expected[key] !== undefined) {
        assert.equal(s[key], expected[key], `${key} for ${name}`);
      }
    }
    if (expected.learnedLimit !== undefined) {
      assert.equal(s.learnedLimit, expected.learnedLimit, `learnedLimit for ${name}`);
    }
    if (expected.minRetryDelayMs !== undefined) {
      const min = expected.minRetryDelayMs as number;
      assert.ok((s.retryDelayMs ?? 0) >= min, `retryDelayMs ${s.retryDelayMs} < ${min} for ${name}`);
    }
  });
}

test("classifier never throws on adversarial payloads", () => {
  const bodies: unknown[] = [
    null,
    undefined,
    429,
    "RESOURCE_EXHAUSTED",
    [],
    { error: null },
    { error: { details: "not-an-array", message: 42 } },
    { error: { details: [{ "@type": "RetryInfo", retryDelay: "soon" }], message: "retry in NaNs" } },
    { error: { details: [{ "@type": "QuotaFailure", violations: [{}] }], message: "" } },
  ];
  for (const b of bodies) {
    const s = classify429(b);
    assert.ok(["daily", "minute", "token_minute", "unknown"].includes(s.kind));
    assert.ok((s.retryDelayMs ?? 0) >= 5_000, `floor violated for ${JSON.stringify(b)}`);
  }
});
