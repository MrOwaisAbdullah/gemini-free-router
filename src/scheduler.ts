import type { FleetModel, ReserveResult } from "./types.ts";
import type { QuotaLedger } from "./ledger.ts";

export interface ScheduledPick {
  model: FleetModel;
}

/**
 * Wait for a model to gain headroom (bounded), then reserve.
 * Returns null when the wait budget is exhausted — caller should fall back.
 */
export async function acquire(
  ledger: QuotaLedger,
  estTokens: number,
  opts: { maxWaitMs: number; preferTier?: string; preferredModel?: string; signal?: AbortSignal },
): Promise<{ pick: FleetModel; reserve: ReserveResult } | { waitExhausted: true; last: ReserveResult } | null> {
  const deadline = Date.now() + opts.maxWaitMs;

  // Fast path: preferred model if it has headroom.
  if (opts.preferredModel) {
    const r = ledger.reserve(opts.preferredModel, estTokens);
    if (r.ok) {
      const m = ledger.candidates(estTokens).find((x) => x.model === opts.preferredModel);
      if (m) return { pick: m, reserve: r };
    }
  }

  let last!: ReserveResult;
  for (;;) {
    if (opts.signal?.aborted) return null;
    const candidates = ledger.candidates(estTokens, opts.preferTier);
    if (candidates.length) {
      const r = ledger.reserve(candidates[0].model, estTokens);
      if (r.ok) return { pick: candidates[0], reserve: r };
      last = r;
    } else {
      last = { ok: false, reason: "no-headroom" };
    }
    if (Date.now() >= deadline) break;
    // Sleep until the tightest window opens (capped at 250ms poll).
    const waitMs = Math.min(ledger.minWaitMs(estTokens) || 250, 250, deadline - Date.now());
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
