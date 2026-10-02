import "server-only";
import { and, asc, desc, eq, gt, gte, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { attachments, conversations, messages, projects, type MessageMetadata } from "@/lib/database/schema";
import { Errors } from "@/lib/errors";
import { blindTokens, decryptJson, decryptOr, encrypt, encryptJson } from "@/lib/security/encryption";
import { AAD } from "@/lib/security/fields";

/**
 * All conversation/message access goes through here and is ALWAYS scoped to the owner.
 * Confidential fields (titles, message content, message metadata) are AES-256-GCM encrypted at rest;
 * search uses the keyed blind index (messages.search_tokens), never plaintext.
 */

type ConvRow = typeof conversations.$inferSelect;
const decryptConv = <T extends Pick<ConvRow, "title" | "userId">>(c: T): T => ({ ...c, title: decryptOr(c.title, AAD.title(c.userId), "Untitled") });

/** ARRAY['a','b']::text[] with each element parameterised. */
export function textArray(values: string[]): SQL {
  if (!values.length) return sql`'{}'::text[]`;
  return sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;
}

export async function listConversations(userId: string, opts: { q?: string; archived?: boolean; projectId?: string | null; limit?: number } = {}) {
  const where = [eq(conversations.userId, userId), eq(conversations.archived, opts.archived ?? false)];
  if (opts.projectId !== undefined) where.push(opts.projectId === null ? isNull(conversations.projectId) : eq(conversations.projectId, opts.projectId));
  const limit = Math.min(opts.limit ?? 100, 200);
  const q = opts.q?.trim().slice(0, 200);

  const rows = await db
    .select({
      id: conversations.id,
      userId: conversations.userId,
      title: conversations.title,
      mode: conversations.mode,
      projectId: conversations.projectId,
      pinned: conversations.pinned,
      archived: conversations.archived,
      updatedAt: conversations.updatedAt,
    })
    .from(conversations)
    .where(and(...where))
    .orderBy(desc(conversations.pinned), desc(conversations.updatedAt))
    .limit(q ? 1000 : limit);

  let list = rows.map(decryptConv);
  if (q) {
    // Titles are encrypted: match them after decryption (owner's rows only). Message bodies: blind-index containment.
    const needle = q.toLowerCase();
    const tokens = blindTokens(q, 12);
    const bodyHits = new Set<string>();
    if (tokens.length && rows.length) {
      const hits = await db
        .selectDistinct({ id: messages.conversationId })
        .from(messages)
        .where(and(inArray(messages.conversationId, rows.map((r) => r.id)), sql`${messages.searchTokens} @> ${textArray(tokens)}`));
      for (const h of hits) bodyHits.add(h.id);
    }
    list = list.filter((c) => c.title.toLowerCase().includes(needle) || bodyHits.has(c.id)).slice(0, limit);
  }
  return list.map((c) => ({ id: c.id, title: c.title, mode: c.mode, projectId: c.projectId, pinned: c.pinned, archived: c.archived, updatedAt: c.updatedAt }));
}

export async function getConversation(userId: string, id: string) {
  const [c] = await db.select().from(conversations).where(and(eq(conversations.id, id), eq(conversations.userId, userId))).limit(1);
  if (!c) throw Errors.notFound("Conversation");
  return decryptConv(c);
}

export type StoredMessage = { id: string; role: "system" | "user" | "assistant" | "tool"; content: string; metadata: MessageMetadata; model: string | null; createdAt: Date };

/** Decrypt a message row. The conversation id is part of the AAD, so a row moved to another conversation won't decrypt. */
export function openMessage(m: { id: string; conversationId: string; role: StoredMessage["role"]; content: string; metadata: unknown; model?: string | null; createdAt: Date }): StoredMessage {
  return {
    id: m.id,
    role: m.role,
    content: decryptOr(m.content, AAD.message(m.conversationId)),
    metadata: decryptJson<MessageMetadata>(m.metadata, AAD.messageMeta(m.conversationId)),
    model: m.model ?? null,
    createdAt: m.createdAt,
  };
}

export async function getConversationWithMessages(userId: string, id: string) {
  const c = await getConversation(userId, id);
  const msgs = (
    await db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, id), inArray(messages.role, ["user", "assistant"])))
      .orderBy(asc(messages.createdAt))
  ).map(openMessage);
  const atts = msgs.length
    ? await db
        .select({ id: attachments.id, messageId: attachments.messageId, fileName: attachments.fileName, mimeType: attachments.mimeType, kind: attachments.kind, sizeBytes: attachments.sizeBytes, scanStatus: attachments.scanStatus })
        .from(attachments)
        .where(and(eq(attachments.userId, userId), inArray(attachments.messageId, msgs.map((m) => m.id))))
    : [];
  return {
    ...c,
    messages: msgs.map((m) => ({
      ...m,
      attachments: atts.filter((a) => a.messageId === m.id).map((a) => ({ ...a, fileName: decryptOr(a.fileName, AAD.file(userId), "file") })),
    })),
  };
}

export async function createConversation(userId: string, data: { title?: string; mode?: string; model?: string | null; projectId?: string | null }) {
  if (data.projectId) await assertProjectAccess(userId, data.projectId);
  const title = data.title?.slice(0, 200) || "New chat";
  const [c] = await db
    .insert(conversations)
    .values({ userId, title: encrypt(title, AAD.title(userId)), mode: data.mode ?? "quick", model: data.model ?? null, projectId: data.projectId ?? null })
    .returning();
  return { ...c, title };
}

export async function updateConversation(
  userId: string,
  id: string,
  patch: Partial<{ title: string; archived: boolean; pinned: boolean; projectId: string | null; mode: string; model: string | null }>,
) {
  if (patch.projectId) await assertProjectAccess(userId, patch.projectId);
  const { title, ...rest } = patch;
  const [c] = await db
    .update(conversations)
    .set({ ...rest, ...(title ? { title: encrypt(title.slice(0, 200), AAD.title(userId)) } : {}) })
    .where(and(eq(conversations.id, id), eq(conversations.userId, userId)))
    .returning();
  if (!c) throw Errors.notFound("Conversation");
  return decryptConv(c);
}

export async function setConversationTitle(userId: string, id: string, title: string) {
  await db
    .update(conversations)
    .set({ title: encrypt(title.slice(0, 200), AAD.title(userId)) })
    .where(and(eq(conversations.id, id), eq(conversations.userId, userId)));
}

export async function deleteConversation(userId: string, id: string) {
  const r = await db.delete(conversations).where(and(eq(conversations.id, id), eq(conversations.userId, userId))).returning({ id: conversations.id });
  if (!r.length) throw Errors.notFound("Conversation");
}

export async function assertProjectAccess(userId: string, projectId: string) {
  const [p] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), eq(projects.ownerId, userId))).limit(1);
  if (!p) throw Errors.notFound("Project");
}

type MessageWrite = { content?: string; metadata?: MessageMetadata; model?: string; provider?: string; inputTokens?: number; outputTokens?: number; latencyMs?: number };

/** Encrypted column values + blind-index tokens for a message write. */
function sealMessage(conversationId: string, m: MessageWrite) {
  return {
    ...(m.content !== undefined ? { content: encrypt(m.content, AAD.message(conversationId)), searchTokens: blindTokens(m.content) } : {}),
    ...(m.metadata !== undefined ? { metadata: encryptJson(m.metadata, AAD.messageMeta(conversationId)) as MessageMetadata } : {}),
    ...(m.model !== undefined ? { model: m.model } : {}),
    ...(m.provider !== undefined ? { provider: m.provider } : {}),
    ...(m.inputTokens !== undefined ? { inputTokens: m.inputTokens } : {}),
    ...(m.outputTokens !== undefined ? { outputTokens: m.outputTokens } : {}),
    ...(m.latencyMs !== undefined ? { latencyMs: m.latencyMs } : {}),
  };
}

/** Caller must already have verified that the conversation belongs to the user. */
export async function addMessage(conversationId: string, m: MessageWrite & { role: "user" | "assistant"; content: string }) {
  const [row] = await db
    .insert(messages)
    .values({ conversationId, role: m.role, content: "", metadata: {}, ...sealMessage(conversationId, { ...m, metadata: m.metadata ?? {} }) })
    .returning();
  await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, conversationId));
  return openMessage(row);
}

/** Update a message inside a conversation (content/metadata re-encrypted). Scoped by conversation id. */
export async function updateMessage(conversationId: string, messageId: string, m: MessageWrite) {
  await db
    .update(messages)
    .set(sealMessage(conversationId, m))
    .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)));
}

export async function getMessage(conversationId: string, messageId: string, role?: "user" | "assistant") {
  const [m] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId), ...(role ? [eq(messages.role, role)] : [])))
    .limit(1);
  return m ? openMessage(m) : null;
}

export async function lastUserMessage(conversationId: string) {
  const [m] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "user")))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return m ? openMessage(m) : null;
}

/** Delete all messages after (and optionally including) a given message — used by edit & regenerate. */
export async function truncateAfter(conversationId: string, messageId: string, inclusive: boolean) {
  const [pivot] = await db.select({ createdAt: messages.createdAt }).from(messages).where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId))).limit(1);
  if (!pivot) throw Errors.notFound("Message");
  await db
    .delete(messages)
    .where(and(eq(messages.conversationId, conversationId), inclusive ? gte(messages.createdAt, pivot.createdAt) : gt(messages.createdAt, pivot.createdAt)));
}

/** Caller must already have verified ownership of the conversation. */
export async function historyForModel(conversationId: string) {
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), inArray(messages.role, ["user", "assistant"])))
    .orderBy(asc(messages.createdAt));
  return rows.map(openMessage).map((m) => ({ id: m.id, role: m.role, content: m.content, metadata: m.metadata }));
}

export async function conversationDocumentIds(userId: string, conversationId: string) {
  const rows = await db
    .select({ documentId: attachments.documentId })
    .from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .where(and(eq(attachments.userId, userId), eq(messages.conversationId, conversationId)));
  return [...new Set(rows.map((r) => r.documentId).filter((d): d is string => Boolean(d)))];
}

/** Related past conversations (conversation memory): blind-index overlap on earlier answers, owner only. */
export async function relatedPastConversations(userId: string, excludeConversationId: string, query: string, limit = 3) {
  const tokens = blindTokens(query, 12);
  if (!tokens.length) return [];
  const arr = textArray(tokens);
  const rows = await db
    .select({ id: messages.id, conversationId: messages.conversationId, role: messages.role, content: messages.content, metadata: messages.metadata, createdAt: messages.createdAt, title: conversations.title })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(eq(conversations.userId, userId), sql`${conversations.id} <> ${excludeConversationId}`, eq(messages.role, "assistant"), sql`${messages.searchTokens} && ${arr}`))
    .orderBy(sql`cardinality(array(select unnest(${messages.searchTokens}) intersect select unnest(${arr}))) desc`)
    .limit(limit)
    .catch(() => []);
  return rows.map((r) => {
    const m = openMessage(r);
    const title = decryptOr(r.title, AAD.title(userId), "Untitled");
    return `- "${title}" (${r.createdAt.toISOString().slice(0, 10)}): ${m.content.slice(0, 400).replace(/\s+/g, " ")}`;
  });
}
