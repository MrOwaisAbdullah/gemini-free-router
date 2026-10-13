import type { FleetModel, ModelModality, ReserveResult } from "./types.ts";
import type { QuotaLedger } from "./ledger.ts";
import { jitter } from "./time.ts";

export interface ScheduledPick {
  model: FleetModel;
}

export interface AcquireOpts {
  maxWaitMs: number;
  preferTier?: string;
  preferredModel?: string;
  /**
   * Restrict scheduling to one modality (chat traffic must never land on an
   * embedding model — they carry the fleet's largest budgets and would win
   * every unfiltered ranking). Omit for "all models".
   */
  modality?: ModelModality;
  /**
   * Models the caller already tried (failed upstreams). A failover hop must
   * never be handed the model it just failed on.
   */
  exclude?: readonly string[];
  signal?: AbortSignal;
  /**
   * Virtual clock (ms epoch). Omit for wall-clock behaviour. Used by
   * `/admin/simulate`, which advances simulated time instead of sleeping.
   */
  now?: number;
}

/**
 * Wait for a model to gain headroom (bounded), then reserve.
 * Returns null when the wait budget is exhausted — caller should fall back.
 */
export async function acquire(
  ledger: QuotaLedger,
  estTokens: number,
  opts: AcquireOpts,
): Promise<{ pick: FleetModel; reserve: ReserveResult } | { waitExhausted: true; last: ReserveResult } | null> {
  const clock = (): number => opts.now ?? Date.now();
  const deadline = clock() + opts.maxWaitMs;
  const excluded = new Set(opts.exclude ?? []);

  // Fast path: preferred model if it has headroom. Membership is checked
  // *before* reserving so a modality-filtered miss can't leak a reservation.
  if (opts.preferredModel) {
    const m = ledger
      .candidates(estTokens, undefined, clock(), opts.modality)
      .find((x) => x.model === opts.preferredModel && !excluded.has(x.model));
    if (m) {
      const r = ledger.reserve(opts.preferredModel, estTokens, clock());
      if (r.ok) return { pick: m, reserve: r };
    }
  }

  let last!: ReserveResult;
  for (;;) {
    if (opts.signal?.aborted) return null;
    const candidates = ledger
      .candidates(estTokens, opts.preferTier, clock(), opts.modality)
      .filter((x) => !excluded.has(x.model));
    if (candidates.length) {
      const r = ledger.reserve(candidates[0].model, estTokens, clock());
      if (r.ok) return { pick: candidates[0], reserve: r };
      last = r;
    } else {
      last = { ok: false, reason: "no-headroom" };
    }
    if (clock() >= deadline) break;
    // Sleep until the tightest window opens (capped at a 250ms poll, jittered
    // so N queued clients don't wake in lockstep and re-race). Never sleep
    // past the caller's deadline.
    const budget = deadline - clock();
    const cap = Math.min(ledger.minWaitMs(estTokens, clock(), opts.modality) || 250, 250, budget);
    const waitMs = Math.min(jitter(cap), budget);
    if (waitMs <= 0) break;
    await sleep(waitMs, opts.signal);
  }
  return { waitExhausted: true, last };
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
