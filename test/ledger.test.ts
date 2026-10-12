import { test } from "node:test";
import assert from "node:assert/strict";
import { QuotaLedger } from "../src/ledger.ts";
import { JsonStore } from "../src/storage.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FleetModel } from "../src/types.ts";

const fleet: FleetModel[] = [
  { model: "bulk-model", rpm: 5, rpd: 10, tpm: 1000, tier: "bulk" },
  { model: "scarce-model", rpm: 2, rpd: 3, tpm: 500, tier: "scarce" },
  { model: "daily-model", rpm: 100, rpd: 3, tpm: 10_000, tier: "standard" },
];

function mkLedger() {
  const dir = mkdtempSync(join(tmpdir(), "gfr-"));
  return new QuotaLedger(fleet, new JsonStore(join(dir, "l.json")), 0);
}

test("reserve/commit within limits; refuses past RPD with doneForDay", () => {
  const l = mkLedger();
  for (let i = 0; i < 3; i++) {
    assert.equal(l.reserve("daily-model", 50).ok, true, `req ${i}`);
    l.commit("daily-model", 50, 48);
  }
  const r = l.reserve("daily-model", 50);
  assert.equal(r.ok, false);
  assert.equal(r.doneForDay, true);
  l.close();
});

test("RPM window blocks burst and reports waitMs", () => {
  const l = mkLedger();
  for (let i = 0; i < 5; i++) {
    assert.equal(l.reserve("bulk-model", 10).ok, true, `burst ${i}`);
    l.commit("bulk-model", 10, 10);
  }
  const r = l.reserve("bulk-model", 10);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "rpm");
  assert.ok((r.waitMs ?? 0) > 0);
  l.close();
});

test("concurrent reserve cannot double-spend (single-threaded async interleaving)", async () => {
  const l = mkLedger();
  const results = await Promise.all(
    Array.from({ length: 30 }, () =>
      (async () => {
        const r = l.reserve("scarce-model", 10);
        if (r.ok) {
          await new Promise((res) => setTimeout(res, 0));
          l.commit("scarce-model", 10, 10);
        }
        return r.ok;
      })(),
    ),
  );
  // scarce-model rpm=2 — the sliding window is the binding constraint.
  assert.equal(results.filter(Boolean).length, 2);
  l.close();
});

test("TPM window enforced; release rolls back", () => {
  const l = mkLedger();
  assert.equal(l.reserve("bulk-model", 900).ok, true);
  const r = l.reserve("bulk-model", 200); // 1100 > 1000
  assert.equal(r.ok, false);
  assert.equal(r.reason, "tpm");
  l.release("bulk-model", 900);
  assert.equal(l.reserve("bulk-model", 200).ok, true);
  l.close();
});

test("done-for-day sticks until PT day rolls (simulate via markDoneForDay)", () => {
  const l = mkLedger();
  l.markDoneForDay("scarce-model");
  const r = l.canServe("scarce-model", 10);
  assert.equal(r.ok, false);
  assert.equal(r.doneForDay, true);
  l.close();
});

test("cooldown from minute 429 blocks then frees", () => {
  const l = mkLedger();
  l.setCooldown("bulk-model", 1000);
  const blocked = l.canServe("bulk-model", 10);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "cooldown");
  l.setCooldown("bulk-model", -5000, Date.now()); // past
  assert.equal(l.canServe("bulk-model", 10).ok, true);
  l.close();
});

test("applySignal learns rpm/rpd/tpm from forensics signals", () => {
  const l = mkLedger();
  l.applySignal({ kind: "minute", learnedLimit: 7, model: "bulk-model", retryDelayMs: 1000 });
  l.applySignal({ kind: "daily", learnedLimit: 42, model: "bulk-model", retryDelayMs: 3_600_000 });
  const snap = l.snapshot().find((s) => s.model === "bulk-model")!;
  assert.equal(snap.effective.rpm, 7);
  assert.equal(snap.effective.rpd, 42);
  l.close();
});

test("candidates ordered by remaining RPD (remaining-budget)", () => {
  const l = mkLedger();
  l.reserve("scarce-model", 1);
  const c = l.candidates(1);
  assert.equal(c[0].model, "bulk-model"); // 10 remaining vs 2
  l.close();
});

test("flush + restore same PT day keeps RPD count", () => {
  const dir = mkdtempSync(join(tmpdir(), "gfr-"));
  const path = join(dir, "l.json");
  const l1 = new QuotaLedger(fleet, new JsonStore(path), 0);
  l1.reserve("bulk-model", 10);
  l1.commit("bulk-model", 10, 10);
  l1.close();
  const l2 = new QuotaLedger(fleet, new JsonStore(path), 0);
  const snap = l2.snapshot().find((s) => s.model === "bulk-model")!;
  assert.equal(snap.used.rpd, 1);
  l2.close();
});
