/**
 * Dependency-free HTML → readable text extraction.
 * Keeps headings/paragraph breaks, drops scripts/styles/nav/boilerplate, decodes entities.
 */
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export type ExtractedPage = { title: string; description: string; text: string; publishedAt?: string; links: string[] };

export function extractFromHtml(html: string): ExtractedPage {
  const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim()).replace(/\s+/g, " ");
  const meta = (name: string) =>
    html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, "i"))?.[1] ??
    html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`, "i"))?.[1];
  const description = decodeEntities(meta("description") ?? meta("og:description") ?? "");
  const publishedAt = meta("article:published_time") ?? html.match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1];

  let body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|iframe|template|canvas|form|button|select)[\s\S]*?<\/\1>/gi, " ");
  const main = body.match(/<(article|main)[^>]*>([\s\S]*?)<\/\1>/i)?.[2];
  if (main && main.length > 500) body = main;
  body = body.replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, " ");

  const text = decodeEntities(
    body
      .replace(/<(h[1-6])[^>]*>/gi, "\n\n## ")
      .replace(/<\/(p|div|section|article|h[1-6]|li|tr|blockquote|pre)>/gi, "\n")
      .replace(/<(br|hr)\s*\/?>/gi, "\n")
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { title, description, text, publishedAt, links: extractLinks(html) };
}

/** Absolute http(s) links on the page (used as the allow-list for following links safely). */
export function extractLinks(html: string, base?: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\s[^>]*href=["']([^"'#][^"']*)["']/gi)) {
    try {
      const u = new URL(decodeEntities(m[1]), base);
      if (u.protocol === "http:" || u.protocol === "https:") out.add(normalizeUrl(u.toString()));
    } catch {
      /* skip relative links without a base */
    }
    if (out.size >= 300) break;
  }
  return [...out];
}

/** Canonical form for URL allow-list comparisons. */
export function normalizeUrl(u: string): string {
  try {
    const x = new URL(u);
    x.hash = "";
    x.hostname = x.hostname.toLowerCase().replace(/^www\./, "");
    let s = x.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return u;
  }
}

/** URLs typed by the user (http/https only). */
export function urlsInText(text: string): string[] {
  return [...new Set((text.match(/https?:\/\/[^\s<>"'`)\]]+/gi) ?? []).map((u) => u.replace(/[.,;:!?]+$/, "")))].slice(0, 20);
}

/** Pick the passages of a long text most relevant to a query (keyword overlap scoring). */
export function relevantPassages(text: string, query: string, maxChars = 3000): string {
  if (text.length <= maxChars) return text;
  const terms = new Set(query.toLowerCase().split(/\W+/).filter((t) => t.length > 2));
  const paras = text.split(/\n{1,2}/).map((p) => p.trim()).filter((p) => p.length > 40);
  const scored = paras.map((p, i) => {
    const words = p.toLowerCase().split(/\W+/);
    const hits = words.filter((w) => terms.has(w)).length;
    return { i, p, score: hits / Math.sqrt(words.length + 1) + (i < 3 ? 0.2 : 0) };
  });
  scored.sort((a, b) => b.score - a.score);
  const picked: typeof scored = [];
  let len = 0;
  for (const s of scored) {
    if (len + s.p.length > maxChars) continue;
    picked.push(s);
    len += s.p.length;
  }
  return picked.sort((a, b) => a.i - b.i).map((s) => s.p).join("\n\n");
}
