/**
 * Content-Security-Policy, built per request with a fresh nonce (set by proxy.ts).
 *  • Scripts: only those carrying this request's nonce ('strict-dynamic' lets them load Next's own chunks).
 *    No 'unsafe-inline' and no 'unsafe-eval' in production.
 *  • No framing, plugins, <base> hijacking or off-site form posts. Images only from this origin (model output never
 *    auto-loads remote images). Connections only to this origin — AI, search and storage are reached server-side.
 * Edge/Node-safe (no Node APIs).
 */
export function buildCsp(nonce: string, opts: { dev?: boolean; https?: boolean } = {}): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${opts.dev ? " 'unsafe-eval'" : ""}`,
    // Inline styles are required by Next.js/React style attributes; styles can't execute code.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${opts.dev ? " ws:" : ""}`,
    "media-src 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://accounts.google.com",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    ...(opts.https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

export function makeNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}
