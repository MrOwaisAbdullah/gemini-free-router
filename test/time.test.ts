import { test } from "node:test";
import assert from "node:assert/strict";
import { ptDateKey, msUntilPtMidnight } from "../src/time.ts";

test("ptDateKey uses Pacific calendar day, not local/UTC", () => {
  // 2026-07-01 06:00 UTC = 2026-06-30 23:00 PDT → still June 30 in PT
  const d = new Date("2026-07-01T06:00:00Z");
  assert.equal(ptDateKey(d), "2026-06-30");
  // 2026-07-01 08:00 UTC = 2026-07-01 01:00 PDT
  assert.equal(ptDateKey(new Date("2026-07-01T08:00:00Z")), "2026-07-01");
});

test("winter (PST) boundary too", () => {
  // 2026-01-01 07:00 UTC = 2025-12-31 23:00 PST
  assert.equal(ptDateKey(new Date("2026-01-01T07:00:00Z")), "2025-12-31");
  assert.equal(ptDateKey(new Date("2026-01-01T08:30:00Z")), "2026-01-01");
});

test("msUntilPtMidnight: ~0 at 23:59:59 PT, ~24h at exactly midnight, ~12h at noon", () => {
  const almostMidnight = new Date("2026-07-01T06:59:59.000Z"); // 23:59:59 PDT
  assert.ok(msUntilPtMidnight(almostMidnight) < 2000);
  const atMidnight = new Date("2026-07-01T07:00:00.000Z"); // 00:00 PDT
  const fromMidnight = msUntilPtMidnight(atMidnight);
  assert.ok(fromMidnight > 23.9 * 3600_000 && fromMidnight <= 24 * 3600_000);
  const atNoon = new Date("2026-07-01T19:00:00.000Z"); // 12:00 PDT
  const remaining = msUntilPtMidnight(atNoon);
  assert.ok(remaining > 11.9 * 3600_000 && remaining < 12.1 * 3600_000);
});
