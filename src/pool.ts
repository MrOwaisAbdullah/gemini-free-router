/**
 * Keep-alive connection pool toward Google (SPEC §7.6 / §135 / §241).
 *
 * Node's global `fetch` resolves its dispatcher from
 * `globalThis[Symbol.for("undici.globalDispatcher.1")]`, which is the same
 * well-known symbol the `undici` package writes — so installing an Agent here
 * genuinely reuses sockets for every upstream call without threading a
 * `dispatcher` through each `fetch` invocation.
 */
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import type { Dispatcher } from "undici";

export interface PoolOptions {
  /** Max concurrent sockets per origin. Free-tier RPM tops out around 100. */
  connections?: number;
  /** Idle socket lifetime before undici closes it. */
  keepAliveTimeoutMs?: number;
  /** TCP connect timeout toward Google. */
  connectTimeoutMs?: number;
}

export const DEFAULT_POOL: Required<PoolOptions> = {
  connections: 16,
  keepAliveTimeoutMs: 30_000,
  connectTimeoutMs: 10_000,
};

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Install (or replace) the global dispatcher. Idempotent. */
export function configureKeepAlive(opts: PoolOptions = {}): Dispatcher {
  const connections = opts.connections ?? envInt("GFR_POOL_CONNECTIONS") ?? DEFAULT_POOL.connections;
  const keepAliveTimeoutMs =
    opts.keepAliveTimeoutMs ?? envInt("GFR_POOL_KEEPALIVE_MS") ?? DEFAULT_POOL.keepAliveTimeoutMs;
  const connectTimeoutMs =
    opts.connectTimeoutMs ?? envInt("GFR_POOL_CONNECT_MS") ?? DEFAULT_POOL.connectTimeoutMs;

  const agent = new Agent({
    connections,
    keepAliveTimeout: keepAliveTimeoutMs,
    keepAliveMaxTimeout: keepAliveTimeoutMs,
    pipelining: 1, // never pipeline POSTs — generations are long-lived and ordered
    connect: { timeout: connectTimeoutMs },
    allowH2: false,
  });
  setGlobalDispatcher(agent);
  return agent;
}

export function currentDispatcher(): Dispatcher {
  return getGlobalDispatcher();
}
