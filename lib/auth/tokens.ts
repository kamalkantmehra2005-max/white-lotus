import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { verificationTokens } from "@/lib/database/schema";

/**
 * Single-use tokens for password reset and email verification.
 * Only a SHA-256 hash is stored, so a database leak doesn't expose usable links.
 */
export type TokenPurpose = "reset" | "verify";
const TTL: Record<TokenPurpose, number> = { reset: 60 * 60_000, verify: 24 * 60 * 60_000 };

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const ident = (purpose: TokenPurpose, email: string) => `${purpose}:${email.toLowerCase()}`;

export async function issueToken(purpose: TokenPurpose, email: string): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  const identifier = ident(purpose, email);
  await db.delete(verificationTokens).where(eq(verificationTokens.identifier, identifier)); // one live token per purpose
  await db.insert(verificationTokens).values({ identifier, token: hash(raw), expires: new Date(Date.now() + TTL[purpose]) });
  return raw;
}

/** Returns the email the token was issued for, consuming it; null if invalid/expired. */
export async function consumeToken(purpose: TokenPurpose, raw: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(raw)) return null;
  const rows = await db
    .delete(verificationTokens)
    .where(and(eq(verificationTokens.token, hash(raw)), sql`${verificationTokens.identifier} like ${purpose + ":%"}`, gt(verificationTokens.expires, new Date())))
    .returning({ identifier: verificationTokens.identifier });
  const id = rows[0]?.identifier;
  return id ? id.slice(purpose.length + 1) : null;
}
