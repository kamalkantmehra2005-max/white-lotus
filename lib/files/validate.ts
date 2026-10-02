/**
 * Upload validation: extension allow-list + magic-byte sniffing so a renamed executable can't slip through.
 * The declared browser MIME type is never trusted.
 */
export type FileKind = "image" | "document" | "code" | "data";
export type FileType = { ext: string; mime: string; kind: FileKind };

const TYPES: Record<string, { mime: string; kind: FileKind }> = {
  pdf: { mime: "application/pdf", kind: "document" },
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "document" },
  pptx: { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", kind: "document" },
  xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kind: "data" },
  txt: { mime: "text/plain", kind: "document" },
  md: { mime: "text/markdown", kind: "document" },
  markdown: { mime: "text/markdown", kind: "document" },
  rtf: { mime: "text/rtf", kind: "document" },
  html: { mime: "text/plain", kind: "document" }, // stored and served as plain text, never rendered
  csv: { mime: "text/csv", kind: "data" },
  tsv: { mime: "text/tab-separated-values", kind: "data" },
  json: { mime: "application/json", kind: "data" },
  xml: { mime: "text/plain", kind: "data" },
  yaml: { mime: "text/plain", kind: "data" },
  yml: { mime: "text/plain", kind: "data" },
  png: { mime: "image/png", kind: "image" },
  jpg: { mime: "image/jpeg", kind: "image" },
  jpeg: { mime: "image/jpeg", kind: "image" },
  gif: { mime: "image/gif", kind: "image" },
  webp: { mime: "image/webp", kind: "image" },
};
const CODE_EXT = ["js", "jsx", "ts", "tsx", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cpp", "hpp", "cs", "php", "sh", "sql", "css", "scss", "vue", "svelte", "toml", "ini", "dockerfile", "r", "scala", "lua", "dart"];
for (const e of CODE_EXT) TYPES[e] = { mime: "text/plain", kind: "code" };

export const ACCEPT_ATTR = Object.keys(TYPES).map((e) => `.${e}`).join(",");

function startsWith(buf: Uint8Array, sig: number[], offset = 0) {
  return sig.every((b, i) => buf[offset + i] === b);
}

function looksLikeText(buf: Uint8Array) {
  const n = Math.min(buf.length, 8000);
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const c = buf[i];
    if (c === 0) return false;
    if (c < 9 || (c > 13 && c < 32)) bad++;
  }
  return bad / Math.max(1, n) < 0.02;
}

export class FileValidationError extends Error {}

export function detectFileType(fileName: string, buf: Uint8Array, maxBytes: number): FileType {
  if (buf.length === 0) throw new FileValidationError("The file is empty.");
  if (buf.length > maxBytes) throw new FileValidationError(`The file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`);
  const base = fileName.toLowerCase().split(/[\\/]/).pop() ?? "";
  const ext = base === "dockerfile" ? "dockerfile" : (base.includes(".") ? base.split(".").pop()! : "");
  const t = TYPES[ext];
  if (!t) throw new FileValidationError(`.${ext || "unknown"} files aren't supported.`);

  const zip = startsWith(buf, [0x50, 0x4b, 0x03, 0x04]);
  const ok = (() => {
    switch (ext) {
      case "pdf":
        return startsWith(buf, [0x25, 0x50, 0x44, 0x46]);
      case "docx":
      case "pptx":
      case "xlsx":
        return zip;
      case "png":
        return startsWith(buf, [0x89, 0x50, 0x4e, 0x47]);
      case "jpg":
      case "jpeg":
        return startsWith(buf, [0xff, 0xd8, 0xff]);
      case "gif":
        return startsWith(buf, [0x47, 0x49, 0x46, 0x38]);
      case "webp":
        return startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8);
      default:
        return looksLikeText(buf);
    }
  })();
  if (!ok) throw new FileValidationError("The file contents don't match its extension.");
  return { ext, ...t };
}

export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  return base.replace(/[^\w.\- ()]/g, "_").replace(/^\.+/, "").slice(0, 150) || "file";
}
