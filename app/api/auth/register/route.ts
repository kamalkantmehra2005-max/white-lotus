import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { env } from "@/config/env";
import { hashPassword, passwordSchema } from "@/lib/auth/password";
import { issueToken } from "@/lib/auth/tokens";
import { db, rowsOf } from "@/lib/database/client";
import { profiles, userSettings, users } from "@/lib/database/schema";
import { AppError, handle } from "@/lib/errors";
import { sendMail, simpleHtml } from "@/lib/mail";
import { clientIp, enforceRateLimit } from "@/lib/security/rate-limit";
import { isLoopbackRequest } from "@/lib/security/request-origin";

export const runtime = "nodejs";

const schema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  email: z.string().trim().toLowerCase().email("Enter a valid email").max(254),
  password: passwordSchema,
});

export const POST = handle(async (req: Request) => {
  if (!env.AUTH_ALLOW_SIGNUP) throw new AppError("signup_disabled", "New sign-ups are currently closed.", 403);
  await enforceRateLimit(`register:${clientIp(req)}`, env.RATE_LIMIT_SIGNUPS_PER_HOUR, 3600);
  const data = schema.parse(await req.json());
  const passwordHash = await hashPassword(data.password);

  // Transaction + advisory lock: two simultaneous first sign-ups can't both become admin,
  // and the unique email index can't be raced into a 500.
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(727001)`);
    const [existing] = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${data.email}`).limit(1);
    if (existing) return null;
    // Personal install: only the owner's account can be created (others would share this computer's data folder).
    if (env.LOCAL_SINGLE_USER && Number(rowsOf<{ n: number }>(await tx.execute(sql`select count(*)::int as n from users where not is_guest`))[0]?.n ?? 0) > 0) return "owner_exists" as const;
    const first = env.AUTH_FIRST_USER_ADMIN && Number(rowsOf<{ n: number }>(await tx.execute(sql`select count(*)::int as n from users where not is_guest`))[0]?.n ?? 0) === 0;
    // The owner (admin) account can only be created on this computer itself — never through remote access.
    if (first && process.env.WHITE_LOTUS_LAUNCHER === "1" && !isLoopbackRequest(req.headers)) return "owner_local_only" as const;
    const [u] = await tx.insert(users).values({ email: data.email, name: data.name, passwordHash, role: first ? "admin" : "user" }).returning({ id: users.id });
    await tx.insert(profiles).values({ userId: u.id, displayName: data.name });
    await tx.insert(userSettings).values({ userId: u.id });
    return u;
  });
  if (!result) throw new AppError("email_taken", "An account with this email already exists. Try signing in.", 409);
  if (result === "owner_local_only") throw new AppError("owner_local_only", "Create the owner account on the computer running WHITE-LOTUS (open http://127.0.0.1:3000 there). After that you can sign in from your phone.", 403);
  if (result === "owner_exists") throw new AppError("owner_exists", "This personal WHITE-LOTUS already has its owner account. Sign in instead.", 403);

  const token = await issueToken("verify", data.email);
  const link = `${env.APP_URL}/api/auth/verify-email?token=${token}`;
  const sent = await sendMail({
    to: data.email,
    subject: "Verify your WHITE-LOTUS email",
    text: `Welcome to WHITE-LOTUS.\n\nConfirm your email address with this link (valid 24 hours):\n${link}`,
    html: simpleHtml("Welcome to WHITE-LOTUS.\n\nConfirm your email address (link valid for 24 hours).", { href: link, label: "Verify email" }),
  });
  return NextResponse.json({ ok: true, verificationEmailSent: sent, verificationRequired: env.AUTH_REQUIRE_EMAIL_VERIFICATION }, { status: 201 });
});
