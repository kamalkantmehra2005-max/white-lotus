import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { hashPassword, passwordSchema } from "@/lib/auth/password";
import { consumeToken } from "@/lib/auth/tokens";
import { db } from "@/lib/database/client";
import { users } from "@/lib/database/schema";
import { AppError, handle } from "@/lib/errors";
import { clientIp, enforceRateLimit } from "@/lib/security/rate-limit";
import { revokeAllSessions } from "@/lib/security/sessions";

export const runtime = "nodejs";

export const POST = handle(async (req: Request) => {
  await enforceRateLimit(`reset:ip:${clientIp(req)}`, 10, 900);
  const data = z.object({ token: z.string().min(20).max(100), password: passwordSchema }).parse(await req.json());
  const email = await consumeToken("reset", data.token);
  if (!email) throw new AppError("invalid_token", "This reset link is invalid or has expired. Request a new one.", 400);
  // Resetting proves control of the mailbox → also marks the email verified. All sessions are invalidated.
  const [u] = await db
    .update(users)
    .set({ passwordHash: await hashPassword(data.password), emailVerified: new Date() })
    .where(sql`lower(${users.email}) = ${email}`)
    .returning({ id: users.id });
  if (u) await revokeAllSessions(u.id, "password_reset");
  return NextResponse.json({ ok: true });
});
