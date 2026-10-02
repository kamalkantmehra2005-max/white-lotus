/**
 * Runs once when the local server starts (Node runtime only).
 *  • Housekeeping every 6 hours, on this computer: expired guests, stale quarantine files, old sessions,
 *    optional file retention (FILE_RETENTION_DAYS). Replaces the cloud cron job.
 *  • Closes the embedded database cleanly on shutdown so nothing is left half-written.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { isCloud } = await import("@/lib/edition");
  if (isCloud()) {
    // Online edition: bring the hosted database up to date before the first request. Nothing else to do here —
    // serverless functions have no long-lived process and no local files to tidy.
    const { ensureCloudMigrated } = await import("@/lib/database/cloud-migrate");
    await ensureCloudMigrated().catch((e) => console.error("[white-lotus] database migration failed at start-up (will retry on the next request):", e instanceof Error ? e.message : e));
    return;
  }
  const { runRetention } = await import("@/lib/files/retention");
  const { closeDatabase } = await import("@/lib/database/client");
  const tick = () => runRetention().catch(() => {});
  setTimeout(tick, 60_000).unref();
  setInterval(tick, 6 * 3_600_000).unref();
  const shutdown = () => {
    closeDatabase()
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
