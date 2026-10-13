/**
 * Structured JSON-line logging (SPEC §7.8 / §141).
 *
 * One JSON object per line on stderr — greppable, splunkable, and it keeps
 * stdout clean for the human-facing startup banner.
 *
 * Level comes from `GFR_LOG` (`debug|info|warn|error|off`), default `warn`.
 * `src/cli.ts` promotes the default to `info` for production starts, so tests
 * that build apps directly stay quiet unless they ask for logs.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "off";
export type LogSeverity = Exclude<LogLevel, "off">;

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, off: 100 };

export interface Logger {
  readonly level: LogLevel;
  /** Emit one structured event. No-op when `severity` is below `level`. */
  log(event: string, fields?: Record<string, unknown>, severity?: LogSeverity): void;
}

export function parseLogLevel(raw: string | undefined, fallback: LogLevel = "warn"): LogLevel {
  if (raw === undefined || raw === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "none" || v === "silent") return "off";
  return v === "debug" || v === "info" || v === "warn" || v === "error" || v === "off" ? v : fallback;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Defaults to a single stderr write per event. */
  sink?: (line: string) => void;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? parseLogLevel(process.env.GFR_LOG);
  const threshold = RANK[level];
  const sink = opts.sink ?? ((line: string) => process.stderr.write(`${line}\n`));
  const now = opts.now ?? (() => new Date());

  return {
    level,
    log(event, fields, severity = "info") {
      if (RANK[severity] < threshold) return;
      const record: Record<string, unknown> = { ts: now().toISOString(), level: severity, event };
      if (fields) {
        for (const [k, v] of Object.entries(fields)) {
          if (v !== undefined) record[k] = v;
        }
      }
      try {
        sink(JSON.stringify(record));
      } catch {
        // Never let logging (cycles, BigInt, …) take down a request.
        sink(JSON.stringify({ ts: now().toISOString(), level: severity, event, log_error: "unserializable_fields" }));
      }
    },
  };
}

/** Swallows everything — the default for tests that don't assert on logs. */
export const silentLogger: Logger = createLogger({ level: "off", sink: () => {} });
