import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { loadConfig, apiKey } from "./config.ts";
import { createApp } from "./server.ts";
import { configureKeepAlive } from "./pool.ts";
import { createLogger, parseLogLevel } from "./log.ts";

const { values } = parseArgs({
  options: {
    config: { type: "string", short: "c" },
    port: { type: "string" },
    host: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  strict: false,
});

if (values.help) {
  console.log(`gemini-free-router — single-key Gemini free-tier quota router

Usage:
  npx gemini-free-router [--config router.yaml] [--port 8787] [--host 127.0.0.1]

Env:
  GEMINI_API_KEY   (required) your Gemini API key
  GFR_TOKEN        optional bearer auth for the proxy
  GFR_LEDGER       ledger path (default ./data/ledger.sqlite)
  GFR_LEARN=1      auto-apply limits learned from 429 payloads
  GFR_LOG          structured JSON log level: debug|info|warn|error|off
  GFR_DRY_RUN=1    admission control only — never calls upstream
  GFR_POOL_CONNECTIONS / GFR_POOL_KEEPALIVE_MS  upstream keep-alive pool

Point any OpenAI client at http://HOST:PORT/v1`);
  process.exit(0);
}

const cfg = loadConfig(values.config as string | undefined);
if (typeof values.port === "string") cfg.listen.port = parseInt(values.port, 10);
if (typeof values.host === "string") cfg.listen.host = values.host;

// Human banner stays on stdout; everything else is JSON lines on stderr.
const log = createLogger({ level: parseLogLevel(process.env.GFR_LOG, "info") });
// One warm connection pool toward Google (SPEC §7.6) — set before any fetch.
configureKeepAlive();

const key = apiKey(cfg);
const { app, ledger } = createApp({ cfg, apiKey: key, logger: log });

serve({ fetch: app.fetch, port: cfg.listen.port, hostname: cfg.listen.host }, (info) => {
  log.log("listening", {
    address: info.address,
    port: info.port,
    project: cfg.project,
    models: cfg.fleet.length,
    dry_run: cfg.dry_run,
  });
  console.log(
    `gemini-free-router listening on http://${info.address}:${info.port} (project=${cfg.project}, fleet=${cfg.fleet.length} models)`,
  );
  console.log(`  openai base_url: http://${info.address}:${info.port}/v1`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    ledger.close();
    process.exit(0);
  });
}
