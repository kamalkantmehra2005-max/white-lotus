import "server-only";
import { ensureCloudMigrated } from "@/lib/database/cloud-migrate";
import NextAuth, { type DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, getDb } from "@/lib/database/client";
import { accounts, sessions, users, verificationTokens } from "@/lib/database/schema";
import { rateLimit } from "@/lib/security/rate-limit";
import { checkSession, createSession, revokeSession } from "@/lib/security/sessions";
import { hashPassword, needsRehash, verifyPassword } from "./password";
import { authConfig } from "./auth.config";
import { Errors } from "@/lib/errors";
import { env } from "@/config/env";
import { createGuest, GuestRateLimited, guestEnabled } from "./guest";
import { logger } from "@/lib/observability/logger";

declare module "next-auth" {
  interface Session {
    user: { id: string; role: "user" | "admin"; guest?: boolean } & DefaultSession["user"];
  }
}

const credentialsSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
});

function ipOf(req: Request | undefined) {
  const fwd = req?.headers.get("x-forwarded-for");
  return (fwd?.split(",")[0] ?? req?.headers.get("x-real-ip") ?? "unknown").trim().slice(0, 64);
}

/** Admin if role=admin, or the email is in ADMIN_EMAILS AND has been verified (prevents claiming an admin address by registering it). */
export function effectiveRole(row: { role: string; email: string; emailVerified: Date | null }): "user" | "admin" {
  if (row.role === "admin") return "admin";
  const admins = env.ADMIN_EMAILS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return row.emailVerified && admins.includes(row.email.toLowerCase()) ? "admin" : "user";
}

/** Google OAuth is enabled only when both values are set (GOOGLE_* preferred, AUTH_GOOGLE_* accepted). */
export function googleCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GOOGLE_CLIENT_ID || process.env.AUTH_GOOGLE_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || process.env.AUTH_GOOGLE_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function providers() {
  const list = [
    Credentials({
      name: "Email",
      credentials: { email: {}, password: {} },
      async authorize(raw, request) {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;
        const email = parsed.data.email.toLowerCase();
        // Brute-force protection: per account and per IP, 15-minute windows.
        const [byEmail, byIp] = await Promise.all([rateLimit(`login:email:${email}`, env.RATE_LIMIT_LOGIN_ATTEMPTS, 900), rateLimit(`login:ip:${ipOf(request)}`, env.RATE_LIMIT_LOGIN_ATTEMPTS * 4, 900)]);
        if (!byEmail.allowed || !byIp.allowed) {
          logger.warn("auth.login_rate_limited", { byEmail: !byEmail.allowed, byIp: !byIp.allowed });
          return null;
        }
        const [user] = await db.select().from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
        // Always run a hash comparison to keep timing uniform whether or not the user exists.
        const ok = await verifyPassword(parsed.data.password, user?.passwordHash ?? null);
        if (!user || !ok || user.blocked) return null;
        if (env.AUTH_REQUIRE_EMAIL_VERIFICATION && !user.emailVerified) return null;
        if (needsRehash(user.passwordHash)) {
          // Transparent upgrade of legacy bcrypt hashes to Argon2id.
          await db.update(users).set({ passwordHash: await hashPassword(parsed.data.password) }).where(eq(users.id, user.id));
        }
        return { id: user.id, email: user.email, name: user.name, image: user.image, role: user.role };
      },
    }),
  ];
  // Guest mode: a temporary server-side identity with no credentials. Only offered when ALLOW_GUEST_CHAT=true.
  if (guestEnabled()) {
    list.push(
      Credentials({
        id: "guest",
        name: "Guest",
        credentials: {},
        async authorize(_raw, request) {
          if (!guestEnabled()) return null;
          try {
            const g = await createGuest(ipOf(request));
            return { id: g.id, email: g.email, name: g.name, role: "user" };
          } catch (e) {
            if (e instanceof GuestRateLimited) logger.warn("auth.guest_rate_limited", {});
            else logger.error("auth.guest_failed", { error: e });
            return null;
          }
        },
      }),
    );
  }
  const google = googleCredentials();
  if (google) list.push(Google({ ...google, allowDangerousEmailAccountLinking: false }) as never);
  return list;
}

/**
 * Auth.js adapter that never persists OAuth provider tokens (access/refresh/id tokens).
 * WHITE-LOTUS only needs the identity, so the safest token is the one we don't store.
 */
function minimalTokenAdapter() {
  const base = DrizzleAdapter(getDb(), {
    usersTable: users as never,
    accountsTable: accounts as never,
    sessionsTable: sessions as never,
    verificationTokensTable: verificationTokens as never,
  });
  return {
    ...base,
    linkAccount: (acc: Parameters<NonNullable<typeof base.linkAccount>>[0]) =>
      base.linkAccount!({ ...acc, access_token: undefined, refresh_token: undefined, id_token: undefined, session_state: undefined }),
  };
}

// Lazy config: built per request (so sign-in can record the device), never at import/build time.
export const { handlers, auth, signIn, signOut } = NextAuth((req) => ({
  ...authConfig,
  adapter: minimalTokenAdapter(),
  providers: providers(),
  callbacks: {
    ...authConfig.callbacks,
    async signIn({ user, account, profile }) {
      if (account?.provider === "google") {
        const email = (profile?.email ?? user.email ?? "").toLowerCase();
        const [existing] = email ? await db.select({ id: users.id, blocked: users.blocked }).from(users).where(sql`lower(${users.email}) = ${email}`).limit(1) : [];
        if (existing?.blocked) return false;
        // New OAuth sign-ups respect the sign-up switch; existing users can always sign in.
        if (!existing && !env.AUTH_ALLOW_SIGNUP) return "/login?error=signup_closed";
        if (profile && (profile as { email_verified?: boolean }).email_verified !== true) return false;
        return true;
      }
      if (!user?.id) return true;
      const [row] = await db.select({ blocked: users.blocked }).from(users).where(eq(users.id, user.id)).limit(1);
      return !row?.blocked;
    },
    async jwt({ token, user }) {
      if (user) {
        token.uid = user.id;
        const [row] = await db
          .select({ role: users.role, email: users.email, emailVerified: users.emailVerified, sessionVersion: users.sessionVersion, isGuest: users.isGuest, guestExpiresAt: users.guestExpiresAt })
          .from(users)
          .where(eq(users.id, user.id!))
          .limit(1);
        token.role = row && !row.isGuest ? effectiveRole(row) : "user";
        token.sv = row?.sessionVersion ?? 0;
        token.guest = Boolean(row?.isGuest);
        // Every sign-in gets a NEW server-side session (prevents fixation; lets it be revoked individually).
        // A guest session can never outlive the guest's data.
        token.sid = await createSession(user.id!, { userAgent: req?.headers.get("user-agent"), ip: ipOf(req), expiresAt: row?.isGuest ? (row.guestExpiresAt ?? undefined) : undefined });
      }
      return token;
    },
  },
  events: {
    // Sign out ends the session server-side, not just by clearing the cookie.
    async signOut(message) {
      const token = "token" in message ? message.token : null;
      if (token?.uid && token.sid) await revokeSession(String(token.uid), String(token.sid), "signed_out").catch(() => {});
      // Ending a guest session deletes the guest's data right away (nothing is kept "just in case").
      if (token?.uid && token.guest) await db.delete(users).where(and(eq(users.id, String(token.uid)), eq(users.isGuest, true))).catch(() => {});
    },
    // Google has verified the address; record it so ADMIN_EMAILS can apply.
    async linkAccount({ user, account }) {
      if (account.provider === "google" && user.id) await db.update(users).set({ emailVerified: new Date() }).where(eq(users.id, user.id));
    },
  },
}));

export type SessionUser = {
  id: string;
  role: "user" | "admin";
  email?: string | null;
  name?: string | null;
  emailVerified?: boolean;
  sid: string;
  /** Temporary no-signup identity (ALLOW_GUEST_CHAT). Limited features; data deleted at guestExpiresAt. */
  isGuest: boolean;
  guestExpiresAt: Date | null;
};

/**
 * Resolve the current user for a server route: authenticated → session valid server-side → not blocked.
 * Re-checks the database on every call, so sign-out-everywhere, idle timeout, blocking or admin changes
 * take effect on the very next request.
 */
export async function requireUser(): Promise<SessionUser> {
  await ensureCloudMigrated(); // online edition only; instant once done
  const session = await auth();
  const id = session?.user?.id;
  if (!id) throw Errors.unauthorized();
  const [row] = await db
    .select({ id: users.id, role: users.role, email: users.email, name: users.name, blocked: users.blocked, emailVerified: users.emailVerified, sessionVersion: users.sessionVersion, isGuest: users.isGuest, guestExpiresAt: users.guestExpiresAt })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (!row) throw Errors.unauthorized();
  if (row.blocked) throw Errors.blocked();
  // Session invalidation: a JWT issued before the latest password change / sign-out-everywhere is rejected.
  if (((session.user as { sv?: number }).sv ?? 0) !== row.sessionVersion) throw Errors.sessionEnded();
  // Guests end when guest mode is switched off or their retention period is over (data is purged separately).
  if (row.isGuest && (!guestEnabled() || !row.guestExpiresAt || row.guestExpiresAt <= new Date())) throw Errors.guestEnded();
  const sid = (session.user as { sid?: string }).sid;
  const state = await checkSession(sid, row.id);
  if (state !== "ok") throw Errors.sessionEnded();
  return {
    id: row.id,
    role: row.isGuest ? "user" : effectiveRole(row),
    email: row.isGuest ? null : row.email,
    name: row.isGuest ? "Guest" : row.name,
    emailVerified: !row.isGuest && Boolean(row.emailVerified),
    sid: sid!,
    isGuest: row.isGuest,
    guestExpiresAt: row.guestExpiresAt,
  };
}

/** Like requireUser, but for features that need a real account (files, projects, memory, settings, export). */
export async function requireAccount(feature?: string): Promise<SessionUser> {
  const u = await requireUser();
  if (u.isGuest) throw Errors.accountRequired(feature);
  return u;
}

export async function requireAdmin(): Promise<SessionUser> {
  const u = await requireUser();
  if (u.isGuest || u.role !== "admin") throw Errors.forbidden();
  return u;
}
