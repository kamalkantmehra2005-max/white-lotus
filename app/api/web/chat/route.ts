import { z } from "zod";
import { env } from "@/config/env";
import { MODES } from "@/lib/ai/modes";
import { loadModelOverrides } from "@/lib/ai/registry";
import { encodeEvent, type ChatStreamEvent } from "@/lib/chat/protocol";
import { Errors, handle, toPublicError } from "@/lib/errors";
import { logger } from "@/lib/observability/logger";
import { clientIp, enforceRateLimit, rateLimit } from "@/lib/security/rate-limit";
import { assertQuota, getLimits, recordUsage } from "@/lib/usage/quotas";
import { assertCloud, optionalAccount } from "@/lib/web/http";
import { runWebTurn } from "@/lib/web/turn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_IMAGE_B64 = 1_500_000; // per image (~1.1 MB); the browser downsizes photos before sending

const body = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(100_000) }))
    .min(1)
    .max(200),
  images: z.array(z.object({ mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]), data: z.string().max(MAX_IMAGE_B64) })).max(3).default([]),
  files: z.array(z.object({ name: z.string().max(200), text: z.string().max(400_000) })).max(5).default([]),
  mode: z.enum(Object.keys(MODES) as [string, ...string[]]).default("quick"),
  model: z.string().max(200).nullish(),
  webSearch: z.boolean().default(false),
  deepResearch: z.boolean().default(false),
  customInstructions: z.string().max(4000).nullish(),
  timezone: z.string().max(64).regex(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/).nullish(),
  wantTitle: z.boolean().default(false),
});

/**
 * Online edition chat. Nothing is stored: the conversation comes from the browser and the answer is streamed back.
 * Signed-in users count against their account limits; "without account" visitors against a per-network limit.
 */
export const POST = handle(async (req: Request) => {
  await assertCloud();
  const input = body.parse(await req.json());
  const user = await optionalAccount();
  const [limits] = await Promise.all([getLimits(), loadModelOverrides()]);
  const ip = clientIp(req);
  let allowSearch = true;
  if (user) {
    if (user.role !== "admin") await enforceRateLimit(`chat:${user.id}`, limits.perMinute, 60);
    await assertQuota(user.id, "message", user.role);
    if (input.webSearch || input.deepResearch) allowSearch = await assertQuota(user.id, "search", user.role).then(() => true, () => false);
  } else {
    await enforceRateLimit(`webguest:min:${ip}`, env.WEB_GUEST_PER_MINUTE, 60);
    const day = await rateLimit(`webguest:day:${ip}`, env.WEB_GUEST_DAILY_MESSAGES, 86_400);
    if (!day.allowed) throw Errors.quota("message (without an account)");
    if (input.webSearch || input.deepResearch) allowSearch = (await rateLimit(`webguest:search:${ip}`, env.WEB_GUEST_DAILY_SEARCHES, 86_400)).allowed;
    if (input.deepResearch) input.deepResearch = false; // deep research needs an account
  }

  const controller = new AbortController();
  req.signal.addEventListener("abort", () => controller.abort());
  const stream = new ReadableStream<Uint8Array>({
    async start(c) {
      const emit = (e: ChatStreamEvent) => {
        try {
          c.enqueue(encodeEvent(e));
        } catch {
          /* client went away */
        }
      };
      const started = Date.now();
      try {
        const r = await runWebTurn(
          {
            ...input,
            userName: user?.name ?? null,
            allowSearch,
            maxContextTokens: limits.maxContextTokens,
            maxOutputTokens: limits.maxOutputTokens,
            signal: controller.signal,
          },
          emit,
        );
        if (user) {
          // Counts only (model, tokens, timing) — never content.
          await recordUsage({ userId: user.id, kind: "message", model: r.model, provider: r.provider, inputTokens: r.inputTokens, outputTokens: r.outputTokens, latencyMs: Date.now() - started, success: true }).catch(() => {});
          if (r.searched) await recordUsage({ userId: user.id, kind: "search", provider: "web", success: true }).catch(() => {});
        }
      } catch (e) {
        const pe = toPublicError(e);
        if (pe.status >= 500) logger.error("web.chat_failed", { error: e });
        emit({ type: "error", code: pe.code, message: pe.message, retryable: pe.retryable });
      } finally {
        c.close();
      }
    },
    cancel() {
      controller.abort();
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
});
