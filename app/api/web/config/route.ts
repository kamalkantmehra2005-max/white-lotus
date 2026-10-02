import { NextResponse } from "next/server";
import { env } from "@/config/env";
import { defaultModelId, listModels, loadModelOverrides } from "@/lib/ai/registry";
import { ensureCloudMigrated } from "@/lib/database/cloud-migrate";
import { edition } from "@/lib/edition";
import { handle } from "@/lib/errors";
import { isSearchAvailable } from "@/lib/search/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public, non-secret configuration for the online web app. */
export const GET = handle(async () => {
  await ensureCloudMigrated(); // model overrides live in the database
  await loadModelOverrides();
  return NextResponse.json({
    edition: edition(),
    models: listModels().map((m) => ({ id: m.id, label: m.label, vision: m.capabilities.vision })),
    defaultModel: defaultModelId(),
    webSearch: isSearchAvailable(),
    signup: env.AUTH_ALLOW_SIGNUP,
    guest: { dailyMessages: env.WEB_GUEST_DAILY_MESSAGES, dailySearches: env.WEB_GUEST_DAILY_SEARCHES },
    maxUploadMb: Math.min(env.MAX_UPLOAD_SIZE_MB, 4),
  });
});
