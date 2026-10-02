import "server-only";
import { env } from "@/config/env";
import { safeFetch, UrlBlockedError } from "@/lib/security/url-guard";
import { extractFromHtml, extractLinks, relevantPassages } from "./html";

export type ReadPage = { url: string; title: string; text: string; description: string; publishedAt?: string; truncated: boolean; links: string[] };

const cache = new Map<string, { at: number; page: ReadPage }>();
const TTL = 10 * 60_000;

/** Validate → fetch (SSRF-safe) → extract readable text. Cached for 10 minutes. */
export async function readUrl(url: string, { query, maxChars = 12_000 }: { query?: string; maxChars?: number } = {}): Promise<ReadPage> {
  const hit = cache.get(url);
  let page: ReadPage;
  if (hit && Date.now() - hit.at < TTL) page = hit.page;
  else {
    const res = await safeFetch(url, { allowPrivate: env.URL_FETCH_ALLOW_PRIVATE, maxBytes: 3_000_000, timeoutMs: 12_000 });
    if (res.status >= 400) throw new UrlBlockedError(`page returned HTTP ${res.status}`);
    const ct = res.contentType.toLowerCase();
    if (ct.includes("html") || ct === "") {
      const x = extractFromHtml(res.body);
      page = { url: res.url, title: x.title || new URL(res.url).hostname, text: x.text, description: x.description, publishedAt: x.publishedAt, truncated: res.truncated, links: extractLinks(res.body, res.url) };
    } else if (ct.startsWith("text/") || ct.includes("json") || ct.includes("xml")) {
      page = { url: res.url, title: new URL(res.url).pathname.split("/").pop() || res.url, text: res.body, description: "", truncated: res.truncated, links: [] };
    } else {
      throw new UrlBlockedError(`unsupported content type ${ct.split(";")[0]}`);
    }
    cache.set(url, { at: Date.now(), page });
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
  }
  const text = query ? relevantPassages(page.text, query, maxChars) : page.text.slice(0, maxChars);
  return { ...page, text, truncated: page.truncated || page.text.length > text.length };
}
