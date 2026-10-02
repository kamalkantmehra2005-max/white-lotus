import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { chunkText } from "@/lib/files/chunk";
import { detectFileType, FileValidationError, sanitizeFileName } from "@/lib/files/validate";
import { extractText } from "@/lib/files/extract";
import { extractFromHtml, relevantPassages, decodeEntities } from "@/lib/search/html";
import { dedupe } from "@/lib/search/providers";

const MB = 1024 * 1024;
const b = (s: string | number[]) => (typeof s === "string" ? Buffer.from(s) : Buffer.from(s));

describe("file validation", () => {
  it("accepts matching magic bytes", () => {
    expect(detectFileType("a.pdf", b("%PDF-1.7 ..."), MB).kind).toBe("document");
    expect(detectFileType("a.png", b([0x89, 0x50, 0x4e, 0x47, 1, 2]), MB).kind).toBe("image");
    expect(detectFileType("notes.md", b("# hi"), MB).ext).toBe("md");
    expect(detectFileType("main.py", b("print('x')"), MB).kind).toBe("code");
  });
  it("rejects spoofed, binary-as-text, oversized, empty and unknown files", () => {
    expect(() => detectFileType("evil.pdf", b("MZ\x90\x00"), MB)).toThrow(FileValidationError);
    expect(() => detectFileType("x.txt", b([0, 1, 2, 0, 5]), MB)).toThrow(/match/);
    expect(() => detectFileType("big.txt", Buffer.alloc(2 * MB, 97), MB)).toThrow(/larger/);
    expect(() => detectFileType("e.txt", Buffer.alloc(0), MB)).toThrow(/empty/);
    expect(() => detectFileType("run.exe", b("MZ"), MB)).toThrow(/supported/);
  });
  it("sanitizes file names", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("C:\\x\\<script>.txt")).toBe("_script_.txt");
    expect(sanitizeFileName(".hidden")).toBe("hidden");
  });
});

describe("chunking", () => {
  it("returns single chunk for short text and overlapping chunks for long text", () => {
    expect(chunkText("short")).toEqual(["short"]);
    const long = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}. ` + "word ".repeat(60)).join("\n\n");
    const chunks = chunkText(long, { size: 1500, overlap: 200 });
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1500 + 250);
    expect(chunks.join(" ")).toContain("Paragraph 39");
  });
  it("hard-splits giant unbroken strings", () => {
    const chunks = chunkText("x".repeat(5000), { size: 1000, overlap: 100 });
    expect(chunks.length).toBeGreaterThanOrEqual(5);
  });
});

describe("extraction", () => {
  it("extracts text from pptx and xlsx", async () => {
    const pz = new JSZip();
    pz.file("ppt/slides/slide1.xml", '<p:sld><a:p><a:r><a:t>Hello slide</a:t></a:r></a:p></p:sld>');
    const pptx = await pz.generateAsync({ type: "nodebuffer" });
    expect(await extractText("pptx", pptx)).toContain("Hello slide");

    const xz = new JSZip();
    xz.file("xl/sharedStrings.xml", "<sst><si><t>Name</t></si><si><t>Ada</t></si></sst>");
    xz.file("xl/worksheets/sheet1.xml", '<worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>42</v></c></row><row><c t="s"><v>1</v></c></row></sheetData></worksheet>');
    const xlsx = await xz.generateAsync({ type: "nodebuffer" });
    const t = await extractText("xlsx", xlsx);
    expect(t).toContain("Name\t42");
    expect(t).toContain("Ada");
  });
  it("reads plain text as-is", async () => expect(await extractText("csv", b("a,b\n1,2"))).toBe("a,b\n1,2"));
});

describe("HTML extraction", () => {
  const html = `<html><head><title>My &amp; Page</title><meta name="description" content="Desc here"></head>
    <body><nav>Menu Home About</nav><article><h1>Heading</h1><p>First paragraph &mdash; with entity.</p><ul><li>One</li><li>Two</li></ul>
    <script>alert('x')</script><p>${"Filler text. ".repeat(50)}</p></article><footer>Copyright</footer></body></html>`;
  it("gets title, description and readable text without scripts or nav", () => {
    const x = extractFromHtml(html);
    expect(x.title).toBe("My & Page");
    expect(x.description).toBe("Desc here");
    expect(x.text).toContain("## Heading");
    expect(x.text).toContain("First paragraph — with entity.");
    expect(x.text).toContain("- One");
    expect(x.text).not.toContain("alert");
    expect(x.text).not.toContain("Menu Home");
  });
  it("decodes numeric entities", () => expect(decodeEntities("&#65;&#x42;&lt;")).toBe("AB<"));
  it("selects relevant passages", () => {
    const text = ["Intro about cats and nothing else here at all okay.", "Bananas are yellow fruit rich in potassium and sugar.", "Dogs are loyal animals that love walks in the park."].join("\n\n");
    expect(relevantPassages(text, "banana potassium", 60)).toContain("potassium");
  });
});

describe("search result dedupe", () => {
  it("dedupes by host+path and drops non-http", () => {
    const r = dedupe([
      { title: "a", url: "https://www.x.com/a/", snippet: "", source: "t" },
      { title: "b", url: "https://x.com/a", snippet: "", source: "t" },
      { title: "c", url: "javascript:alert(1)", snippet: "", source: "t" },
      { title: "d", url: "https://y.com/", snippet: "", source: "t" },
    ]);
    expect(r.map((x) => x.title)).toEqual(["a", "d"]);
  });
});
