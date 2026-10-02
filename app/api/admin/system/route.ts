import { NextResponse } from "next/server";
import { env } from "@/config/env";
import { requireAdmin } from "@/lib/auth";
import { handle } from "@/lib/errors";
import { isLoopbackRequest } from "@/lib/security/request-origin";
import { edition } from "@/lib/edition";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Remote-access status for the Admin page. No secrets are returned. */
export const GET = handle(async (req: Request) => {
  await requireAdmin();
  const appUrl = env.APP_URL;
  const remote = appUrl.startsWith("https://");
  return NextResponse.json({
    appUrl,
    edition: edition(),
    remoteAccess: remote ? (/\.ts\.net$/.test(new URL(appUrl).hostname) ? "tailscale" : "custom") : "off",
    viewingFrom: isLoopbackRequest(req.headers) ? "this computer" : "another device",
    singleUser: env.LOCAL_SINGLE_USER,
    offlineMode: env.LOCAL_OFFLINE_MODE,
    version: process.env.npm_package_version || "1.0.0",
  });
});
