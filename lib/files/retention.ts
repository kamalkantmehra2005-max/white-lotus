import "server-only";
import { and, eq, lt, sql } from "drizzle-orm";
import { env } from "@/config/env";
import { db } from "@/lib/database/client";
import { attachments, documents, errorLogs, rateLimitBuckets } from "@/lib/database/schema";
import { logger } from "@/lib/observability/logger";
import { pruneSessions } from "@/lib/security/sessions";
import { storage } from "./storage";
import { purgeExpiredGuests } from "@/lib/auth/guest";

/**
 * Retention / housekeeping — runs inside the local app every 6 hours (instrumentation.ts), on this computer.
 *  • FILE_RETENTION_DAYS > 0: files older than N days are deleted (object + database rows).
 *  • Quarantine objects left behind by an interrupted upload (> 1 hour) are removed.
 *  • Guest data older than GUEST_RETENTION_HOURS is deleted.
 *  • Ended sessions > 30 days, error logs > 90 days and expired rate-limit buckets are pruned.
 */
export async function runRetention() {
  const s = storage();
  let files = 0;
  let quarantine = 0;

  const stale = await db
    .select({ id: attachments.id, key: attachments.storageKey })
    .from(attachments)
    .where(and(eq(attachments.scanStatus, "pending"), lt(attachments.createdAt, new Date(Date.now() - 3_600_000))));
  for (const a of stale) {
    await s.delete(a.key).catch(() => {});
    await db.delete(attachments).where(eq(attachments.id, a.id));
    quarantine++;
  }

  if (env.FILE_RETENTION_DAYS > 0) {
    const cutoff = new Date(Date.now() - env.FILE_RETENTION_DAYS * 86_400_000);
    const old = await db.select({ id: attachments.id, key: attachments.storageKey, documentId: attachments.documentId }).from(attachments).where(lt(attachments.createdAt, cutoff)).limit(5000);
    for (const a of old) {
      await s.delete(a.key).catch((e) => logger.warn("retention.delete_failed", { error: e }));
      await db.delete(attachments).where(eq(attachments.id, a.id));
      if (a.documentId) await db.delete(documents).where(eq(documents.id, a.documentId));
      files++;
    }
  }

  // Guest (no-signup) data past GUEST_RETENTION_HOURS. Also purged on access and whenever a new guest starts.
  const guests = await purgeExpiredGuests(5000);
  await pruneSessions();
  await db.delete(errorLogs).where(lt(errorLogs.createdAt, new Date(Date.now() - 90 * 86_400_000)));
  await db.delete(rateLimitBuckets).where(sql`${rateLimitBuckets.resetAt} < now() - interval '1 hour'`);
  logger.info("retention.done", { files, quarantine, guests });
  return { files, quarantine, guests };
}
