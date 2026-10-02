/**
 * Optional manual command for the online edition: apply the embedded database migrations to DATABASE_URL and exit.
 * Not needed for deployment — the app migrates itself at start-up (lib/database/cloud-migrate.ts).
 */
import { ensureCloudMigrated } from "../../lib/database/cloud-migrate";

ensureCloudMigrated()
  .then(() => console.log(process.env.DATABASE_URL ? "Database is up to date." : "DATABASE_URL is not set — nothing to do (local edition)."))
  .catch((e) => {
    console.error("Migration failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
