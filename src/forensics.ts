import type { QuotaSignal } from "./types.ts";

const MIN_RETRY_FLOOR_MS = 5_000;
const DAILY_RETRY_THRESHOLD_MS = 3_600_000;

/** Parse "36.429760048s" / "38s" / "45" into milliseconds. */
export function parseRetryDelay(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.max(0, raw * 1000);
  if (typeof raw !== "string") return undefined;
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)s?$/);
  if (!m) return undefined;
  return Math.max(0, parseFloat(m[1]) * 1000);
}

interface QuotaViolation {
  quotaId?: string;
  quotaMetric?: string;
  quotaDimensions?: { model?: string; location?: string };
  quotaValue?: string | number;
}

/**
 * Classify a Gemini 429. Never trust quotaId alone (OmniRoute#9504 class of
 * bugs): cross-check quotaMetric + retryDelay + the `limit:` text in message.
 */
export function classify429(body: unknown): QuotaSignal {
  const signal: QuotaSignal = { kind: "unknown", retryDelayMs: MIN_RETRY_FLOOR_MS };
  if (typeof body !== "object" || body === null) return signal;

  const err = (body as { error?: Record<string, unknown> }).error ?? (body as Record<string, unknown>);
  const details = Array.isArray((err as { details?: unknown }).details)
    ? ((err as { details: unknown[] }).details)
    : [];

  let retryDelayMs: number | undefined;
  let violation: QuotaViolation | undefined;

  for (const d of details) {
    if (typeof d !== "object" || d === null) continue;
    const det = d as { "@type"?: string; violations?: QuotaViolation[]; retryDelay?: unknown };
    if (det["@type"]?.includes("RetryInfo")) {
      retryDelayMs = parseRetryDelay(det.retryDelay);
    }
    if (det["@type"]?.includes("QuotaFailure") && Array.isArray(det.violations)) {
      violation = det.violations[0];
    }
  }

  const message = typeof (err as { message?: unknown }).message === "string"
    ? (err as { message: string }).message
    : "";

  const limitMatch = message.match(/limit:\s*(\d+)/i);
  const modelMatch = message.match(/model:\s*([\w.-]+)/i);
  if (limitMatch) signal.learnedLimit = parseInt(limitMatch[1], 10);
  if (modelMatch) signal.model = modelMatch[1];

  const msgRetry = message.match(/retry in\s+([\d.]+)\s*s/i);
  if (retryDelayMs === undefined && msgRetry) {
    retryDelayMs = parseFloat(msgRetry[1]) * 1000;
  }

  signal.quotaId = violation?.quotaId;
  signal.quotaMetric = violation?.quotaMetric;
  if (violation?.quotaDimensions?.model && !signal.model) {
    signal.model = violation.quotaDimensions.model;
  }

  const quotaId = signal.quotaId ?? "";
  // `quotaMetric` can also appear only inside the message text — Google omits
  // the whole `details` array on some 429s (the "missing details" fixture).
  const metric = signal.quotaMetric ?? message.match(/metric:\s*([\w./-]+)/i)?.[1] ?? "";
  if (metric) signal.quotaMetric = metric;

  const idSaysDay = /PerDay/i.test(quotaId);
  const idSaysMinute = /PerMinute/i.test(quotaId);
  const idSaysTokens = /Token/i.test(quotaId);
  const metricSaysTokens = /input_token_count|tokens/i.test(metric);
  const metricSaysRequests = /_requests$|free_tier_requests/i.test(metric);

  // Family (tokens vs requests): quotaMetric wins over quotaId when they
  // disagree (SPEC §130); the metric is only skipped when it says nothing
  // about the family. Day/minute is a sub-question of the requests family.
  const familyFromMetric = metricSaysTokens ? "tokens" : metricSaysRequests ? "requests" : null;
  const familyFromId = idSaysTokens ? "tokens" : idSaysDay || idSaysMinute ? "requests" : null;
  const family = familyFromMetric ?? familyFromId;

  const messageHours = /retry in\s+[\d.]+\s*h(?:ou)?r/i.test(message);
  const delay = retryDelayMs ?? -1;

  if (family === "tokens") {
    signal.kind = "token_minute";
  } else if (family === "requests") {
    signal.kind = idSaysDay || messageHours || delay >= DAILY_RETRY_THRESHOLD_MS ? "daily" : "minute";
  } else if (delay >= DAILY_RETRY_THRESHOLD_MS || messageHours) {
    signal.kind = "daily";
  } else if (retryDelayMs !== undefined) {
    // No quota family at all, but Google told us when to come back → bounded
    // throttle. Covers `retryDelay: 0s` too (floored to 5s below: never spin).
    signal.kind = "minute";
  }
  // else: genuinely ambiguous (no metric, no quotaId, no delay) → stays
  // "unknown"; the server applies a capped, jittered exponential backoff.

  signal.retryDelayMs = Math.max(retryDelayMs ?? MIN_RETRY_FLOOR_MS, MIN_RETRY_FLOOR_MS);
  return signal;
}
