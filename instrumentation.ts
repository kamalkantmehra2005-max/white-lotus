/**
 * Runs once when the server starts (Node runtime only).
 *  • Online edition: brings the hosted database up to date before the first request.
 *  • Local edition: housekeeping every 6 hours and a clean database close on shutdown (lib/local/runtime.node.ts).
 * Everything is imported dynamically so the Edge bundle (proxy.ts) never sees Node-only APIs.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { isCloud } = await import("@/lib/edition");
  if (isCloud()) {
    const { ensureCloudMigrated } = await import("@/lib/database/cloud-migrate");
    await ensureCloudMigrated().catch((e) => console.error("[white-lotus] database migration failed at start-up (will retry on the next request):", e instanceof Error ? e.message : e));
    return;
  }
  const { startLocalRuntime } = await import("@/lib/local/runtime.node");
  await startLocalRuntime();
}
