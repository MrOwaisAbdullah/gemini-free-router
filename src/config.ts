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
  if (env.GFR_LEARN === "1" || env.GFR_LEARN === "true") cfg.learning.auto_apply = true;
  if (env.GFR_DRY_RUN === "1" || env.GFR_DRY_RUN === "true") cfg.dry_run = true;
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
