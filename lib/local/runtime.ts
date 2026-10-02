import "server-only";
import { closeDatabase } from "@/lib/database/client";
import { writePending, type PendingOp } from "@/lib/local/ops";

/** True when started by the WHITE-LOTUS launcher (which can restart the app and apply operations). */
export const underLauncher = () => process.env.WHITE_LOTUS_LAUNCHER === "1";

/**
 * Schedule an operation that needs the database closed (move / restore / wipe / restart): record it, let the
 * response reach the browser, then close the database and exit. The launcher applies it and starts again.
 */
export function requestRestart(op: PendingOp) {
  writePending(op);
  setTimeout(() => {
    closeDatabase()
      .catch(() => {})
      .finally(() => process.exit(0));
  }, 400);
}
