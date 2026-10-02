import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { attachments, documentChunks, documents } from "@/lib/database/schema";
import { approxTokens } from "@/lib/ai/complete";
import { textArray } from "@/lib/chat/conversations";
import { logger, persistError } from "@/lib/observability/logger";
import { blindTokens, decryptOr, encrypt } from "@/lib/security/encryption";
import { AAD } from "@/lib/security/fields";
import { chunkText } from "./chunk";
import { extractText } from "./extract";
import { releasable, scanBuffer } from "./scan";
import { storage } from "./storage";
import { detectFileType, FileValidationError, sanitizeFileName } from "./validate";

/**
 * Upload pipeline (every file is untrusted):
 *
 *   validate (size, extension, magic bytes, safe name)
 *     → QUARANTINE  (private key q/<user>/<random>, not linked to any message, not downloadable, not given to the AI)
 *     → malware scan (ClamAV / external service / none — see lib/files/scan.ts)
 *     → clean (or unscanned when policy allows)  → move to private storage u/<user>/<random> → extract → encrypt → index
 *     → infected / scanner error (fail closed)   → object deleted, upload rejected, security event logged
 *
 * Confidential fields are encrypted at rest: file name, document title, extracted text chunks.
 * Retrieval uses the keyed blind index (document_chunks.search_tokens), never plaintext.
 */
export async function ingestUpload(params: { userId: string; fileName: string; buffer: Buffer; maxBytes: number; projectId?: string | null; origin?: "upload" | "generated" }) {
  const { userId, buffer, maxBytes } = params;
  const type = detectFileType(params.fileName, buffer, maxBytes);
  const fileName = sanitizeFileName(params.fileName);
  const objectId = crypto.randomUUID();
  const quarantineKey = `q/${userId}/${objectId}.${type.ext}`;
  const storageKey = `u/${userId}/${objectId}.${type.ext}`;
  const s = storage();

  // 1) Quarantine
  await s.put(quarantineKey, buffer, "application/octet-stream");
  const [att] = await db
    .insert(attachments)
    .values({ userId, fileName: encrypt(fileName, AAD.file(userId)), mimeType: type.mime, sizeBytes: buffer.length, storageKey: quarantineKey, kind: type.kind, scanStatus: "pending", origin: params.origin ?? "upload" })
    .returning();

  // 2) Scan
  const scan = await scanBuffer(buffer);
  if (!releasable(scan.status)) {
    await s.delete(quarantineKey).catch(() => {});
    await db.delete(attachments).where(eq(attachments.id, att.id));
    if (scan.status === "infected") {
      logger.warn("files.malware_detected", { userId, engine: scan.engine, signature: scan.signature, sha256: scan.sha256 });
      persistError("upload", "malware_detected", `${scan.engine}: ${scan.signature ?? "unknown"} sha256=${scan.sha256}`, { userId });
      throw new FileValidationError("This file was flagged by the malware scanner and has been rejected.");
    }
    throw new FileValidationError(
      scan.status === "unscanned"
        ? "Uploads require a malware scan, but no scanner is configured on this server. Contact the administrator."
        : "The malware scanner is unavailable right now, so the file wasn't accepted. Please try again later.",
    );
  }

  // 3) Release to private storage
  await s.move(quarantineKey, storageKey);
  let documentId: string | null = null;
  if (type.kind !== "image") {
    const [doc] = await db
      .insert(documents)
      .values({ userId, projectId: params.projectId ?? null, title: encrypt(fileName, AAD.file(userId)), mimeType: type.mime, status: "processing" })
      .returning({ id: documents.id });
    documentId = doc.id;
  }
  const [released] = await db
    .update(attachments)
    .set({ storageKey, documentId, scanStatus: scan.status, scanEngine: scan.engine, scannedAt: new Date(), sha256: scan.sha256 })
    .where(eq(attachments.id, att.id))
    .returning();

  // 4) Extract → chunk → encrypt → blind-index
  if (documentId) {
    try {
      const text = (await extractText(type.ext, buffer)).replace(/\u0000/g, "");
      const chunks = chunkText(text);
      for (let i = 0; i < chunks.length; i += 200) {
        await db.insert(documentChunks).values(
          chunks.slice(i, i + 200).map((content, j) => ({
            documentId: documentId!,
            userId,
            ordinal: i + j,
            content: encrypt(content, AAD.chunk(userId)),
            searchTokens: blindTokens(content),
            tokenCount: approxTokens(content),
          })),
        );
      }
      await db
        .update(documents)
        .set({ status: "ready", charCount: text.length, chunkCount: chunks.length, error: chunks.length ? null : "No readable text found (scanned PDFs need OCR)." })
        .where(eq(documents.id, documentId));
    } catch (e) {
      logger.warn("files.extract_failed", { error: e, ext: type.ext });
      await db.update(documents).set({ status: "failed", error: "Couldn't read this file's text." }).where(eq(documents.id, documentId));
    }
  }
  return { attachment: { ...released, fileName }, type, scan };
}

export type RetrievedChunk = { documentId: string; title: string; ordinal: number; content: string; rank: number };

/** Keyword retrieval over a user's documents via the blind index. Always scoped by userId. */
export async function searchChunks(userId: string, query: string, opts: { documentIds?: string[]; limit?: number } = {}): Promise<RetrievedChunk[]> {
  const limit = opts.limit ?? 8;
  if (opts.documentIds && opts.documentIds.length === 0) return [];
  const tokens = blindTokens(query.slice(0, 1000), 24);
  if (!tokens.length) return [];
  const arr = textArray(tokens);
  const overlap = sql<number>`cardinality(array(select unnest(${documentChunks.searchTokens}) intersect select unnest(${arr})))`;
  const rows = await db
    .select({ documentId: documentChunks.documentId, ordinal: documentChunks.ordinal, content: documentChunks.content, title: documents.title, rank: overlap })
    .from(documentChunks)
    .innerJoin(documents, eq(documents.id, documentChunks.documentId))
    .where(
      and(
        eq(documentChunks.userId, userId),
        eq(documents.userId, userId),
        ...(opts.documentIds ? [inArray(documentChunks.documentId, opts.documentIds)] : []),
        sql`${documentChunks.searchTokens} && ${arr}`,
      ),
    )
    .orderBy(sql`${overlap} desc`, documentChunks.ordinal)
    .limit(limit);
  return rows.map((r) => ({
    documentId: r.documentId,
    ordinal: r.ordinal,
    title: decryptOr(r.title, AAD.file(userId), "document"),
    content: decryptOr(r.content, AAD.chunk(userId), ""),
    rank: Number(r.rank),
  }));
}

/** For small documents, return the whole text (in order) instead of retrieval — better answers, same cost. */
export async function smallDocumentText(userId: string, documentIds: string[], maxTokens: number) {
  if (!documentIds.length) return null;
  const docs = await db
    .select({ id: documents.id, title: documents.title, charCount: documents.charCount, status: documents.status, error: documents.error })
    .from(documents)
    .where(and(eq(documents.userId, userId), inArray(documents.id, documentIds)));
  const total = docs.reduce((a, d) => a + d.charCount, 0);
  if (approxTokens("x".repeat(total)) > maxTokens) return null;
  const chunks = await db
    .select({ documentId: documentChunks.documentId, content: documentChunks.content, ordinal: documentChunks.ordinal })
    .from(documentChunks)
    .where(and(eq(documentChunks.userId, userId), inArray(documentChunks.documentId, documentIds)))
    .orderBy(documentChunks.documentId, documentChunks.ordinal);
  return docs.map((d) => ({
    title: decryptOr(d.title, AAD.file(userId), "document"),
    status: d.status,
    error: d.error,
    // chunks overlap by ~200 chars; acceptable duplication for small docs
    text: chunks
      .filter((c) => c.documentId === d.id)
      .map((c) => decryptOr(c.content, AAD.chunk(userId), ""))
      .join("\n\n"),
  }));
}

export async function listUserFiles(userId: string, limit = 100) {
  const rows = await db
    .select({
      id: attachments.id,
      fileName: attachments.fileName,
      mimeType: attachments.mimeType,
      sizeBytes: attachments.sizeBytes,
      kind: attachments.kind,
      createdAt: attachments.createdAt,
      documentId: attachments.documentId,
      scanStatus: attachments.scanStatus,
      scanEngine: attachments.scanEngine,
      origin: attachments.origin,
      status: documents.status,
      chunkCount: documents.chunkCount,
      error: documents.error,
      projectId: documents.projectId,
    })
    .from(attachments)
    .leftJoin(documents, eq(documents.id, attachments.documentId))
    .where(and(eq(attachments.userId, userId), sql`${attachments.scanStatus} <> 'pending'`))
    .orderBy(desc(attachments.createdAt))
    .limit(limit);
  return rows.map((r) => ({ ...r, fileName: decryptOr(r.fileName, AAD.file(userId), "file") }));
}

export async function deleteUserFile(userId: string, attachmentId: string) {
  const [att] = await db.select().from(attachments).where(and(eq(attachments.id, attachmentId), eq(attachments.userId, userId))).limit(1);
  if (!att) return false;
  await storage()
    .delete(att.storageKey)
    .catch((e) => logger.warn("files.storage_delete_failed", { error: e }));
  await db.delete(attachments).where(eq(attachments.id, att.id));
  if (att.documentId) await db.delete(documents).where(and(eq(documents.id, att.documentId), eq(documents.userId, userId)));
  return true;
}

/** Owner-scoped lookup used by download routes. Returns null for other users' files (no existence leak). */
export async function getOwnedAttachment(userId: string, attachmentId: string) {
  const [a] = await db.select().from(attachments).where(and(eq(attachments.id, attachmentId), eq(attachments.userId, userId))).limit(1);
  return a ? { ...a, fileName: decryptOr(a.fileName, AAD.file(userId), "file") } : null;
}

export function downloadable(scanStatus: string) {
  return scanStatus === "clean" || scanStatus === "unscanned";
}
