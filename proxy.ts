import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "@/lib/auth/auth.config";
import { buildCsp, makeNonce } from "@/lib/security/csp";
import { publicUrl } from "@/lib/public-url";
import { allowedOriginHosts, isLoopbackRequest } from "@/lib/security/request-origin";
import { isCloud } from "@/lib/edition";

// Online edition: conversations, files and settings live in each device's browser, so every server route that would
// store content is switched off, and the old pages go to the web app at /app.
const CLOUD_PAGES_TO_APP = [/^\/$/, /^\/(login|register|forgot-password|reset-password)(\/|$)/, /^\/(chat|files|projects|memory|settings)(\/|$)/];
const CLOUD_BLOCKED_API = [
  "/api/chat", "/api/conversations", "/api/messages", "/api/files", "/api/projects", "/api/memories", "/api/settings", "/api/local",
  "/api/guest", "/api/cron", "/api/usage", "/api/models", "/api/auth/register", "/api/auth/forgot-password", "/api/auth/reset-password", "/api/auth/verify-email",
];

const { auth } = NextAuth(authConfig);

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// HTTPS enforcement applies whenever the public URL is https (always true for a real deployment).
const HTTPS_APP = publicUrl().startsWith("https://");
const csrfBlocked = () => NextResponse.json({ error: { code: "csrf", message: "Cross-site request blocked." } }, { status: 403 });

/**
 * Next.js 16 proxy (formerly middleware):
 *  1. CSRF defence for API mutations — reject when the browser says the request is cross-site
 *     (Sec-Fetch-Site) or the Origin host doesn't match. Session cookies are also SameSite=Lax.
 *  2. Route protection via authConfig.callbacks.authorized (every handler re-checks auth too).
 *  3. A per-request CSP nonce (strict CSP, no inline scripts) and a request id for log correlation.
 */
export default auth((req) => {
  const { pathname } = req.nextUrl;
  if (isCloud()) {
    if (CLOUD_BLOCKED_API.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
      return NextResponse.json({ error: { code: "not_available", message: "Not available in the online edition." } }, { status: 404 });
    }
    if (CLOUD_PAGES_TO_APP.some((r) => r.test(pathname))) return NextResponse.redirect(new URL("/app", req.nextUrl));
  }
  // HTTPS everywhere: behind a TLS-terminating proxy/CDN, bounce plain-HTTP requests (health checks exempt).
  const loopback = isLoopbackRequest(req.headers);
  // (Requests typed on this computer itself stay on http://127.0.0.1.)
  if (HTTPS_APP && !loopback && req.headers.get("x-forwarded-proto") === "http" && pathname !== "/api/health") {
    const url = req.nextUrl.clone();
    url.protocol = "https:";
    url.port = "";
    return NextResponse.redirect(url, 308);
  }
  if (pathname.startsWith("/api/") && !pathname.startsWith("/api/auth/") && MUTATING.has(req.method)) {
    const site = req.headers.get("sec-fetch-site");
    if (site === "cross-site") return csrfBlocked();
    const origin = req.headers.get("origin");
    if (origin) {
      try {
        if (!allowedOriginHosts(req.headers, publicUrl()).has(new URL(origin).host.toLowerCase())) return csrfBlocked();
      } catch {
        return csrfBlocked();
      }
    }
  }
  // Route guard. With the wrapped-handler form, Auth.js does not act on `authorized` by itself, so apply it
  // explicitly: unauthenticated pages → /login, APIs → 401, guests on account-only APIs → 403, admin → admins.
  // (Every handler re-checks with requireUser/requireAccount/requireAdmin against the database as well.)
  const verdict = authConfig.callbacks.authorized({ auth: req.auth, request: req });
  if (verdict instanceof Response) return verdict;
  if (verdict === false) {
    const login = new URL("/login", req.nextUrl);
    login.searchParams.set("callbackUrl", pathname + req.nextUrl.search);
    return NextResponse.redirect(login);
  }
  const requestId = crypto.randomUUID(); // never trust a client-supplied request id
  const nonce = makeNonce();
  // On this computer the app is plain http://127.0.0.1, so don't ask the browser to upgrade to https there.
  const csp = buildCsp(nonce, { dev: process.env.NODE_ENV === "development", https: HTTPS_APP && !loopback });
  const headers = new Headers(req.headers);
  headers.set("x-request-id", requestId);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp); // Next.js reads the nonce from here and applies it to its scripts
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("x-request-id", requestId);
  res.headers.set("Content-Security-Policy", csp);
  return res;
});

export const config = {
  // Static, public, contain no user data: icons, the PWA manifest, the service worker and its offline page.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt|manifest.webmanifest|sw.js|offline.html|icons/).*)"],
};
