import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";

export interface PersistStore {
  load(): Record<string, unknown> | null;
  save(data: Record<string, unknown>): void;
  close(): void;
}

const req = createRequire(import.meta.url);

/** Write-behind JSON store: atomic rename, debounced by caller. */
export class JsonStore implements PersistStore {
  private path: string;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
  }
  load(): Record<string, unknown> | null {
    if (!existsSync(this.path)) return null;
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  save(data: Record<string, unknown>): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, this.path);
  }
  close(): void {}
}

/** Volatile in-memory store — used by simulators so dry runs never touch disk. */
export class MemoryStore implements PersistStore {
  private data: Record<string, unknown> | null = null;
  load(): Record<string, unknown> | null {
    return this.data;
  }
  save(data: Record<string, unknown>): void {
    this.data = data;
  }
  close(): void {}
}

interface SqliteDb {
  run(sql: string, ...params: unknown[]): unknown;
  query(sql: string): { get(...params: unknown[]): unknown };
}

/**
 * SQLite store (WAL). Uses bun:sqlite or node:sqlite when available;
 * otherwise callers should fall back to JsonStore.
 */
export class SqliteStore implements PersistStore {
  private db: SqliteDb;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    let DatabaseCtor: (new (p: string) => SqliteDb) | undefined;
    try {
      DatabaseCtor = req("bun:sqlite").Database;
    } catch {
      try {
        DatabaseCtor = req("node:sqlite").DatabaseSync;
      } catch {
        throw new Error("no-sqlite-runtime");
      }
    }
    if (!DatabaseCtor) throw new Error("no-sqlite-runtime");
    this.db = new DatabaseCtor(path);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  }

  load(): Record<string, unknown> | null {
    const row = this.db.query("SELECT v FROM kv WHERE k = 'ledger'").get() as { v: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.v) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  save(data: Record<string, unknown>): void {
    this.db.run(
      "INSERT INTO kv (k, v) VALUES ('ledger', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      JSON.stringify(data),
    );
  }

  close(): void {}
}

/** Pick the best store for this runtime. */
export function openStore(path: string): PersistStore {
  if (path.endsWith(".sqlite") || path.endsWith(".db")) {
    try {
      return new SqliteStore(path);
    } catch {
      // fall through to JSON on the same path minus suffix
    }
  }
  const jsonPath =
    path.endsWith(".sqlite") || path.endsWith(".db") ? path.replace(/\.(sqlite|db)$/, ".json") : path;
  return new JsonStore(jsonPath);
}
