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

/**
 * Normalized handle over the runtime's sqlite. bun:sqlite and node:sqlite
 * expose different APIs (node:sqlite has no `db.run()` — bare statements go
 * through `exec`, parameterised ones through `prepare().run()`), so the
 * store only talks to this shape.
 */
interface SqliteHandle {
  run(sql: string, ...params: unknown[]): void;
  get(sql: string): unknown;
  close(): void;
}

function openSqlite(path: string): SqliteHandle {
  try {
    const { Database } = req("bun:sqlite") as {
      Database: new (p: string) => {
        run(sql: string, ...params: unknown[]): unknown;
        query(sql: string): { get(...params: unknown[]): unknown };
        close(): void;
      };
    };
    const db = new Database(path);
    return {
      run: (sql, ...params) => void db.run(sql, ...params),
      get: (sql) => db.query(sql).get(),
      close: () => db.close(),
    };
  } catch {
    /* not Bun — try node:sqlite */
  }
  try {
    const { DatabaseSync } = req("node:sqlite") as {
      DatabaseSync: new (p: string) => {
        exec(sql: string): void;
        prepare(sql: string): { run(...params: unknown[]): unknown; get(): unknown };
        close(): void;
      };
    };
    const db = new DatabaseSync(path);
    return {
      run: (sql, ...params) => {
        if (params.length === 0) db.exec(sql);
        else db.prepare(sql).run(...params);
      },
      get: (sql) => db.prepare(sql).get(),
      close: () => db.close(),
    };
  } catch {
    throw new Error("no-sqlite-runtime");
  }
}

/**
 * SQLite store (WAL). Uses bun:sqlite or node:sqlite when available;
 * otherwise callers should fall back to JsonStore.
 */
export class SqliteStore implements PersistStore {
  private db: SqliteHandle;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = openSqlite(path);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  }

  load(): Record<string, unknown> | null {
    const row = this.db.get("SELECT v FROM kv WHERE k = 'ledger'") as { v: string } | undefined;
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

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
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
