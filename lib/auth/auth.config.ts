import type { NextAuthConfig } from "next-auth";
import { publicUrl } from "@/lib/public-url";

/**
 * Edge-safe auth configuration (no DB / Node APIs). Used by middleware to protect routes.
 * The full config (adapter + providers) lives in lib/auth/index.ts.
 */
export const PROTECTED_PREFIXES = ["/chat", "/settings", "/projects", "/files", "/memory", "/admin"];
export const PROTECTED_API_PREFIXES = ["/api/chat", "/api/conversations", "/api/files", "/api/projects", "/api/memories", "/api/settings", "/api/admin", "/api/usage", "/api/models", "/api/guest", "/api/local", "/api/messages"];

/** APIs a guest (no-signup) session may never call. Enforced here AND in every handler via requireAccount(). */
export const ACCOUNT_ONLY_API_PREFIXES = ["/api/files", "/api/projects", "/api/memories", "/api/settings", "/api/admin", "/api/local/storage", "/api/local/backup", "/api/local/restore", "/api/local/move", "/api/local/wipe", "/api/local/open-folder", "/api/local/search-history", "/api/messages"];

export const authConfig = {
  pages: { signIn: "/login" },
  // 7-day sessions, refreshed at most daily while active. Revocation: users.session_version (see requireUser).
  session: { strategy: "jwt", maxAge: 60 * 60 * Number(process.env.SESSION_MAX_AGE_HOURS ?? 168), updateAge: 60 * 60 },
  trustHost: true,
  // __Secure- prefixed, Secure cookies whenever the app is served over HTTPS (always in production).
  useSecureCookies: publicUrl().startsWith("https://"),
  providers: [],
  callbacks: {
    authorized({ auth, request }) {
      const { pathname } = request.nextUrl;
      const isApi = PROTECTED_API_PREFIXES.some((p) => pathname.startsWith(p));
      const isPage = PROTECTED_PREFIXES.some((p) => pathname.startsWith(p));
      if (!isApi && !isPage) return true;
      if (!auth?.user) {
        if (isApi) return Response.json({ error: { code: "unauthorized", message: "Please sign in to continue." } }, { status: 401 });
        return false; // redirect to signIn page
      }
      if ((auth.user as { guest?: boolean }).guest && isApi && ACCOUNT_ONLY_API_PREFIXES.some((p) => pathname.startsWith(p))) {
        return Response.json({ error: { code: "account_required", message: "This feature needs a free account. Sign in or create one." } }, { status: 403 });
      }
      if (pathname.startsWith("/admin") || pathname.startsWith("/api/admin")) {
        if ((auth.user as { role?: string }).role === "admin") return true;
        if (isApi) return Response.json({ error: { code: "forbidden", message: "You don't have access to that." } }, { status: 403 });
        return Response.redirect(new URL("/chat", request.nextUrl));
      }
      return true;
    },
    jwt({ token, user }) {
      if (user) {
        token.uid = user.id;
        token.role = (user as { role?: string }).role ?? "user";
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.uid as string;
        (session.user as { role?: string }).role = token.role as string;
        (session.user as { sv?: number }).sv = (token.sv as number | undefined) ?? 0;
        (session.user as { sid?: string }).sid = token.sid as string | undefined;
        (session.user as { guest?: boolean }).guest = Boolean(token.guest);
        if (token.guest) session.user.email = ""; // placeholder address, never shown
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
