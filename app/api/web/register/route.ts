import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { env } from "@/config/env";
import { hashPassword } from "@/lib/auth/password";
import { db, rowsOf } from "@/lib/database/client";
import { profiles, userSettings, users } from "@/lib/database/schema";
import { AppError, handle } from "@/lib/errors";
import { logger } from "@/lib/observability/logger";
import { clientIp, enforceRateLimit } from "@/lib/security/rate-limit";
import { assertCloud } from "@/lib/web/http";
import { AUTH_SECRET_RE, KDF_ITERATIONS, SALT_RE } from "@/lib/web/kdf";

export const runtime = "nodejs";

const schema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  email: z.string().trim().toLowerCase().email("Enter a valid email").max(254),
  // Derived in the browser from the password; the password itself never reaches the server.
  authSecret: z.string().regex(AUTH_SECRET_RE, "Invalid login secret"),
  salt: z.string().regex(SALT_RE, "Invalid salt"),
  iterations: z.number().int().min(KDF_ITERATIONS).max(5_000_000),
  ownerCode: z.string().max(200).optional(),
});

function codeMatches(given: string | undefined) {
  const want = env.OWNER_SETUP_CODE;
  if (!want || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const POST = handle(async (req: Request) => {
  await assertCloud();
  if (!env.AUTH_ALLOW_SIGNUP) throw new AppError("signup_disabled", "New sign-ups are currently closed.", 403);
  await enforceRateLimit(`register:${clientIp(req)}`, env.RATE_LIMIT_SIGNUPS_PER_HOUR, 3600);
  const data = schema.parse(await req.json());
  const owner = codeMatches(data.ownerCode);
  if (data.ownerCode && !owner) throw new AppError("bad_owner_code", "That owner setup code isn't right.", 403);
  const passwordHash = await hashPassword(data.authSecret);
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(727001)`);
    const [existing] = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${data.email}`).limit(1);
    if (existing) return null;
    // The owner code works only while there is no admin yet.
    const admins = Number(rowsOf<{ n: number }>(await tx.execute(sql`select count(*)::int as n from users where role = 'admin'`))[0]?.n ?? 0);
    if (owner && admins > 0) return "owner_exists" as const;
    const [u] = await tx
      .insert(users)
      .values({ email: data.email, name: data.name, passwordHash, role: owner ? "admin" : "user", vaultSalt: data.salt, vaultKdfIterations: data.iterations })
      .returning({ id: users.id });
    await tx.insert(profiles).values({ userId: u.id, displayName: data.name });
    await tx.insert(userSettings).values({ userId: u.id });
    return u;
  });
  if (!result) throw new AppError("email_taken", "An account with this email already exists. Try signing in.", 409);
  if (result === "owner_exists") throw new AppError("owner_exists", "The owner account already exists. Remove OWNER_SETUP_CODE from the server settings.", 403);
  logger.info("web.registered", { owner });
  return NextResponse.json({ ok: true, owner }, { status: 201 });
});
