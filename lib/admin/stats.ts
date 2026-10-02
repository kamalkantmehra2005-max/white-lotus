import "server-only";
import { and, count, desc, eq, gte, ilike, or, sql, sum } from "drizzle-orm";
import { db, pingDatabase, rowsOf } from "@/lib/database/client";
import { conversations, errorLogs, messages, toolCalls, usageRecords, users } from "@/lib/database/schema";
import { listModels } from "@/lib/ai/registry";
import { configuredSearchProviders } from "@/lib/search/providers";
import { getLimits } from "@/lib/usage/quotas";

/** Admin analytics. Deliberately returns METADATA only — never message content. */
export async function adminOverview() {
  const since24h = new Date(Date.now() - 86_400_000);
  const since7d = new Date(Date.now() - 7 * 86_400_000);
  const [[u], [c], [m], [active], byModel, errors24h, toolStats, daily, dbOk, limits, recentErrors] = await Promise.all([
    db.select({ n: sql<number>`count(*) filter (where not ${users.isGuest})`, blocked: sql<number>`count(*) filter (where ${users.blocked})`, guests: sql<number>`count(*) filter (where ${users.isGuest})` }).from(users),
    db.select({ n: count() }).from(conversations),
    db.select({ n: count() }).from(messages),
    db.select({ n: sql<number>`count(distinct ${usageRecords.userId})` }).from(usageRecords).where(gte(usageRecords.createdAt, since24h)),
    db
      .select({
        model: usageRecords.model,
        requests: count(),
        inputTokens: sum(usageRecords.inputTokens),
        outputTokens: sum(usageRecords.outputTokens),
        avgLatencyMs: sql<number>`round(avg(${usageRecords.latencyMs}))`,
        failures: sql<number>`count(*) filter (where not ${usageRecords.success})`,
      })
      .from(usageRecords)
      .where(and(eq(usageRecords.kind, "message"), gte(usageRecords.createdAt, since7d)))
      .groupBy(usageRecords.model)
      .orderBy(desc(count())),
    db
      .select({ code: usageRecords.errorCode, n: count() })
      .from(usageRecords)
      .where(and(eq(usageRecords.success, false), gte(usageRecords.createdAt, since24h)))
      .groupBy(usageRecords.errorCode),
    db
      .select({
        tool: toolCalls.toolName,
        calls: count(),
        avgMs: sql<number>`round(avg(${toolCalls.durationMs}))`,
        failures: sql<number>`count(*) filter (where not ${toolCalls.success})`,
      })
      .from(toolCalls)
      .where(gte(toolCalls.createdAt, since7d))
      .groupBy(toolCalls.toolName),
    db.execute<{ day: string; messages: number; searches: number }>(sql`
      select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day,
        count(*) filter (where kind = 'message')::int as messages,
        count(*) filter (where kind = 'search')::int as searches
      from usage_records where created_at >= ${since7d.toISOString()}::timestamptz group by 1 order by 1`),
    pingDatabase(),
    getLimits(),
    db.select().from(errorLogs).orderBy(desc(errorLogs.createdAt)).limit(20),
  ]);
  return {
    totals: {
      users: Number(u.n),
      guests: Number(u.guests),
      blockedUsers: Number(u.blocked),
      conversations: Number(c.n),
      messages: Number(m.n),
      activeUsers24h: Number(active.n),
    },
    byModel,
    errors24h,
    recentErrors,
    toolStats,
    daily: rowsOf<{ day: string; messages: number; searches: number }>(daily),
    health: {
      database: dbOk,
      models: listModels().map((x) => x.id),
      searchProviders: configuredSearchProviders().map((p) => p.id),
      uptimeSec: Math.round(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      node: process.version,
    },
    limits,
  };
}

export async function adminUsers(q?: string, limit = 50) {
  const safe = q?.replace(/[%_\\]/g, (m) => `\\${m}`);
  // Guests are temporary and deleted automatically; they aren't listed as accounts.
  const where = and(eq(users.isGuest, false), safe ? or(ilike(users.email, `%${safe}%`), ilike(users.name, `%${safe}%`)) : undefined);
  return db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      blocked: users.blocked,
      createdAt: users.createdAt,
      lastActiveAt: users.lastActiveAt,
      conversations: sql<number>`(select count(*)::int from conversations c where c.user_id = ${users.id})`,
      messagesToday: sql<number>`(select count(*)::int from usage_records r where r.user_id = ${users.id} and r.kind = 'message' and r.created_at >= date_trunc('day', now()))`,
    })
    .from(users)
    .where(where)
    .orderBy(desc(users.createdAt))
    .limit(limit);
}
