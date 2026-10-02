import "server-only";
import { requireUser, type SessionUser } from "@/lib/auth";

/** The current visitor for server components: an account, a guest, or nobody. Never throws. */
export async function getViewer(): Promise<SessionUser | null> {
  return requireUser().catch(() => null);
}
