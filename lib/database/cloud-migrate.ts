/**
 * Online edition: bring the hosted database up to date at start-up, from the migrations embedded in
 * lib/database/migrations.generated.ts. Nothing is read from disk and nothing runs at build time, so a deployment
 * can't fail because a script file went missing. Safe to call many times and from many server instances at once:
 * a Postgres advisory lock makes them take turns, and a database that is already up to date costs one SELECT.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import type { PgDialect, PgSession } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { MIGRATIONS } from "./migrations.generated";

const LOCK = 727002;
let inFlight: Promise<void> | undefined;

/** TLS as the connection string asks for it (sslmode=disable | require | verify-full); hosted databases need TLS. */
export function sslFor(url: string): false | "require" | "verify-full" {
  if (/sslmode=disable/.test(url) || /@(localhost|127\.0\.0\.1)[:/]/.test(url)) return false;
  return /sslmode=verify-full/.test(url) ? "verify-full" : "require";
}

export function cloudDatabaseUrl(): string | null {
  if (process.env.WHITE_LOTUS_DB === "memory") return null;
  return process.env.DATABASE_URL || null;
}

/** Resolves when the hosted database has every migration applied. No-op for the local edition. */
export function ensureCloudMigrated(): Promise<void> {
  const url = cloudDatabaseUrl();
  if (!url) return Promise.resolve();
  inFlight ??= run(url).catch((e) => {
    inFlight = undefined; // let the next request try again (e.g. the database was still waking up)
    throw e;
  });
  return inFlight;
}

async function run(url: string) {
  const sql = postgres(url, { max: 1, prepare: false, ssl: sslFor(url), onnotice: () => {}, connect_timeout: 30 });
  try {
    await sql`select pg_advisory_lock(${LOCK})`;
    try {
      const db = drizzle(sql) as unknown as { dialect: PgDialect; session: PgSession };
      await db.dialect.migrate(MIGRATIONS, db.session, { migrationsFolder: "embedded" });
    } finally {
      await sql`select pg_advisory_unlock(${LOCK})`;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}
