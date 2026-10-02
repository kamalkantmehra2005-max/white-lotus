import "server-only";
import { createHmac } from "node:crypto";

/** Browser-side key derivation parameters for the online edition (PBKDF2-SHA256 via WebCrypto). */
export const KDF_ITERATIONS = 600_000;

/**
 * For an unknown email, return a stable fake salt so /prelogin doesn't reveal which emails have accounts.
 */
export function decoySalt(email: string): string {
  return createHmac("sha256", process.env.AUTH_SECRET ?? "white-lotus").update(`decoy-salt:${email.toLowerCase()}`).digest("base64url").slice(0, 22);
}

export const SALT_RE = /^[A-Za-z0-9_-]{22,64}$/;
/** The login secret the browser derives (base64url of 32 bytes). */
export const AUTH_SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
