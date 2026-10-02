import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/database/client";
import { users } from "@/lib/database/schema";
import { handle } from "@/lib/errors";
import { clientIp, enforceRateLimit } from "@/lib/security/rate-limit";
import { assertCloud } from "@/lib/web/http";
import { decoySalt, KDF_ITERATIONS } from "@/lib/web/kdf";

export const runtime = "nodejs";

/** Step 1 of sign-in: the salt the browser needs to derive the login secret and the vault key. */
export const POST = handle(async (req: Request) => {
  await assertCloud();
  await enforceRateLimit(`prelogin:${clientIp(req)}`, 60, 900);
  const { email } = z.object({ email: z.string().trim().toLowerCase().email().max(254) }).parse(await req.json());
  const [u] = await db.select({ salt: users.vaultSalt, iters: users.vaultKdfIterations }).from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
  return NextResponse.json({ salt: u?.salt ?? decoySalt(email), iterations: u?.iters ?? KDF_ITERATIONS });
});
