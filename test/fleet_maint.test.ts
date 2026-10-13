import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, DEFAULT_FLEET } from "../src/config.ts";
import { QuotaLedger } from "../src/ledger.ts";
import { MemoryStore } from "../src/storage.ts";
import { ptDateKey } from "../src/time.ts";
import type { FleetModel, QuotaSignal } from "../src/types.ts";

const dir = mkdtempSync(join(tmpdir(), "gfr-fleet-"));
let n = 0;
function cfgFile(yaml: string): string {
  const p = join(dir, `c${n++}.yaml`);
  writeFileSync(p, yaml);
  return p;
}

test("fleet: no config file → built-in defaults, replace mode, nothing disabled", () => {
  const cfg = loadConfig(undefined, {});
  assert.equal(cfg.fleet.length, DEFAULT_FLEET.length);
  assert.equal(cfg.fleet_mode, "replace");
  assert.deepEqual(cfg.disabled, []);
});

test("fleet: replace mode (default) — config fleet is the entire fleet", () => {
  const cfg = loadConfig(
    cfgFile("fleet:\n  - { model: gemini-x, rpm: 5, rpd: 20, tpm: 1000, tier: bulk }\n"),
    {},
  );
  assert.equal(cfg.fleet.length, 1);
  assert.equal(cfg.fleet[0].model, "gemini-x");
});

test("fleet: merge mode overrides only the fields given, keeps the rest", () => {
  const cfg = loadConfig(
    cfgFile("fleet_mode: merge\nfleet:\n  - { model: gemini-2.5-flash, rpm: 8 }\n"),
    {},
  );
  assert.equal(cfg.fleet.length, DEFAULT_FLEET.length);
  const m = cfg.fleet.find((x) => x.model === "gemini-2.5-flash");
  assert.ok(m, "default model still present");
  const def = DEFAULT_FLEET.find((x) => x.model === "gemini-2.5-flash")!;
  assert.equal(m.rpm, 8);
  assert.equal(m.rpd, def.rpd);
  assert.equal(m.tpm, def.tpm);
  assert.equal(m.tier, def.tier);
});

test("fleet: merge mode appends brand-new models", () => {
  const cfg = loadConfig(
    cfgFile("fleet_mode: merge\nfleet:\n  - { model: gemini-99-flash, rpm: 4, rpd: 30, tpm: 100000, tier: scarce }\n"),
    {},
  );
  assert.equal(cfg.fleet.length, DEFAULT_FLEET.length + 1);
  const added = cfg.fleet.find((x) => x.model === "gemini-99-flash");
  assert.deepEqual(added, { model: "gemini-99-flash", rpm: 4, rpd: 30, tpm: 100000, tier: "scarce" });
});

test("fleet: disabled drops deprecated models in merge and replace modes", () => {
  const merged = loadConfig(
    cfgFile('fleet_mode: merge\ndisabled: ["gemini-2.5-flash-lite"]\nfleet:\n  - { model: gemini-2.5-flash, rpm: 8 }\n'),
    {},
  );
  assert.equal(merged.fleet.length, DEFAULT_FLEET.length - 1);
  assert.ok(!merged.fleet.some((m) => m.model === "gemini-2.5-flash-lite"));
  assert.equal(merged.fleet.find((m) => m.model === "gemini-2.5-flash")!.rpm, 8);

  const replaced = loadConfig(
    cfgFile(
      'disabled: ["gemini-a"]\nfleet:\n  - { model: gemini-a, rpm: 5, rpd: 20, tpm: 1000, tier: bulk }\n  - { model: gemini-b, rpm: 5, rpd: 20, tpm: 1000, tier: bulk }\n',
    ),
    {},
  );
  assert.equal(replaced.fleet.length, 1);
  assert.equal(replaced.fleet[0].model, "gemini-b");
});

test("fleet: empty after disabled → actionable boot error", () => {
  const all = JSON.stringify(DEFAULT_FLEET.map((m) => m.model));
  assert.throws(() => loadConfig(cfgFile(`fleet_mode: merge\ndisabled: ${all}\n`), {}), /no models configured/);
});

test("fleet: invalid fleet_mode → error naming the allowed values", () => {
  assert.throws(() => loadConfig(cfgFile("fleet_mode: mrege\n"), {}), /fleet_mode must be "replace" or "merge"/);
});

test("fleet: validation catches bad limits, tiers, duplicates, incomplete new models", () => {
  assert.throws(
    () => loadConfig(cfgFile('fleet:\n  - { model: gemini-x, rpm: "fast", rpd: 20, tpm: 1000, tier: bulk }\n'), {}),
    /"gemini-x": rpm must be a number/,
  );
  assert.throws(
    () => loadConfig(cfgFile('fleet_mode: merge\nfleet:\n  - { model: gemini-new }\n'), {}),
    /"gemini-new": rpm must be a number/,
  );
  assert.throws(
    () =>
      loadConfig(
        cfgFile('fleet:\n  - { model: dup, rpm: 1, rpd: 1, tpm: 1, tier: bulk }\n  - { model: dup, rpm: 1, rpd: 1, tpm: 1, tier: bulk }\n'),
        {},
      ),
    /duplicate model id "dup"/,
  );
  assert.throws(() => loadConfig(cfgFile("disabled: gemini-x\n"), {}), /disabled must be a list/);
});

test("fleet: shipped router.example.yaml stays valid", () => {
  const cfg = loadConfig("router.example.yaml", {});
  assert.ok(cfg.fleet.length >= 1);
});

const fleetOf = (rpd: number): FleetModel[] => [{ model: "m1", rpm: 5, rpd, tpm: 1000, tier: "bulk" }];
const dailySignal = (limit: number): QuotaSignal => ({ kind: "daily", learnedLimit: limit, model: "m1", retryDelayMs: 36_000 });

test("learned limits survive a restart while the config is unchanged", () => {
  const store = new MemoryStore();
  const l1 = new QuotaLedger(fleetOf(20), store, 0);
  l1.applySignal(dailySignal(17), "m1");
  l1.flush();
  const l2 = new QuotaLedger(fleetOf(20), store, 0);
  assert.equal(l2.snapshot()[0].effective.rpd, 17);
});

test("editing configured limits invalidates stale learned limits (config wins)", () => {
  const store = new MemoryStore();
  const l1 = new QuotaLedger(fleetOf(20), store, 0);
  l1.applySignal(dailySignal(17), "m1");
  l1.flush();
  // user retunes rpd 20 → 50 in the config and restarts
  const l2 = new QuotaLedger(fleetOf(50), store, 0);
  const snap = l2.snapshot()[0];
  assert.equal(snap.configured.rpd, 50);
  assert.equal(snap.effective.rpd, 50);
});

test("legacy ledger file without a learnedCfg marker keeps learned limits", () => {
  const store = new MemoryStore();
  store.save({ day: ptDateKey(), models: { m1: { rpd: 5, rpdDay: ptDateKey(), learned: { rpd: 17 } } } });
  const l = new QuotaLedger(fleetOf(20), store, 0);
  assert.equal(l.snapshot()[0].effective.rpd, 17);
});
