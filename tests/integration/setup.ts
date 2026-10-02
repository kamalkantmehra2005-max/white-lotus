// Integration tests run against the real embedded database (PGlite, in memory) with all migrations applied.
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll } from "vitest";

process.env.WHITE_LOTUS_DB = "memory";
process.env.WHITE_LOTUS_DATA_DIR ??= mkdtempSync(path.join(os.tmpdir(), "wl-int-data-"));
process.env.WHITE_LOTUS_CONFIG_DIR ??= mkdtempSync(path.join(os.tmpdir(), "wl-int-config-"));

beforeAll(async () => {
  const { getDb } = await import("@/lib/database/client");
  await migrate(getDb(), { migrationsFolder: path.resolve(__dirname, "../../drizzle") });
});
