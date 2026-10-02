import "server-only";
import { requireUser, type SessionUser } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { ensureCloudMigrated } from "@/lib/database/cloud-migrate";
import { isCloud } from "@/lib/edition";

/** The signed-in account, or null for "Use without account" (no session at all). */
export async function optionalAccount(): Promise<SessionUser | null> {
  try {
    const u = await requireUser();
    return u.isGuest ? null : u;
  } catch (e) {
    if (e instanceof AppError && ["unauthorized", "session_expired", "guest_ended"].includes(e.code)) return null;
    throw e;
  }
}

/** Every online-edition route starts here: refuses the local edition and waits for the database to be migrated. */
export async function assertCloud() {
  if (!isCloud()) throw new AppError("not_available", "This endpoint belongs to the online edition.", 404);
  await ensureCloudMigrated();
}
