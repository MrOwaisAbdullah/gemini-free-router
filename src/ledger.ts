import type { FleetModel, ModelModality, QuotaSignal, ReserveResult } from "./types.ts";
import { matchesModality } from "./types.ts";
import { jitter, msUntilPtMidnight, ptDateKey } from "./time.ts";
import type { PersistStore } from "./storage.ts";

interface ModelState {
  /** RPM sliding window: request timestamps (ms) */
  rpm: number[];
  /** TPM sliding window: {t, n} input-token entries (ms) */
  tpm: Array<{ t: number; n: number }>;
  rpd: number;
  rpdDay: string;
  inFlight: number;
  /** learned limits self-corrected from 429 `limit:` payloads */
  learned: { rpm?: number; rpd?: number; tpm?: number };
  /** configured limits the learned values were derived against — if the user
   *  edits the fleet, a mismatch invalidates stale learned values (config wins). */
  learnedCfg?: { rpm: number; rpd: number; tpm: number };
  doneForDay: boolean;
  /** cool-down after a minute-throttle 429 (ms epoch) */
  coolUntil: number;
  /** rolling quality for fallback re-ranking (SPEC §7.4) */
  quality: QualityStats;
}

/** Rolling success/latency EMA used to break ties between eligible models. */
interface QualityStats {
  emaOk: number;
  emaLatencyMs: number;
  samples: number;
}

export interface QualitySnapshot {
  success: number;
  latency_ms: number;
  samples: number;
}

export interface LedgerSnapshot {
  model: string;
  configured: { rpm: number; rpd: number; tpm: number };
  effective: { rpm: number; rpd: number; tpm: number };
  used: { rpm: number; tpm: number; rpd: number; inFlight: number };
  remaining: { rpm: number; tpm: number; rpd: number };
  doneForDay: boolean;
  msToPtReset: number;
  quality: QualitySnapshot;
}

const RPM_WINDOW_MS = 60_000;
const TPM_WINDOW_MS = 60_000;

/** EMA weight per observation — ~3 observations to move halfway to a verdict. */
const QUALITY_ALPHA = 0.2;
/** Below this many observations we stay neutral (0.5) instead of guessing. */
const QUALITY_MIN_SAMPLES = 3;
/** Latency at which a 100%-successful model scores 0.5 (vs 1.0 at 0ms). */
const QUALITY_LATENCY_REF_MS = 2_000;

const neutralQuality = (): QualityStats => ({ emaOk: 0.5, emaLatencyMs: 0, samples: 0 });

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export class QuotaLedger {
  private states = new Map<string, ModelState>();
  private fleet: FleetModel[];
  private store: PersistStore;
  private pacing: { burn_curve: "even" | "front-loaded" };
  private dirty = false;
  private flushTimer?: ReturnType<typeof setInterval>;

  constructor(fleet: FleetModel[], store: PersistStore, flushEveryMs = 5_000, pacing: { burn_curve: "even" | "front-loaded" } = { burn_curve: "front-loaded" }) {
    this.fleet = fleet;
    this.store = store;
    this.pacing = pacing;
    for (const m of fleet) {
      this.states.set(m.model, {
        rpm: [],
        tpm: [],
        rpd: 0,
        rpdDay: ptDateKey(),
        inFlight: 0,
        learned: {},
        doneForDay: false,
        coolUntil: 0,
        quality: neutralQuality(),
      });
    }
    this.restore();
    if (flushEveryMs > 0) {
      // Jittered (SPEC §7.3) so N routers sharing a disk don't flush in lockstep.
      this.flushTimer = setInterval(() => this.flush(), jitter(flushEveryMs));
      this.flushTimer.unref?.();
    }
  }

  private model(model: string): ModelState | undefined {
    return this.states.get(model);
  }

  private limits(model: FleetModel, s: ModelState) {
    return {
      rpm: s.learned.rpm ?? model.rpm,
      rpd: s.learned.rpd ?? model.rpd,
      tpm: s.learned.tpm ?? model.tpm,
    };
  }

  /** Prune windows and roll the RPD day if PT midnight passed. */
  private tick(s: ModelState, now = Date.now()) {
    const day = ptDateKey(new Date(now));
    if (s.rpdDay !== day) {
      s.rpdDay = day;
      s.rpd = 0;
      s.doneForDay = false;
    }
    const cutoff = now - RPM_WINDOW_MS;
    while (s.rpm.length && s.rpm[0] <= cutoff) s.rpm.shift();
    const tcutoff = now - TPM_WINDOW_MS;
    while (s.tpm.length && s.tpm[0].t <= tcutoff) s.tpm.shift();
  }

  private tpmUsed(s: ModelState): number {
    let sum = 0;
    for (const e of s.tpm) sum += e.n;
    return sum;
  }

  /** Check headroom without reserving. */
  canServe(modelName: string, estTokens: number, now = Date.now()): ReserveResult {
    const m = this.fleet.find((x) => x.model === modelName);
    const s = this.model(modelName);
    if (!m || !s) return { ok: false, reason: "unknown-model" };
    this.tick(s, now);
    const lim = this.limits(m, s);
    if (s.doneForDay) return { ok: false, doneForDay: true, reason: "done-for-day" };
    if (now < s.coolUntil) return { ok: false, waitMs: s.coolUntil - now, reason: "cooldown" };
    if (s.rpd >= lim.rpd) {
      s.doneForDay = true;
      return { ok: false, doneForDay: true, reason: "rpd-exhausted" };
    }
    // Burn curve: "even" spreads RPD across the PT day (stateless, time-based);
    // "front-loaded" (default) allows bursting right up to the RPD limit.
    if (this.pacing.burn_curve === "even") {
      const elapsedMs = 86_400_000 - msUntilPtMidnight(new Date(now));
      const allowed = Math.max(1, Math.ceil((elapsedMs / 86_400_000) * lim.rpd));
      if (s.rpd >= allowed) {
        const msForNext = (s.rpd * 86_400_000) / lim.rpd - elapsedMs;
        return { ok: false, waitMs: Math.max(msForNext, 500), reason: "rpd-hourly-cap" };
      }
    }
    const maxInFlight = Math.max(2, Math.floor(lim.rpm / 2));
    if (s.inFlight >= maxInFlight) {
      return { ok: false, waitMs: 1_000, reason: "in-flight-cap" };
    }
    if (s.rpm.length >= lim.rpm) {
      const waitMs = s.rpm[0] + RPM_WINDOW_MS - now;
      return { ok: false, waitMs: Math.max(waitMs, 100), reason: "rpm" };
    }
    if (this.tpmUsed(s) + estTokens > lim.tpm) {
      const oldest = s.tpm[0];
      const waitMs = oldest ? oldest.t + TPM_WINDOW_MS - now : 1_000;
      return { ok: false, waitMs: Math.max(waitMs, 100), reason: "tpm" };
    }
    return { ok: true };
  }

  /** Atomically reserve quota (pre-increment). */
  reserve(modelName: string, estTokens: number, now = Date.now()): ReserveResult {
    const check = this.canServe(modelName, estTokens, now);
    if (!check.ok) return check;
    const s = this.model(modelName)!;
    s.rpm.push(now);
    s.tpm.push({ t: now, n: estTokens });
    s.rpd += 1;
    s.inFlight += 1;
    this.dirty = true;
    return { ok: true };
  }

  /** Client cancelled before completion — roll back the reservation. */
  release(modelName: string, estTokens: number): void {
    const s = this.model(modelName);
    if (!s) return;
    s.inFlight = Math.max(0, s.inFlight - 1);
    s.rpd = Math.max(0, s.rpd - 1);
    if (s.rpm.length) s.rpm.pop();
    const last = s.tpm[s.tpm.length - 1];
    if (last && last.n === estTokens) s.tpm.pop();
    this.dirty = true;
  }

  /** Successful call: replace estimated input tokens with actual. */
  commit(modelName: string, estTokens: number, actualInputTokens: number): void {
    const s = this.model(modelName);
    if (!s) return;
    s.inFlight = Math.max(0, s.inFlight - 1);
    for (let i = s.tpm.length - 1; i >= 0; i--) {
      if (s.tpm[i].n === estTokens) {
        s.tpm[i].n = actualInputTokens;
        break;
      }
    }
    this.dirty = true;
  }

  /** 429 arrived: undo the reservation (it didn't count as completed usage). */
  unreserve(modelName: string, estTokens: number): void {
    this.release(modelName, estTokens);
  }

  markDoneForDay(modelName: string): void {
    const s = this.model(modelName);
    if (!s) return;
    s.doneForDay = true;
    this.dirty = true;
  }

  /** Minute-throttle: cool the model for retryDelay without burning a slot. */
  setCooldown(modelName: string, ms: number, now = Date.now()): void {
    const s = this.model(modelName);
    if (!s) return;
    s.coolUntil = Math.max(0, now + ms);
    this.dirty = true;
  }

  /**
   * Record an upstream outcome for rolling quality (SPEC §7.4).
   * Call with `ok=false` for upstream 429/5xx/transport failures and
   * `ok=true` for any completed upstream response.
   */
  noteOutcome(modelName: string, ok: boolean, latencyMs: number): void {
    const s = this.model(modelName);
    if (!s || !Number.isFinite(latencyMs)) return;
    const q = s.quality;
    const value = ok ? 1 : 0;
    q.emaOk += QUALITY_ALPHA * (value - q.emaOk);
    q.emaLatencyMs += QUALITY_ALPHA * (Math.max(0, latencyMs) - q.emaLatencyMs);
    q.samples += 1;
    this.dirty = true;
  }

  /**
   * Quality factor in `[0, 1]`; neutral 0.5 until we've seen enough traffic.
   * Rank weight is `remaining * (0.5 + q)` — so an untouched model scores
   * 1.0× its remaining budget (pre-quality behaviour), a perfect model up to
   * 1.5×, and a failing one down to 0.5×. Budget still dominates: quality
   * only re-ranks models with comparable remaining quota.
   */
  private qualityScore(s: ModelState): number {
    if (s.quality.samples < QUALITY_MIN_SAMPLES) return 0.5;
    const latencyFactor = QUALITY_LATENCY_REF_MS / (QUALITY_LATENCY_REF_MS + s.quality.emaLatencyMs);
    return Math.max(0, Math.min(1, s.quality.emaOk * latencyFactor));
  }

  /** Apply self-learned limit from a 429 payload. */
  applySignal(signal: QuotaSignal, modelName?: string): void {
    const name = modelName ?? signal.model;
    if (!name || signal.learnedLimit === undefined) return;
    const s = this.model(name);
    const m = this.fleet.find((x) => x.model === name);
    if (!s || !m) return;
    const lim = signal.learnedLimit;
    if (signal.kind === "daily" && lim !== s.learned.rpd) {
      s.learned.rpd = lim;
      this.dirty = true;
    } else if (signal.kind === "token_minute" && lim !== s.learned.tpm) {
      // `limit:` for token metrics is tokens/min
      s.learned.tpm = lim;
      this.dirty = true;
    } else if (signal.kind === "minute" && lim !== s.learned.rpm) {
      s.learned.rpm = lim;
      this.dirty = true;
    }
    s.learnedCfg = { rpm: m.rpm, rpd: m.rpd, tpm: m.tpm };
    this.dirty = true;
  }

  /** Models with headroom, ordered by remaining RPD desc, re-ranked by rolling quality (SPEC §7.4). */
  candidates(estTokens: number, preferTier?: string, now = Date.now(), modality?: ModelModality): FleetModel[] {
    const eligible = this.fleet.filter(
      (m) => matchesModality(m, modality) && this.canServe(m.model, estTokens, now).ok,
    );
    const rank = (m: FleetModel) => {
      const s = this.model(m.model)!;
      const lim = this.limits(m, s);
      const remaining = Math.max(0, lim.rpd - s.rpd);
      const tierBoost = preferTier && m.tier === preferTier ? 1_000_000 : 0;
      return tierBoost + remaining * (0.5 + this.qualityScore(s));
    };
    return eligible.sort((a, b) => rank(b) - rank(a));
  }

  nextPtResetMs(now = Date.now()): number {
    return msUntilPtMidnight(new Date(now));
  }

  /** Smallest wait across the fleet before some model gains headroom. */
  minWaitMs(estTokens: number, now = Date.now(), modality?: ModelModality): number {
    let min = Number.POSITIVE_INFINITY;
    for (const m of this.fleet) {
      if (!matchesModality(m, modality)) continue;
      const r = this.canServe(m.model, estTokens, now);
      if (r.ok) return 0;
      if (r.doneForDay) continue;
      if (typeof r.waitMs === "number") min = Math.min(min, r.waitMs);
    }
    return Number.isFinite(min) ? min : this.nextPtResetMs(now);
  }

  snapshot(): LedgerSnapshot[] {
    const now = Date.now();
    return this.fleet.map((m) => {
      const s = this.model(m.model)!;
      this.tick(s, now);
      const lim = this.limits(m, s);
      return {
        model: m.model,
        configured: { rpm: m.rpm, rpd: m.rpd, tpm: m.tpm },
        effective: lim,
        used: { rpm: s.rpm.length, tpm: this.tpmUsed(s), rpd: s.rpd, inFlight: s.inFlight },
        remaining: {
          rpm: Math.max(0, lim.rpm - s.rpm.length),
          tpm: Math.max(0, lim.tpm - this.tpmUsed(s)),
          rpd: Math.max(0, lim.rpd - s.rpd),
        },
        doneForDay: s.doneForDay,
        msToPtReset: this.nextPtResetMs(now),
        quality: {
          success: round3(s.quality.emaOk),
          latency_ms: round3(s.quality.emaLatencyMs),
          samples: s.quality.samples,
        },
      };
    });
  }

  flush(): void {
    if (!this.dirty) return;
    const data: Record<string, unknown> = { day: ptDateKey(), models: {} };
    for (const [k, s] of this.states) {
      (data.models as Record<string, unknown>)[k] = { ...s, rpm: [], tpm: [], inFlight: 0 };
    }
    this.store.save(data);
    this.dirty = false;
  }

  private restore(): void {
    const data = this.store.load();
    if (!data || typeof data !== "object") return;
    const day = ptDateKey();
    if (data.day !== day) return; // fresh PT day — start clean
    const models = data.models as Record<string, Partial<ModelState>> | undefined;
    if (!models) return;
    for (const [k, saved] of Object.entries(models)) {
      const s = this.states.get(k);
      if (!s) continue;
      s.rpd = typeof saved.rpd === "number" ? saved.rpd : 0;
      s.rpdDay = typeof saved.rpdDay === "string" ? saved.rpdDay : day;
      s.doneForDay = Boolean(saved.doneForDay);
      // Learned limits only outrank the config while the config is unchanged:
      // if the user edited this model's rpm/rpd/tpm since the values were
      // learned, drop them so the new numbers take effect immediately.
      const m = this.fleet.find((x) => x.model === k);
      const cfgNow = m ? { rpm: m.rpm, rpd: m.rpd, tpm: m.tpm } : undefined;
      const savedCfg = saved.learnedCfg;
      const stale =
        savedCfg &&
        cfgNow &&
        (savedCfg.rpm !== cfgNow.rpm || savedCfg.rpd !== cfgNow.rpd || savedCfg.tpm !== cfgNow.tpm);
      if (stale) {
        s.learned = {};
        this.dirty = true;
      } else {
        s.learned = saved.learned ?? {};
      }
      // Pre-marker ledger files: adopt the current config as the baseline so
      // the *next* config edit invalidates them too.
      s.learnedCfg = cfgNow;
      const q = saved.quality;
      if (q && typeof q === "object" && typeof q.samples === "number" && q.samples > 0) {
        s.quality = {
          emaOk: typeof q.emaOk === "number" ? q.emaOk : 0.5,
          emaLatencyMs: typeof q.emaLatencyMs === "number" ? q.emaLatencyMs : 0,
          samples: Math.floor(q.samples),
        };
      }
    }
  }

  close(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flush();
    this.store.close();
  }
}
