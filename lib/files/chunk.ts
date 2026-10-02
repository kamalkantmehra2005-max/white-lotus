/**
 * Split text into overlapping chunks on natural boundaries (paragraph → sentence → hard cut).
 * ~1,500 chars ≈ 375 tokens per chunk, 200-char overlap to preserve context across boundaries.
 */
export function chunkText(text: string, { size = 1500, overlap = 200 } = {}): string[] {
  const clean = text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];

  const units: string[] = [];
  for (const para of clean.split(/\n\n/)) {
    if (para.length <= size) units.push(para);
    else {
      const sentences = para.match(/[^.!?\n]+[.!?]*\s*|\n/g) ?? [para];
      for (const s of sentences) {
        if (s.length <= size) units.push(s);
        else for (let i = 0; i < s.length; i += size - overlap) units.push(s.slice(i, i + size));
      }
    }
  }

  const chunks: string[] = [];
  let cur = "";
  for (const u of units) {
    if (cur && cur.length + u.length + 2 > size) {
      chunks.push(cur.trim());
      const tail = cur.slice(-overlap);
      const cut = tail.search(/\s/);
      cur = (cut >= 0 ? tail.slice(cut + 1) : tail) + "\n\n" + u;
    } else cur = cur ? `${cur}\n\n${u}` : u;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}
