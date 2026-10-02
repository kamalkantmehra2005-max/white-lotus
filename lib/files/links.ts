import "server-only";
import { env } from "@/config/env";
import { sign, verifySignature } from "@/lib/security/encryption";

/**
 * Short-lived signed download links.
 *
 *   authenticated user → ownership verified → link minted (this module) → browser follows it
 *
 * The signature covers the file id, the *user id* and the expiry, so a link:
 *   • expires after DOWNLOAD_LINK_TTL_SECONDS (default 60s),
 *   • only works for that one file,
 *   • only works for the same signed-in user (the download route re-authenticates and re-checks ownership),
 *   • never contains storage credentials.
 */
export function createDownloadLink(attachmentId: string, userId: string, ttlSec = env.DOWNLOAD_LINK_TTL_SECONDS) {
  const exp = Math.floor(Date.now() / 1000) + Math.max(10, Math.min(ttlSec, 3600));
  const sig = sign(`dl:v1:${attachmentId}:${userId}:${exp}`);
  return { url: `/api/files/${encodeURIComponent(attachmentId)}/download?exp=${exp}&sig=${sig}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export type LinkCheck = "ok" | "expired" | "invalid";

export function checkDownloadLink(attachmentId: string, userId: string, exp: string | null, sig: string | null): LinkCheck {
  if (!exp || !sig || !/^\d{9,11}$/.test(exp) || !/^[A-Za-z0-9_-]{20,100}$/.test(sig)) return "invalid";
  if (!verifySignature(`dl:v1:${attachmentId}:${userId}:${exp}`, sig)) return "invalid";
  if (Number(exp) * 1000 < Date.now()) return "expired";
  return "ok";
}
