/**
 * Local edition only, Node runtime only (imported dynamically so no Node API ends up in the Edge bundle):
 * housekeeping every 6 hours and a clean database close on shutdown.
 */
export async function startLocalRuntime() {
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
