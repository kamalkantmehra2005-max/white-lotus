import "server-only";
import { sql } from "drizzle-orm";
import { db, rowsOf } from "@/lib/database/client";
import { Errors } from "@/lib/errors";

/**
 * Fixed-window rate limiter backed by Postgres (works across multiple instances with no Redis).
 * One atomic UPSERT per check. Swap for Redis/Upstash at very high scale — the interface stays the same.
 */
export type RateLimitResult = { allowed: boolean; remaining: number; resetAt: Date };

export async function rateLimit(key: string, limit: number, windowSec: number): Promise<RateLimitResult> {
  if (limit <= 0) return { allowed: true, remaining: Number.POSITIVE_INFINITY, resetAt: new Date() };
  const rows = await db.execute<{ count: number; reset_at: Date }>(sql`
    insert into rate_limit_buckets (key, count, reset_at)
    values (${key}, 1, now() + make_interval(secs => ${windowSec}))
    on conflict (key) do update set
      count = case when rate_limit_buckets.reset_at <= now() then 1 else rate_limit_buckets.count + 1 end,
      reset_at = case when rate_limit_buckets.reset_at <= now() then now() + make_interval(secs => ${windowSec}) else rate_limit_buckets.reset_at end
    returning count, reset_at
  `);
  const row = rowsOf<{ count: number; reset_at: Date }>(rows)[0];
  if (Math.random() < 0.01) void pruneRateLimits().catch(() => {}); // keep the table small without a cron
  const count = Number(row.count);
  return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetAt: new Date(row.reset_at) };
}

export async function enforceRateLimit(key: string, limit: number, windowSec: number) {
  const r = await rateLimit(key, limit, windowSec);
  if (!r.allowed) throw Errors.rateLimited(Math.max(1, Math.ceil((r.resetAt.getTime() - Date.now()) / 1000)));
  return r;
}

/** Periodic cleanup (called opportunistically). */
export async function pruneRateLimits() {
  await db.execute(sql`delete from rate_limit_buckets where reset_at < now() - interval '1 hour'`);
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return (fwd?.split(",")[0] ?? req.headers.get("x-real-ip") ?? "unknown").trim().slice(0, 64);
}
