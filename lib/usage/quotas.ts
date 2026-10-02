import "server-only";
import { and, count, eq, gte, sql } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { attachments, systemSettings, usageRecords, users } from "@/lib/database/schema";
import { env } from "@/config/env";
import { Errors } from "@/lib/errors";

export type Limits = {
  dailyMessages: number;
  dailySearches: number;
  dailyUploads: number;
  fileLimit: number;
  maxUploadMb: number;
  maxContextTokens: number;
  maxOutputTokens: number;
  perMinute: number;
};

/** Env defaults, overridable at runtime by admins via system_settings.key = 'limits'. 0 = unlimited. */
let limitsCache: { at: number; value: Limits } | undefined;
export function invalidateLimitsCache() {
  limitsCache = undefined;
}

export async function getLimits(): Promise<Limits> {
  if (limitsCache && Date.now() - limitsCache.at < 30_000) return limitsCache.value;
  const value = await loadLimits();
  limitsCache = { at: Date.now(), value };
  return value;
}

async function loadLimits(): Promise<Limits> {
  const base: Limits = {
    dailyMessages: env.FREE_DAILY_MESSAGES,
    dailySearches: env.FREE_DAILY_SEARCHES,
    dailyUploads: env.FREE_DAILY_UPLOADS,
    fileLimit: env.FREE_FILE_LIMIT,
    maxUploadMb: env.MAX_UPLOAD_SIZE_MB,
    maxContextTokens: env.MAX_CONTEXT_TOKENS,
    maxOutputTokens: env.MAX_OUTPUT_TOKENS,
    perMinute: env.RATE_LIMIT_PER_MINUTE,
  };
  try {
    const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, "limits")).limit(1);
    if (row?.value && typeof row.value === "object") return { ...base, ...(row.value as Partial<Limits>) };
  } catch {
    /* fall back to env */
  }
  return base;
}

function startOfUtcDay() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export async function usedToday(userId: string, kind: "message" | "search" | "upload" | "tool") {
  const [r] = await db
    .select({ n: count() })
    .from(usageRecords)
    .where(and(eq(usageRecords.userId, userId), eq(usageRecords.kind, kind), gte(usageRecords.createdAt, startOfUtcDay())));
  return Number(r?.n ?? 0);
}

/** Guests (ALLOW_GUEST_CHAT) get their own, stricter limits and no uploads. Resolved server-side, never from the client. */
async function isGuest(userId: string) {
  const [r] = await db.select({ g: users.isGuest }).from(users).where(eq(users.id, userId)).limit(1);
  return Boolean(r?.g);
}

export async function limitsFor(userId: string): Promise<Limits> {
  const limits = await getLimits();
  if (!(await isGuest(userId))) return limits;
  return { ...limits, dailyMessages: env.GUEST_DAILY_MESSAGES, dailySearches: env.GUEST_DAILY_SEARCHES, dailyUploads: 0, fileLimit: 0 };
}

export async function assertQuota(userId: string, kind: "message" | "search" | "upload", role: "user" | "admin") {
  if (role === "admin") return;
  const limits = await limitsFor(userId);
  if (kind === "upload" && (await isGuest(userId))) throw Errors.accountRequired("File uploads");
  const limit = kind === "message" ? limits.dailyMessages : kind === "search" ? limits.dailySearches : limits.dailyUploads;
  if (limit > 0 && (await usedToday(userId, kind)) >= limit) {
    throw Errors.quota(kind === "message" ? "message" : kind === "search" ? "web search" : "upload");
  }
  if (kind === "upload" && limits.fileLimit > 0) {
    const [r] = await db.select({ n: count() }).from(attachments).where(eq(attachments.userId, userId));
    if (Number(r?.n ?? 0) >= limits.fileLimit) throw Errors.quota("stored file");
  }
}

export async function recordUsage(rec: typeof usageRecords.$inferInsert) {
  await db.insert(usageRecords).values(rec);
}

export async function usageSummary(userId: string) {
  const limits = await limitsFor(userId);
  const rows = await db
    .select({ kind: usageRecords.kind, n: count() })
    .from(usageRecords)
    .where(and(eq(usageRecords.userId, userId), gte(usageRecords.createdAt, startOfUtcDay())))
    .groupBy(usageRecords.kind);
  const m = Object.fromEntries(rows.map((r) => [r.kind, Number(r.n)]));
  return {
    messages: { used: m.message ?? 0, limit: limits.dailyMessages },
    searches: { used: m.search ?? 0, limit: limits.dailySearches },
    uploads: { used: m.upload ?? 0, limit: limits.dailyUploads },
    resetsAt: new Date(startOfUtcDay().getTime() + 86_400_000).toISOString(),
  };
}

export { sql };
