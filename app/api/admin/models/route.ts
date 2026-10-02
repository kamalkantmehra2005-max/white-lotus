import { NextResponse } from "next/server";
import { eq, ne } from "drizzle-orm";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { defaultModelId, listModels, loadModelOverrides } from "@/lib/ai/registry";
import { db } from "@/lib/database/client";
import { modelSettings } from "@/lib/database/schema";
import { Errors, handle } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Models the server can serve (provider configured), with the admin's enable/rename/default overrides. */
export const GET = handle(async () => {
  await requireAdmin();
  const o = await loadModelOverrides(true);
  const models = listModels({ includeDisabled: true }).map((m) => ({ ...m, enabled: o.get(m.id)?.enabled ?? true, isDefault: o.get(m.id)?.isDefault ?? false }));
  return NextResponse.json({ models, defaultModel: defaultModelId() });
});

const schema = z.object({
  modelId: z.string().min(3).max(200),
  enabled: z.boolean(),
  displayName: z.string().trim().min(1).max(80),
  isDefault: z.boolean().default(false),
});

export const PUT = handle(async (req: Request) => {
  await requireAdmin();
  const data = schema.parse(await req.json());
  if (!listModels({ includeDisabled: true }).some((m) => m.id === data.modelId)) throw Errors.invalid("That model isn't configured on this server.");
  if (data.isDefault && !data.enabled) throw Errors.invalid("The default model must be enabled.");
  await db.transaction(async (tx) => {
    if (data.isDefault) await tx.update(modelSettings).set({ isDefault: false }).where(ne(modelSettings.modelId, data.modelId));
    await tx
      .insert(modelSettings)
      .values(data)
      .onConflictDoUpdate({ target: modelSettings.modelId, set: { enabled: data.enabled, displayName: data.displayName, isDefault: data.isDefault } });
  });
  await loadModelOverrides(true);
  const [row] = await db.select().from(modelSettings).where(eq(modelSettings.modelId, data.modelId)).limit(1);
  return NextResponse.json({ model: row });
});
