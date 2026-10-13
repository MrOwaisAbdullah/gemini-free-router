import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { FleetModel, RouterConfig } from "./types.ts";

/** Default chat fleet from the SPEC §4 table (AI Studio project, captured 2026-10-12). */
export const DEFAULT_FLEET: FleetModel[] = [
  { model: "gemini-3.1-flash-lite", rpm: 15, rpd: 500, tpm: 250_000, tier: "bulk", alias: "fast" },
  { model: "gemini-3.5-flash-lite", rpm: 15, rpd: 500, tpm: 250_000, tier: "bulk" },
  { model: "gemini-2.5-flash-lite", rpm: 10, rpd: 20, tpm: 250_000, tier: "bulk" },
  { model: "gemini-2.5-flash", rpm: 5, rpd: 20, tpm: 250_000, tier: "standard" },
  { model: "gemini-3-flash", rpm: 5, rpd: 20, tpm: 250_000, tier: "standard" },
  { model: "gemini-3.5-flash", rpm: 5, rpd: 20, tpm: 250_000, tier: "scarce" },
  { model: "gemini-3.6-flash", rpm: 5, rpd: 20, tpm: 250_000, tier: "scarce" },
  { model: "gemini-3.7-flash", rpm: 5, rpd: 20, tpm: 250_000, tier: "scarce" },
  { model: "gemini-3.8-flash", rpm: 5, rpd: 20, tpm: 250_000, tier: "scarce" },
  // Embeddings (SPEC §5: 100 RPM / 30K TPM / 1K RPD each)
  { model: "gemini-embedding-1", rpm: 100, rpd: 1000, tpm: 30_000, tier: "bulk", modality: "embeddings", alias: "embed" },
  { model: "gemini-embedding-2", rpm: 100, rpd: 1000, tpm: 30_000, tier: "bulk", modality: "embeddings" },
];

export const DEFAULT_CONFIG: RouterConfig = {
  project: "single",
  listen: { host: "127.0.0.1", port: 8787 },
  gemini: {
    base_url: "https://generativelanguage.googleapis.com/v1beta",
    api_key_env: "GEMINI_API_KEY",
  },
  fleet: DEFAULT_FLEET,
  fleet_mode: "replace",
  disabled: [],
  pacing: { max_queue_wait_s: 30, burn_curve: "even", max_in_flight_per_model: "auto" },
  fallback: { strategy: "remaining-budget" },
  learning: { auto_apply: false },
  modalities: ["chat"],
  ledger_path: "./data/ledger.sqlite",
  dry_run: false,
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function merge<T>(base: T, over: DeepPartial<T> | undefined): T {
  if (!over) return base;
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    const bv = (base as Record<string, unknown>)[k];
    if (v && typeof v === "object" && !Array.isArray(v) && bv && typeof bv === "object" && !Array.isArray(bv)) {
      out[k] = merge(bv, v as DeepPartial<Record<string, unknown>>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

const FLEET_TIERS = new Set(["bulk", "standard", "scarce"]);
const FLEET_MODALITIES = new Set(["chat", "embeddings"]);

/**
 * `fleet_mode: merge` — overlay config-file fleet entries onto the built-in
 * defaults by model id: listed ids override only the fields they provide,
 * unknown ids (brand-new models) are appended.
 */
function mergeFleet(base: FleetModel[], patch: FleetModel[]): FleetModel[] {
  const out = base.map((m) => ({ ...m }));
  const byId = new Map(out.map((m) => [m.model, m]));
  for (const p of patch) {
    const cur = p && typeof p.model === "string" ? byId.get(p.model) : undefined;
    if (!cur) {
      out.push(p);
      if (p && typeof p.model === "string") byId.set(p.model, p);
      continue;
    }
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined || v === null) continue;
      (cur as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

/** Fail fast at boot with an actionable message — a typo'd fleet must not run. */
function validateFleet(fleet: FleetModel[]): void {
  if (!Array.isArray(fleet) || fleet.length === 0) {
    throw new Error('fleet: no models configured (check the "fleet" and "disabled" entries in your config)');
  }
  const seen = new Set<string>();
  fleet.forEach((m, i) => {
    if (!m || typeof m !== "object" || typeof m.model !== "string" || !m.model.trim()) {
      throw new Error(`fleet[${i}]: a non-empty "model" id is required`);
    }
    const label = `"${m.model}"`;
    if (seen.has(m.model)) throw new Error(`fleet: duplicate model id ${label}`);
    seen.add(m.model);
    for (const key of ["rpm", "rpd", "tpm"] as const) {
      const v = m[key];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        throw new Error(`fleet entry ${label}: ${key} must be a number >= 0 (got ${JSON.stringify(v)})`);
      }
    }
    if (!FLEET_TIERS.has(m.tier)) {
      throw new Error(`fleet entry ${label}: tier must be bulk|standard|scarce (got ${JSON.stringify(m.tier)})`);
    }
    if (m.modality !== undefined && !FLEET_MODALITIES.has(m.modality)) {
      throw new Error(`fleet entry ${label}: modality must be chat|embeddings (got ${JSON.stringify(m.modality)})`);
    }
    if (m.alias !== undefined && typeof m.alias !== "string") {
      throw new Error(`fleet entry ${label}: alias must be a string`);
    }
  });
}

export function loadConfig(path?: string, env: NodeJS.ProcessEnv = process.env): RouterConfig {
  let fileCfg: DeepPartial<RouterConfig> = {};
  if (path && existsSync(path)) {
    const raw = readFileSync(path, "utf8");
    fileCfg = (path.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw)) as DeepPartial<RouterConfig>;
  }
  const cfg = merge(DEFAULT_CONFIG, fileCfg);

  if (env.GFR_HOST) cfg.listen.host = env.GFR_HOST;
  if (env.GFR_PORT) cfg.listen.port = parseInt(env.GFR_PORT, 10);
  if (env.GFR_LEDGER) cfg.ledger_path = env.GFR_LEDGER;
  if (env.GFR_TOKEN) cfg.auth = { token: env.GFR_TOKEN };
  if (env.GFR_MAX_QUEUE_WAIT_S) cfg.pacing.max_queue_wait_s = parseInt(env.GFR_MAX_QUEUE_WAIT_S, 10);
  if (env.GFR_BURN_CURVE === "even" || env.GFR_BURN_CURVE === "front-loaded") {
    cfg.pacing.burn_curve = env.GFR_BURN_CURVE;
  }
  if (env.GFR_LEARN === "1" || env.GFR_LEARN === "true") cfg.learning.auto_apply = true;
  if (env.GFR_DRY_RUN === "1" || env.GFR_DRY_RUN === "true") cfg.dry_run = true;

  // Fleet maintenance: resolve fleet_mode → apply disabled → validate.
  if (cfg.fleet_mode !== "replace" && cfg.fleet_mode !== "merge") {
    throw new Error(`fleet_mode must be "replace" or "merge" (got ${JSON.stringify(cfg.fleet_mode)})`);
  }
  if (cfg.fleet_mode === "merge") cfg.fleet = mergeFleet(DEFAULT_CONFIG.fleet, cfg.fleet);
  const disabled = cfg.disabled ?? [];
  if (!Array.isArray(disabled) || disabled.some((d) => typeof d !== "string")) {
    throw new Error('disabled must be a list of model ids, e.g. disabled: ["gemini-2.5-flash-lite"]');
  }
  if (disabled.length) {
    const drop = new Set(disabled);
    cfg.fleet = cfg.fleet.filter((m) => m && !drop.has(m.model));
  }
  validateFleet(cfg.fleet);
  return cfg;
}

export function apiKey(cfg: RouterConfig, env: NodeJS.ProcessEnv = process.env): string {
  const k = env[cfg.gemini.api_key_env] ?? env.GEMINI_API_KEY ?? "";
  if (!k) {
    throw new Error(
      `Missing Gemini API key: set ${cfg.gemini.api_key_env} (or GEMINI_API_KEY)`,
    );
  }
  return k;
}
