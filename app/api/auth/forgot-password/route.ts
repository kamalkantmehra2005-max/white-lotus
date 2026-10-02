import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { env } from "@/config/env";
import { issueToken } from "@/lib/auth/tokens";
import { db } from "@/lib/database/client";
import { users } from "@/lib/database/schema";
import { AppError, handle } from "@/lib/errors";
import { isMailConfigured, sendMail, simpleHtml } from "@/lib/mail";
import { clientIp, enforceRateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";

/** Always answers the same way whether or not the account exists (no account enumeration). */
export const POST = handle(async (req: Request) => {
  if (!isMailConfigured()) throw new AppError("mail_not_configured", "Password reset by email isn't available on this server. Contact the administrator.", 503);
  const { email } = z.object({ email: z.string().trim().toLowerCase().email().max(254) }).parse(await req.json());
  await enforceRateLimit(`forgot:ip:${clientIp(req)}`, 5, 900);
  await enforceRateLimit(`forgot:email:${email}`, 3, 3600);
  const [u] = await db.select({ id: users.id, blocked: users.blocked }).from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
  if (u && !u.blocked) {
    const token = await issueToken("reset", email);
    const link = `${env.APP_URL}/reset-password?token=${token}`;
    await sendMail({
      to: email,
      subject: "Reset your WHITE-LOTUS password",
      text: `Someone asked to reset the password for this WHITE-LOTUS account.\n\nIf it was you, use this link within 1 hour:\n${link}\n\nIf not, ignore this email — your password is unchanged.`,
      html: simpleHtml("Someone asked to reset the password for this WHITE-LOTUS account.\n\nIf it was you, use the button below within 1 hour. If not, ignore this email.", { href: link, label: "Reset password" }),
    });
  }
  return NextResponse.json({ ok: true, message: "If an account exists for that email, a reset link is on its way." });
});
