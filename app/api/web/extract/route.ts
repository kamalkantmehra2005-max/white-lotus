import { NextResponse } from "next/server";
import { env } from "@/config/env";
import { AppError, handle } from "@/lib/errors";
import { extractText } from "@/lib/files/extract";
import { detectFileType, FileValidationError, sanitizeFileName } from "@/lib/files/validate";
import { clientIp, enforceRateLimit } from "@/lib/security/rate-limit";
import { assertCloud, optionalAccount } from "@/lib/web/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_TEXT = 400_000;

/**
 * Online edition: turn a PDF/DOCX/PPTX/XLSX/text file into plain text and return it. The file is processed in
 * memory and discarded — nothing is written to disk or a database. The browser keeps the text on the device.
 */
export const POST = handle(async (req: Request) => {
  await assertCloud();
  const user = await optionalAccount();
  await enforceRateLimit(user ? `webextract:${user.id}` : `webextract:ip:${clientIp(req)}`, user ? 30 : 8, 3600);
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new AppError("invalid_request", "No file was sent.", 400);
  const maxBytes = Math.min(env.MAX_UPLOAD_SIZE_MB, 4) * 1024 * 1024; // hosting platforms cap request bodies (~4.5 MB)
  if (file.size > maxBytes) throw new AppError("file_too_large", `Files can be up to ${maxBytes / 1024 / 1024} MB here.`, 413);
  const buf = Buffer.from(await file.arrayBuffer());
  try {
    const type = detectFileType(file.name, buf, maxBytes);
    if (type.kind === "image") throw new AppError("invalid_request", "Images are read by the AI directly — attach them as images.", 400);
    const text = (await extractText(type.ext, buf)).replace(/\u0000/g, "").trim();
    if (!text) throw new AppError("no_text", "No readable text was found in this file (scanned PDFs need OCR first).", 422);
    return NextResponse.json({ name: sanitizeFileName(file.name), chars: text.length, truncated: text.length > MAX_TEXT, text: text.slice(0, MAX_TEXT) }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof FileValidationError) throw new AppError("invalid_file", e.message, 400);
    throw e;
  }
});
