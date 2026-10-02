import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/database/client";
import { systemSettings } from "@/lib/database/schema";
import { handle } from "@/lib/errors";
import { getLimits, invalidateLimitsCache } from "@/lib/usage/quotas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const n = z.number().int().min(0).max(1_000_000);
const schema = z
  .object({ dailyMessages: n, dailySearches: n, dailyUploads: n, fileLimit: n, maxUploadMb: z.number().int().min(1).max(500), maxContextTokens: z.number().int().min(2000).max(2_000_000), maxOutputTokens: z.number().int().min(256).max(200_000), perMinute: n })
  .partial()
  .strict();

export const GET = handle(async () => {
  await requireAdmin();
  return NextResponse.json({ limits: await getLimits() });
});

export const PUT = handle(async (req: Request) => {
  await requireAdmin();
  const value = schema.parse(await req.json());
  await db.insert(systemSettings).values({ key: "limits", value }).onConflictDoUpdate({ target: systemSettings.key, set: { value } });
  invalidateLimitsCache();
  return NextResponse.json({ limits: await getLimits() });
});
