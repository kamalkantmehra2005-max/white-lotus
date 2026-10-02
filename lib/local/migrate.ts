/** Apply database migrations to the local database (run by the launcher before the app starts). */
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { acquireDataLock, releaseDataLock } from "./lock";
import { dataPaths, ensureDataDirs } from "./paths";

export async function migrateLocal(opts: { appRoot?: string; root?: string } = {}) {
  const p = ensureDataDirs(opts.root);
  acquireDataLock(opts.root);
  const pg = new PGlite(dataPaths(p.root).db);
  try {
    await migrate(drizzle(pg), { migrationsFolder: path.join(opts.appRoot ?? process.cwd(), "drizzle") });
  } finally {
    await pg.close();
    releaseDataLock(opts.root);
  }
}
