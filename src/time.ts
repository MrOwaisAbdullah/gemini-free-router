const PT = "America/Los_Angeles";

const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: PT,
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Pacific-time calendar date key, e.g. "2026-10-12" (RPD resets on this boundary). */
export function ptDateKey(d: Date = new Date()): string {
  const p = partsFmt.formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Milliseconds until next midnight Pacific (handles PDT/PST via Intl). */
export function msUntilPtMidnight(d: Date = new Date()): number {
  const p = partsFmt.formatToParts(d);
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  const secondsOfDay = get("hour") * 3600 + get("minute") * 60 + get("second");
  const fracMs = d.getMilliseconds();
  return (86_400 - secondsOfDay) * 1000 - fracMs;
}

/**
 * Jitter a delay into `[ms * (1 - spread), ms * (1 + spread)]` (SPEC §7.3:
 * "jitter all timers to avoid synchronized retry storms").
 *
 * Deliberately *not* applied to Google's own `retryDelay` — the README promises
 * that one is honored exactly. Used for router-owned timers only: queue polls,
 * the ledger flush tick, and the ambiguous-429 backoff.
 */
export function jitter(ms: number, spread = 0.2, rand: () => number = Math.random): number {
  if (ms <= 0) return ms;
  return Math.round(ms * (1 - spread + rand() * spread * 2));
}

/**
 * Capped exponential backoff for ambiguous 429s (SPEC §130: "capped
 * exponential backoff (1s–60s, jittered)"). `attempt` is 1-based, so the first
 * backoff is ~1s and it saturates at 60s from attempt 7 on.
 */
export function ambiguousBackoff(attempt: number, rand: () => number = Math.random): number {
  const n = Math.min(Math.max(Math.floor(attempt), 1) - 1, 6); // 0..6 → 1s..64s
  return Math.min(60_000, jitter(1_000 * 2 ** n, 0.2, rand));
}

