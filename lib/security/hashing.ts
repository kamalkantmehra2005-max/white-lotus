import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import bcrypt from "bcryptjs";
import { z } from "zod";

/**
 * Password hashing: Argon2id (OWASP-recommended parameters: m=19 MiB, t=2, p=1).
 * Passwords are hashed, never encrypted, and never stored or logged in plaintext.
 * Legacy bcrypt hashes (from earlier versions) still verify and are upgraded on next login (needsRehash).
 */
// algorithm 2 = Argon2id (const enum in @node-rs/argon2 types, inlined for isolatedModules)
const ARGON = { algorithm: 2 as const, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(200, "Password is too long")
  .refine((p) => /[a-zA-Z]/.test(p) && /[0-9]/.test(p), "Password must contain letters and numbers");

let dummy: Promise<string> | undefined;
const dummyHash = () => (dummy ??= argonHash(crypto.randomUUID(), ARGON));

export async function hashPassword(plain: string): Promise<string> {
  return argonHash(plain, ARGON);
}

export function needsRehash(hash: string | null | undefined): boolean {
  return Boolean(hash) && !hash!.startsWith("$argon2id$");
}

export async function verifyPassword(plain: string, hash: string | null): Promise<boolean> {
  try {
    if (!hash) {
      await argonVerify(await dummyHash(), plain); // uniform timing for unknown accounts
      return false;
    }
    if (hash.startsWith("$argon2")) return await argonVerify(hash, plain);
    if (hash.startsWith("$2")) return await bcrypt.compare(plain, hash);
    return false;
  } catch {
    return false;
  }
}
