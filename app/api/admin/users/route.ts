import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { hashPassword, passwordSchema } from "@/lib/auth/password";
import { db } from "@/lib/database/client";
import { profiles, userSettings, users } from "@/lib/database/schema";
import { logger } from "@/lib/observability/logger";
import { isCloud } from "@/lib/edition";
import { adminUsers } from "@/lib/admin/stats";
import { AppError, handle } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handle(async (req: Request) => {
  await requireAdmin();
  const q = new URL(req.url).searchParams.get("q")?.slice(0, 100) || undefined;
  return NextResponse.json({ users: await adminUsers(q) });
});

const createSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  email: z.string().trim().toLowerCase().email("Enter a valid email").max(254),
  password: passwordSchema,
  role: z.enum(["user", "admin"]).default("user"),
}).strict();

/** The owner adds an account (sign-up stays closed on a personal install). The new user shares this computer's data folder. */
export const POST = handle(async (req: Request) => {
  const admin = await requireAdmin();
  // Online edition accounts are end-to-end encrypted: only the person can create theirs (in the web app).
  if (isCloud()) throw new AppError("not_available", "In the online edition people create their own account at /app.", 400);
  const data = createSchema.parse(await req.json());
  const passwordHash = await hashPassword(data.password);
  const created = await db.transaction(async (tx) => {
    const [existing] = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${data.email}`).limit(1);
    if (existing) return null;
    const [u] = await tx.insert(users).values({ email: data.email, name: data.name, passwordHash, role: data.role, emailVerified: new Date() }).returning({ id: users.id });
    await tx.insert(profiles).values({ userId: u.id, displayName: data.name });
    await tx.insert(userSettings).values({ userId: u.id });
    return u;
  });
  if (!created) throw new AppError("email_taken", "An account with this email already exists.", 409);
  logger.info("admin.user_created", { adminId: admin.id, targetId: created.id, role: data.role });
  return NextResponse.json({ user: created }, { status: 201 });
});
