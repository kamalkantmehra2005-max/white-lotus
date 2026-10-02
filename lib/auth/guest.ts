import "server-only";
import { randomBytes } from "node:crypto";
import { and, eq, inArray, lt } from "drizzle-orm";
import { env } from "@/config/env";
import { db } from "@/lib/database/client";
import { attachments, conversations, usageRecords, userSettings, users } from "@/lib/database/schema";
import { logger } from "@/lib/observability/logger";
import { decryptOr, encrypt, sign, verifySignature } from "@/lib/security/encryption";
import { AAD } from "@/lib/security/fields";
import { rateLimit } from "@/lib/security/rate-limit";

/**
 * Guest (no-signup) mode — ALLOW_GUEST_CHAT=true.
 *
 * A guest is a real, server-side identity: a `users` row with is_guest=true plus a normal server-side session
 * (HttpOnly cookie → session id → user_sessions). Everything a guest creates is owner-scoped exactly like an
 * account's data, so one guest can never read another guest's (or anyone's) data. The browser never supplies an id.
 *
 * Guests are deliberately limited:
 *   ✓ chat (incl. web research, with stricter daily limits)      ✗ file uploads / private storage
 *   ✓ conversations kept for GUEST_RETENTION_HOURS               ✗ projects, memory, settings, data export
 * After GUEST_RETENTION_HOURS the guest and everything it created is deleted (on access, opportunistically on each
 * new guest, and by the daily retention job). A guest who signs in / signs up can choose to keep their chats.
 */

export const guestEnabled = () => env.ALLOW_GUEST_CHAT;
export const guestRetentionHours = () => Math.max(1, env.GUEST_RETENTION_HOURS);

export class GuestRateLimited extends Error {}

export async function createGuest(ip: string): Promise<{ id: string; email: string; name: string; expiresAt: Date }> {
  if (!guestEnabled()) throw new Error("guest mode disabled");
  const rl = await rateLimit(`guest:create:${ip}`, env.GUEST_SESSIONS_PER_IP_PER_HOUR, 3600);
  if (!rl.allowed) throw new GuestRateLimited();
  // Keep the table tidy without depending on a cron schedule.
  await purgeExpiredGuests(25).catch((e) => logger.warn("guest.purge_failed", { error: e }));
  const expiresAt = new Date(Date.now() + guestRetentionHours() * 3_600_000);
  // A unique, non-deliverable placeholder address (RFC 2606 ".invalid") — never shown as a real email.
  const email = `guest-${randomBytes(12).toString("hex")}@guest.invalid`;
  const [u] = await db.insert(users).values({ email, name: "Guest", isGuest: true, guestExpiresAt: expiresAt }).returning({ id: users.id });
  await db.insert(userSettings).values({ userId: u.id, memoryEnabled: false });
  logger.info("guest.created", {});
  return { id: u.id, email, name: "Guest", expiresAt };
}

/**
 * Delete expired guests and everything they own (FK cascades), including any stored objects.
 * With guest mode switched off, every guest counts as expired.
 */
export async function purgeExpiredGuests(limit = 1000): Promise<number> {
  const expired = await db
    .select({ id: users.id })
    .from(users)
    .where(guestEnabled() ? and(eq(users.isGuest, true), lt(users.guestExpiresAt, new Date())) : eq(users.isGuest, true))
    .limit(limit);
  if (!expired.length) return 0;
  const ids = expired.map((r) => r.id);
  // Guests can't upload, but be defensive: remove any object before its row disappears.
  const objs = await db.select({ key: attachments.storageKey }).from(attachments).where(inArray(attachments.userId, ids));
  if (objs.length) {
    const { storage } = await import("@/lib/files/storage");
    const s = storage();
    await Promise.all(objs.map((o) => s.delete(o.key).catch(() => {})));
  }
  await db.delete(users).where(and(inArray(users.id, ids), eq(users.isGuest, true)));
  return ids.length;
}

// ───────────── Keeping guest chats after signing in ─────────────
// The guest session mints a short-lived signed claim token (bound to the guest id). After the visitor signs in or
// registers, the NEW session presents it; the server re-verifies the signature and that the guest still exists, then
// moves the conversations to the account and deletes the guest. The token proves possession of the guest session.

const CLAIM_TTL_S = 15 * 60;

export function issueClaimToken(guestId: string): string {
  const exp = Math.floor(Date.now() / 1000) + CLAIM_TTL_S;
  const payload = `guest-claim:v1:${guestId}:${exp}`;
  return `${guestId}.${exp}.${sign(payload)}`;
}

export function verifyClaimToken(token: string): string | null {
  const [guestId, expS, sig] = token.split(".");
  if (!guestId || !expS || !sig || !/^\d+$/.test(expS)) return null;
  if (Number(expS) < Date.now() / 1000) return null;
  return verifySignature(`guest-claim:v1:${guestId}:${expS}`, sig) ? guestId : null;
}

export async function claimGuest(token: string, accountId: string): Promise<{ moved: number }> {
  const guestId = verifyClaimToken(token);
  if (!guestId || guestId === accountId) return { moved: 0 };
  return db.transaction(async (tx) => {
    const [g] = await tx.select({ id: users.id, isGuest: users.isGuest, exp: users.guestExpiresAt }).from(users).where(eq(users.id, guestId)).for("update").limit(1);
    const [acct] = await tx.select({ isGuest: users.isGuest }).from(users).where(eq(users.id, accountId)).limit(1);
    // Only a live guest can be claimed, and only into a real account (never guest → guest).
    if (!g?.isGuest || !acct || acct.isGuest || (g.exp && g.exp < new Date())) return { moved: 0 };
    const convs = await tx.select({ id: conversations.id, title: conversations.title }).from(conversations).where(eq(conversations.userId, guestId));
    for (const c of convs) {
      // Titles are bound to their owner (AAD); re-encrypt for the new owner. Messages are bound to the conversation.
      const title = decryptOr(c.title, AAD.title(guestId), "Guest chat");
      await tx.update(conversations).set({ userId: accountId, title: encrypt(title, AAD.title(accountId)), projectId: null }).where(eq(conversations.id, c.id));
    }
    // Carry today's usage over so claiming can't be used to reset limits.
    await tx.update(usageRecords).set({ userId: accountId }).where(eq(usageRecords.userId, guestId));
    await tx.delete(users).where(and(eq(users.id, guestId), eq(users.isGuest, true)));
    logger.info("guest.claimed", { conversations: convs.length });
    return { moved: convs.length };
  });
}

