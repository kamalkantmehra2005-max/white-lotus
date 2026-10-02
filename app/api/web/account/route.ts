import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireAccount } from "@/lib/auth";
import { verifyPassword } from "@/lib/auth/password";
import { db } from "@/lib/database/client";
import { users } from "@/lib/database/schema";
import { AppError, handle } from "@/lib/errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { assertCloud } from "@/lib/web/http";
import { AUTH_SECRET_RE } from "@/lib/web/kdf";

export const runtime = "nodejs";

/** Delete this account and every server-side row that belongs to it (sync copies, sessions, usage counts). */
export const DELETE = handle(async (req: Request) => {
  await assertCloud();
  const user = await requireAccount("Account");
  await enforceRateLimit(`delacct:${user.id}`, 5, 900);
  const { authSecret } = z.object({ authSecret: z.string().regex(AUTH_SECRET_RE) }).parse(await req.json());
  const [row] = await db.select({ hash: users.passwordHash, role: users.role }).from(users).where(eq(users.id, user.id)).limit(1);
  if (!row || !(await verifyPassword(authSecret, row.hash))) throw new AppError("bad_password", "That password isn't right.", 403);
  if (row.role === "admin") throw new AppError("owner_account", "The owner account can't delete itself here. Make another admin first, or remove it in the hosting database.", 403);
  await db.delete(users).where(eq(users.id, user.id));
  return NextResponse.json({ ok: true });
});
