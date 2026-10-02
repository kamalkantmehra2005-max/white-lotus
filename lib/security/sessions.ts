import "server-only";
import { and, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { userSessions, users } from "@/lib/database/schema";

/**
 * Server-side session registry.
 *
 * The browser holds an HttpOnly, Secure, SameSite=Lax session cookie (an encrypted Auth.js JWT). That token only
 * carries a session id ("sid"). Every protected request checks the sid against this table, so a session can be
 * ended server-side at any time — deleting a cookie is never the only line of defence.
 *
 *   sign in             → new row (new sid; prevents session fixation)
 *   each request        → must exist, belong to the user, not revoked, not past absolute expiry, not idle
 *   sign out            → this row revoked
 *   sign out everywhere → all rows revoked + users.session_version bumped (belt and braces)
 *   password change/reset, admin block → all rows revoked
 */
export const SESSION_MAX_AGE_HOURS = Number(process.env.SESSION_MAX_AGE_HOURS ?? 168); // absolute lifetime (7 days)
export const SESSION_IDLE_TIMEOUT_MINUTES = Number(process.env.SESSION_IDLE_TIMEOUT_MINUTES ?? 720); // 12 hours of inactivity
const TOUCH_INTERVAL_MS = 5 * 60_000;

export type SessionCheck = "ok" | "missing" | "revoked" | "expired" | "idle";

/** Coarse device label from a user agent — no fingerprinting, just "Edge on Windows". */
export function deviceLabel(ua: string | null | undefined): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /curl|wget|node|python/i.test(ua) ? "Script" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad|iOS/.test(ua) ? "iOS" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

/** Truncate an IP to a network prefix (/24 IPv4, /48 IPv6) — enough to recognise a location, not a person. */
export function ipPrefix(ip: string | null | undefined): string | null {
  if (!ip || ip === "unknown") return null;
  const v4 = ip.match(/^(\d+)\.(\d+)\.(\d+)\.\d+$/);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (ip.includes(":")) return `${ip.split(":").slice(0, 3).join(":")}::/48`;
  return null;
}

export async function createSession(userId: string, meta: { userAgent?: string | null; ip?: string | null; expiresAt?: Date } = {}) {
  const [row] = await db
    .insert(userSessions)
    .values({
      userId,
      device: deviceLabel(meta.userAgent),
      ipPrefix: ipPrefix(meta.ip),
      expiresAt: meta.expiresAt ?? new Date(Date.now() + SESSION_MAX_AGE_HOURS * 3_600_000),
    })
    .returning({ id: userSessions.id });
  return row.id;
}

/** Validate a session id for a user and refresh its last-seen time (throttled). */
export async function checkSession(sid: string | undefined, userId: string): Promise<SessionCheck> {
  if (!sid) return "missing";
  const [s] = await db.select().from(userSessions).where(and(eq(userSessions.id, sid), eq(userSessions.userId, userId))).limit(1);
  if (!s) return "missing";
  if (s.revokedAt) return "revoked";
  const now = Date.now();
  if (s.expiresAt.getTime() <= now) return "expired";
  if (SESSION_IDLE_TIMEOUT_MINUTES > 0 && now - s.lastSeenAt.getTime() > SESSION_IDLE_TIMEOUT_MINUTES * 60_000) {
    await revokeSession(userId, sid, "idle_timeout");
    return "idle";
  }
  if (now - s.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await db.update(userSessions).set({ lastSeenAt: new Date() }).where(eq(userSessions.id, sid));
  }
  return "ok";
}

export async function listSessions(userId: string) {
  return db
    .select({ id: userSessions.id, device: userSessions.device, ipPrefix: userSessions.ipPrefix, createdAt: userSessions.createdAt, lastSeenAt: userSessions.lastSeenAt, expiresAt: userSessions.expiresAt })
    .from(userSessions)
    .where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt), gt(userSessions.expiresAt, new Date())))
    .orderBy(desc(userSessions.lastSeenAt))
    .limit(50);
}

/** Revoke one session. Scoped by user id, so users can't revoke (or probe) other users' sessions. */
export async function revokeSession(userId: string, sid: string, reason = "signed_out") {
  const r = await db
    .update(userSessions)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(userSessions.id, sid), eq(userSessions.userId, userId), isNull(userSessions.revokedAt)))
    .returning({ id: userSessions.id });
  return r.length > 0;
}

/** Revoke every session of a user (optionally keeping one) and bump session_version so any stale token dies too. */
export async function revokeAllSessions(userId: string, reason: string, opts: { exceptSid?: string; bumpVersion?: boolean } = {}) {
  const r = await db
    .update(userSessions)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt), ...(opts.exceptSid ? [sql`${userSessions.id} <> ${opts.exceptSid}`] : [])))
    .returning({ id: userSessions.id });
  if (opts.bumpVersion !== false && !opts.exceptSid) {
    await db.update(users).set({ sessionVersion: sql`${users.sessionVersion} + 1` }).where(eq(users.id, userId));
  }
  return r.length;
}

/** Housekeeping: drop rows that ended more than 30 days ago (called by the retention job). */
export async function pruneSessions() {
  const cutoff = new Date(Date.now() - 30 * 86_400_000);
  await db.delete(userSessions).where(or(lt(userSessions.expiresAt, cutoff), lt(userSessions.revokedAt, cutoff)));
}
