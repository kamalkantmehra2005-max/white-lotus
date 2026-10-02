import "server-only";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { memories, userSettings } from "@/lib/database/schema";
import { Errors } from "@/lib/errors";
import { decrypt, encrypt, encryptNullable } from "@/lib/security/encryption";

/** User-controlled long-term memory. Users can view, edit, delete, and disable it at any time. */

import { isSensitiveMemory } from "./sensitive";
export { isSensitiveMemory };

type SettingsRow = typeof userSettings.$inferSelect;
const aad = (userId: string, field: string) => `${userId}:${field}`;
const decryptSettings = (s: SettingsRow): SettingsRow => ({
  ...s,
  customInstructions: s.customInstructions ? decrypt(s.customInstructions, aad(s.userId, "ci")) : s.customInstructions,
  responseStyle: s.responseStyle ? decrypt(s.responseStyle, aad(s.userId, "rs")) : s.responseStyle,
});
const decryptMemory = <T extends { content: string; userId: string }>(m: T): T => ({ ...m, content: decrypt(m.content, aad(m.userId, "mem")) });

/** Settings with sensitive free-text fields decrypted. */
export async function getSettings(userId: string): Promise<SettingsRow> {
  const [s] = await db.select().from(userSettings).where(eq(userSettings.userId, userId)).limit(1);
  if (s) return decryptSettings(s);
  const [created] = await db.insert(userSettings).values({ userId }).onConflictDoNothing().returning();
  return decryptSettings(created ?? (await db.select().from(userSettings).where(eq(userSettings.userId, userId)).limit(1))[0]);
}

export async function updateSettings(userId: string, patch: Partial<Omit<SettingsRow, "id" | "userId" | "createdAt" | "updatedAt">>) {
  await getSettings(userId);
  const values = { ...patch };
  if ("customInstructions" in patch) values.customInstructions = encryptNullable(patch.customInstructions, aad(userId, "ci"));
  if ("responseStyle" in patch) values.responseStyle = encryptNullable(patch.responseStyle, aad(userId, "rs"));
  if (Object.keys(values).length) await db.update(userSettings).set(values).where(eq(userSettings.userId, userId));
  return getSettings(userId);
}

export async function listMemories(userId: string, projectId?: string | null) {
  const scope = projectId
    ? or(and(eq(memories.scope, "user"), isNull(memories.projectId)), eq(memories.projectId, projectId))
    : and(eq(memories.scope, "user"), isNull(memories.projectId));
  const rows = await db.select().from(memories).where(and(eq(memories.userId, userId), scope)).orderBy(desc(memories.updatedAt)).limit(200);
  return rows.map(decryptMemory);
}

export async function listAllMemories(userId: string) {
  const rows = await db.select().from(memories).where(eq(memories.userId, userId)).orderBy(desc(memories.updatedAt)).limit(500);
  return rows.map(decryptMemory);
}

export async function listProjectMemories(userId: string, projectId: string) {
  const rows = await db.select().from(memories).where(and(eq(memories.userId, userId), eq(memories.projectId, projectId))).orderBy(desc(memories.updatedAt));
  return rows.map(decryptMemory);
}

export async function createMemory(userId: string, content: string, projectId?: string | null, source: "user" | "assistant" = "user") {
  if (isSensitiveMemory(content)) throw Errors.invalid("For your safety, sensitive information like passwords or card numbers can't be saved to memory.");
  const text = content.slice(0, 1000);
  const [m] = await db
    .insert(memories)
    .values({ userId, content: encrypt(text, aad(userId, "mem")), projectId: projectId ?? null, scope: projectId ? "project" : "user", source })
    .returning();
  return { ...m, content: text };
}

export async function updateMemory(userId: string, id: string, content: string) {
  if (isSensitiveMemory(content)) throw Errors.invalid("Sensitive information can't be saved to memory.");
  const text = content.slice(0, 1000);
  const [m] = await db.update(memories).set({ content: encrypt(text, aad(userId, "mem")) }).where(and(eq(memories.id, id), eq(memories.userId, userId))).returning();
  if (!m) throw Errors.notFound("Memory");
  return { ...m, content: text };
}

export async function deleteMemory(userId: string, id: string) {
  const r = await db.delete(memories).where(and(eq(memories.id, id), eq(memories.userId, userId))).returning({ id: memories.id });
  if (!r.length) throw Errors.notFound("Memory");
}

export async function clearMemories(userId: string) {
  await db.delete(memories).where(eq(memories.userId, userId));
}
