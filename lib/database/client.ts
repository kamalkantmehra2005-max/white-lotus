import "server-only";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sslFor } from "./cloud-migrate";
import { acquireDataLock, releaseDataLock } from "@/lib/local/lock";
import { dataPaths, ensureDataDirs } from "@/lib/local/paths";
import * as schema from "./schema";

/**
 * Local-only database. WHITE-LOTUS uses PGlite — PostgreSQL compiled to WebAssembly, running inside the app
 * process and storing its files in <data folder>/db. There is no database server, no network port and no
 * cloud database: the data lives in your chosen folder on this computer.
 *
 * WHITE_LOTUS_DB=memory runs an in-memory database (tests only — nothing is kept).
 *
 * Online edition (DATABASE_URL set, e.g. Neon): a hosted PostgreSQL holds ONLY accounts, sessions, limits and the
 * end-to-end encrypted sync copies of signed-in users' data (the server can't read them). Same schema, same queries.
 */
type DB = PgliteDatabase<typeof schema>;
const globalForDb = globalThis as unknown as { __wlPg?: PGlite; __wlDb?: DB; __wlSql?: ReturnType<typeof postgres> };

const remoteUrl = () => (process.env.WHITE_LOTUS_DB === "memory" ? "" : process.env.DATABASE_URL || "");

export function databaseLocation(): string {
  return process.env.WHITE_LOTUS_DB === "memory" ? "memory://" : dataPaths().db;
}

function create(): DB {
  const url = remoteUrl();
  if (url) {
    // Serverless-friendly: a small pool, prepared statements off (works with Neon/pgbouncer poolers).
    globalForDb.__wlSql ??= postgres(url, { max: Number(process.env.DATABASE_POOL_MAX || 3), prepare: false, idle_timeout: 20, ssl: sslFor(url) });
    // The query builder API is identical for both drivers.
    return drizzlePg(globalForDb.__wlSql, { schema, casing: "snake_case" }) as unknown as DB;
  }
  if (!globalForDb.__wlPg && process.env.WHITE_LOTUS_DB !== "memory") {
    ensureDataDirs();
    acquireDataLock(); // one process at a time (e.g. don't run CLI commands while the app is open)
  }
  const client = globalForDb.__wlPg ?? new PGlite(databaseLocation());
  globalForDb.__wlPg = client;
  return drizzle(client, { schema, casing: "snake_case" });
}

/** The real Drizzle instance (created on first use so builds don't open the database). */
export function getDb(): DB {
  globalForDb.__wlDb ??= create();
  return globalForDb.__wlDb;
}

export function getPglite(): PGlite {
  getDb();
  return globalForDb.__wlPg!;
}

export const db: DB = new Proxy({} as DB, {
  get(_t, key) {
    return Reflect.get(getDb(), key);
  },
});

/** Rows from a raw `db.execute(sql\`…\`)` (PGlite returns `{ rows }`). */
export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] })?.rows ?? []) as T[];
}

export async function pingDatabase(): Promise<boolean> {
  try {
    if (remoteUrl()) {
      getDb();
      await globalForDb.__wlSql!`select 1`;
      return true;
    }
    await getPglite().query("select 1");
    return true;
  } catch {
    return false;
  }
}

/** Close the database (backup/restore/shutdown). The next query reopens it. */
export async function closeDatabase() {
  if (globalForDb.__wlSql) {
    const c = globalForDb.__wlSql;
    globalForDb.__wlSql = undefined;
    globalForDb.__wlDb = undefined;
    await c.end({ timeout: 5 }).catch(() => {});
    return;
  }
  const pg = globalForDb.__wlPg;
  globalForDb.__wlPg = undefined;
  globalForDb.__wlDb = undefined;
  if (pg && !pg.closed) await pg.close();
  releaseDataLock();
}

export { schema };
