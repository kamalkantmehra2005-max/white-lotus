import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/database/client";
import { users } from "@/lib/database/schema";
import { Errors, handle } from "@/lib/errors";
import { logger } from "@/lib/observability/logger";
import { revokeAllSessions } from "@/lib/security/sessions";

export const runtime = "nodejs";
type Ctx = { params: Promise<{ id: string }> };

const schema = z.object({ blocked: z.boolean().optional(), blockedReason: z.string().max(300).nullish(), role: z.enum(["user", "admin"]).optional() }).strict();

export const PATCH = handle(async (req: Request, { params }: Ctx) => {
  const admin = await requireAdmin();
  const { id } = await params;
  const data = schema.parse(await req.json());
  if (id === admin.id && (data.blocked || data.role === "user")) throw Errors.invalid("You can't block or demote yourself.");
  const [u] = await db.update(users).set(data).where(eq(users.id, id)).returning({ id: users.id, blocked: users.blocked, role: users.role });
  if (!u) throw Errors.notFound("User");
  if (data.blocked || data.role === "user") await revokeAllSessions(id, data.blocked ? "blocked_by_admin" : "role_changed");
  logger.info("admin.user_updated", { adminId: admin.id, targetId: id, changes: Object.keys(data) });
  return NextResponse.json({ user: u });
});
