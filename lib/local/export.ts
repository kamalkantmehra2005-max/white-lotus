import "server-only";
import { asc, eq, inArray } from "drizzle-orm";
import JSZip from "jszip";
import type { SessionUser } from "@/lib/auth";
import { openMessage } from "@/lib/chat/conversations";
import { db } from "@/lib/database/client";
import { attachments, conversations, messages, projects } from "@/lib/database/schema";
import { storage } from "@/lib/files/storage";
import { listSearches } from "@/lib/local/search-history";
import { getSettings, listAllMemories } from "@/lib/memory";
import { openProject } from "@/lib/projects";
import { decryptOr } from "@/lib/security/encryption";
import { AAD } from "@/lib/security/fields";

/** Everything stored for this account, decrypted — readable by you, portable to other tools. */
export async function buildExport(user: SessionUser) {
  const convs = await db.select().from(conversations).where(eq(conversations.userId, user.id)).orderBy(asc(conversations.createdAt));
  const msgs = convs.length
    ? (
        await db
          .select()
          .from(messages)
          .where(inArray(messages.conversationId, convs.map((c) => c.id)))
          .orderBy(asc(messages.createdAt))
      ).map((m) => ({ conversationId: m.conversationId, ...openMessage(m) }))
    : [];
  const [settings, mems, projs, files, searches] = await Promise.all([
    getSettings(user.id),
    listAllMemories(user.id),
    db.select().from(projects).where(eq(projects.ownerId, user.id)),
    db
      .select({ id: attachments.id, fileName: attachments.fileName, mimeType: attachments.mimeType, sizeBytes: attachments.sizeBytes, scanStatus: attachments.scanStatus, origin: attachments.origin, storageKey: attachments.storageKey, createdAt: attachments.createdAt })
      .from(attachments)
      .where(eq(attachments.userId, user.id)),
    listSearches(user.id, 1000),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    account: { name: user.name, email: user.email },
    settings: {
      theme: settings.theme,
      defaultModel: settings.defaultModel,
      defaultMode: settings.defaultMode,
      memoryEnabled: settings.memoryEnabled,
      webSearchDefault: settings.webSearchDefault,
      customInstructions: settings.customInstructions,
      responseStyle: settings.responseStyle,
    },
    memories: mems.map((m) => ({ content: m.content, scope: m.scope, source: m.source, createdAt: m.createdAt })),
    projects: projs.map(openProject).map((p) => ({ id: p.id, name: p.name, description: p.description, instructions: p.instructions, createdAt: p.createdAt })),
    searchHistory: searches.map((s) => ({ query: s.query, conversationId: s.conversationId, createdAt: s.createdAt })),
    files: files.map((f) => ({ id: f.id, fileName: decryptOr(f.fileName, AAD.file(user.id), "file"), mimeType: f.mimeType, sizeBytes: f.sizeBytes, scanStatus: f.scanStatus, origin: f.origin, storageKey: f.storageKey, createdAt: f.createdAt })),
    conversations: convs.map((c) => ({
      id: c.id,
      title: decryptOr(c.title, AAD.title(user.id), "Untitled"),
      mode: c.mode,
      projectId: c.projectId,
      createdAt: c.createdAt,
      messages: msgs.filter((m) => m.conversationId === c.id).map((m) => ({ role: m.role, content: m.content, metadata: m.metadata, model: m.model, createdAt: m.createdAt })),
    })),
  };
}

/** A file entry without its internal storage key. */
export function publicFile<T extends { storageKey?: string }>(f: T): Omit<T, "storageKey"> {
  const copy = { ...f };
  delete copy.storageKey;
  return copy;
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").slice(0, 120) || "file";

/** A readable ZIP: export.json, one Markdown file per conversation, and your files (decrypted). */
export async function buildExportZip(user: SessionUser): Promise<Buffer> {
  const data = await buildExport(user);
  const zip = new JSZip();
  const { files, ...rest } = data;
  zip.file("export.json", JSON.stringify({ ...rest, files: files.map(publicFile) }, null, 2));
  for (const c of data.conversations) {
    const md = [`# ${c.title}`, "", ...c.messages.map((m) => `## ${m.role === "user" ? "You" : "WHITE-LOTUS"} — ${new Date(m.createdAt).toISOString()}\n\n${m.content}\n`)].join("\n");
    zip.file(`conversations/${new Date(c.createdAt).toISOString().slice(0, 10)} ${safeName(c.title)} (${c.id.slice(0, 8)}).md`, md);
  }
  const used = new Set<string>();
  for (const f of files) {
    if (f.scanStatus !== "clean" && f.scanStatus !== "unscanned") continue;
    try {
      const buf = await storage().get(f.storageKey);
      let name = `${f.origin === "generated" ? "generated" : "uploads"}/${safeName(f.fileName)}`;
      if (used.has(name)) name = name.replace(/(\.[^.]*)?$/, ` (${f.id.slice(0, 6)})$1`);
      used.add(name);
      zip.file(name, buf);
    } catch {
      /* missing object — listed in export.json anyway */
    }
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
