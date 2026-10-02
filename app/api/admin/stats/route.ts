import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { adminOverview } from "@/lib/admin/stats";
import { handle } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  await requireAdmin();
  return NextResponse.json(await adminOverview());
});
