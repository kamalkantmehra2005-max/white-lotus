import "server-only";
import JSZip from "jszip";
import { decodeEntities } from "@/lib/search/html";

/** Extract plain text from a validated file buffer. Images return "" (they go to vision models directly). */
export async function extractText(ext: string, buf: Buffer): Promise<string> {
  switch (ext) {
    case "pdf": {
      // Import the implementation directly: pdf-parse's index runs a debug harness when imported via bundlers.
      const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default as (b: Buffer) => Promise<{ text: string }>;
      const r = await pdfParse(buf);
      return r.text;
    }
    case "docx": {
      const mammoth = await import("mammoth");
      const r = await mammoth.extractRawText({ buffer: buf });
      return r.value;
    }
    case "pptx":
      return extractPptx(buf);
    case "xlsx":
      return extractXlsx(buf);
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
      return "";
    case "rtf":
      return buf
        .toString("utf8")
        .replace(/\\par[d]?/g, "\n")
        .replace(/\{\\\*[^}]*\}|\\[a-z]+-?\d* ?|[{}]/g, "")
        .trim();
    default:
      return buf.toString("utf8");
  }
}

const xmlText = (xml: string) =>
  decodeEntities(
    xml
      .replace(/<\/a:p>/g, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/[ \t]+/g, " "),
  ).trim();

async function extractPptx(buf: Buffer) {
  const zip = await JSZip.loadAsync(buf);
  const slides = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  const out: string[] = [];
  for (const [i, f] of slides.entries()) out.push(`## Slide ${i + 1}\n${xmlText(await zip.file(f)!.async("string"))}`);
  return out.join("\n\n");
}

async function extractXlsx(buf: Buffer) {
  const zip = await JSZip.loadAsync(buf);
  const shared: string[] = [];
  const ss = zip.file("xl/sharedStrings.xml");
  if (ss) {
    const xml = await ss.async("string");
    for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(decodeEntities(m[1].replace(/<[^>]+>/g, "")));
  }
  const sheets = Object.keys(zip.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).sort();
  const out: string[] = [];
  for (const f of sheets) {
    const xml = await zip.file(f)!.async("string");
    const rows: string[] = [];
    for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const c of row[1].matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const v = c[2]?.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? c[2]?.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? "";
        cells.push(/t="s"/.test(attrs) ? (shared[Number(v)] ?? "") : decodeEntities(v));
      }
      rows.push(cells.join("\t"));
      if (rows.length > 5000) break;
    }
    out.push(`## ${f.split("/").pop()!.replace(".xml", "")}\n${rows.join("\n")}`);
  }
  return out.join("\n\n");
}
