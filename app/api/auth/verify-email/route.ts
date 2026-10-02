import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { env } from "@/config/env";
import { consumeToken } from "@/lib/auth/tokens";
import { db } from "@/lib/database/client";
import { users } from "@/lib/database/schema";
import { clientIp, enforceRateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Link target from the verification email. Redirects to /login with a status flag. */
export async function GET(req: Request) {
  const base = env.APP_URL;
  try {
    await enforceRateLimit(`verify:ip:${clientIp(req)}`, 20, 900);
    const token = new URL(req.url).searchParams.get("token") ?? "";
    const email = await consumeToken("verify", token);
    if (!email) return NextResponse.redirect(new URL("/login?verified=invalid", base));
    await db.update(users).set({ emailVerified: new Date() }).where(sql`lower(${users.email}) = ${email}`);
    return NextResponse.redirect(new URL("/login?verified=1", base));
  } catch {
    return NextResponse.redirect(new URL("/login?verified=invalid", base));
  }
}
