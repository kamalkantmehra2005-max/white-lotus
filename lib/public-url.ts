/**
 * The address WHITE-LOTUS is served on. Edge-safe (no server-only imports), used by proxy.ts and the auth config.
 *  • Local launcher: http://127.0.0.1:<port> (or your private Tailscale address).
 *  • Online edition: APP_URL if set, otherwise the host's own production address (Vercel, Render, Railway…).
 */
export function publicUrl(): string {
  const explicit = process.env.AUTH_URL || process.env.APP_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.RENDER_EXTERNAL_HOSTNAME || process.env.RAILWAY_PUBLIC_DOMAIN;
  return host ? `https://${host.replace(/^https?:\/\//, "").replace(/\/+$/, "")}` : "";
}
