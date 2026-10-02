import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { searchHistory } from "@/lib/database/schema";
import { decryptOr, encrypt } from "@/lib/security/encryption";
import { AAD } from "@/lib/security/fields";

/** Local search history: stored in the on-device database, query text encrypted, always owner-scoped. */
export async function recordSearches(userId: string, conversationId: string | null, queries: string[]) {
  const clean = [...new Set(queries.map((q) => q.trim()).filter(Boolean))].slice(0, 20);
  if (!clean.length) return;
  await db.insert(searchHistory).values(clean.map((q) => ({ userId, conversationId, query: encrypt(q.slice(0, 500), AAD.search(userId)) })));
}

export async function listSearches(userId: string, limit = 200) {
  const rows = await db
    .select({ id: searchHistory.id, query: searchHistory.query, conversationId: searchHistory.conversationId, createdAt: searchHistory.createdAt })
    .from(searchHistory)
    .where(eq(searchHistory.userId, userId))
    .orderBy(desc(searchHistory.createdAt))
    .limit(Math.min(limit, 1000));
  return rows.map((r) => ({ ...r, query: decryptOr(r.query, AAD.search(userId), "[unreadable]") }));
}

export async function deleteSearches(userId: string, ids?: string[]) {
  const where = ids?.length ? and(eq(searchHistory.userId, userId), inArray(searchHistory.id, ids.slice(0, 500))) : eq(searchHistory.userId, userId);
  const r = await db.delete(searchHistory).where(where).returning({ id: searchHistory.id });
  return r.length;
}
