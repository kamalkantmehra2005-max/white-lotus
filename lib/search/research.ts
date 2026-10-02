import "server-only";
import type { MessageSource } from "@/lib/database/schema";
import { completeText, extractJson } from "@/lib/ai/complete";
import type { AIProvider } from "@/lib/ai/types";
import { logger } from "@/lib/observability/logger";
import { webSearch, type SearchResult } from "./providers";
import { readUrl } from "./url-reader";

/**
 * Research pipeline:
 *  decide → plan queries → search (parallel) → diversify → read pages (parallel) → rank passages
 *  → [deep mode: find gaps / claims needing corroboration → second search round] → numbered context.
 * Every search that actually ran is recorded in `queries`, so the UI never implies a search that didn't happen.
 */
export type ResearchResult = { sources: MessageSource[]; context: string; queries: string[]; searched: boolean; provider: string | null };
type Planner = { provider: AIProvider; model: string } | null;

const FRESH = /\b(today|latest|current|currently|now|this (week|month|year)|recent|news|price|stock|score|weather|20\d\d|who is the|ceo|president|prime minister|release|update)\b/i;

export function needsFreshness(q: string) {
  return FRESH.test(q);
}

/** Heuristic for when the model can't call tools itself: does this look like it needs the web? */
export function looksLikeWebQuestion(q: string) {
  return FRESH.test(q) || /\b(search|look up|google|find (me )?(articles|sources|info))\b/i.test(q);
}

async function askJsonArray(planner: Planner, system: string, user: string, max: number): Promise<string[]> {
  if (!planner) return [];
  try {
    const out = await completeText(planner.provider, planner.model, [{ role: "system", content: system }, { role: "user", content: user.slice(0, 6000) }], { maxOutputTokens: 200, temperature: 0 });
    const arr = extractJson<string[]>(out);
    return Array.isArray(arr) ? arr.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim().slice(0, 200)).slice(0, max) : [];
  } catch (e) {
    logger.warn("research.planner_failed", { error: e });
    return [];
  }
}

export async function planQueries(question: string, planner: Planner, deep: boolean): Promise<string[]> {
  const n = deep ? 4 : 2;
  const qs = await askJsonArray(
    planner,
    `You write web search queries. Return ONLY a JSON array of ${n} short, distinct search queries (max 12 words each) that together answer the user's question. Include the year ${new Date().getUTCFullYear()} only when recency matters. No prose.`,
    question,
    n,
  );
  return qs.length ? qs : [question.slice(0, 300)];
}

/** Round-robin across queries, dedupe URLs, and cap results per domain for source diversity. */
export function diversify(lists: SearchResult[][], max: number, perDomain = 2): SearchResult[] {
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  const perHost = new Map<string, number>();
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest && out.length < max; i++) {
    for (const l of lists) {
      const r = l[i];
      if (!r || seen.has(r.url)) continue;
      let host = r.url;
      try {
        host = new URL(r.url).hostname.replace(/^www\./, "");
      } catch {
        continue;
      }
      if ((perHost.get(host) ?? 0) >= perDomain) continue;
      seen.add(r.url);
      perHost.set(host, (perHost.get(host) ?? 0) + 1);
      out.push(r);
      if (out.length >= max) break;
    }
  }
  return out;
}

async function readAll(results: SearchResult[], question: string, maxChars: number) {
  return Promise.all(
    results.map(async (r) => {
      try {
        const p = await readUrl(r.url, { query: question, maxChars });
        return { r, text: p.text || r.snippet, title: p.title || r.title, publishedAt: p.publishedAt ?? r.publishedAt, read: true };
      } catch {
        return { r, text: r.snippet, title: r.title, publishedAt: r.publishedAt, read: false }; // snippet only
      }
    }),
  );
}

export async function runResearch(question: string, opts: { planner: Planner; deep: boolean; onActivity?: (s: string) => void; signal?: AbortSignal }): Promise<ResearchResult> {
  const queries = await planQueries(question, opts.planner, opts.deep);
  opts.onActivity?.(`Searching the web: ${queries.map((q) => `“${q}”`).join(", ")}`);
  const freshness = needsFreshness(question) ? ("month" as const) : undefined;
  const run = (qs: string[]) => Promise.all(qs.map((q) => webSearch(q, { count: opts.deep ? 8 : 5, freshness, signal: opts.signal }).catch(() => ({ results: [] as SearchResult[], provider: null }))));

  const round1 = await run(queries);
  const provider = round1.find((s) => s.provider)?.provider ?? null;
  if (!provider) return { sources: [], context: "", queries, searched: false, provider: null };

  const maxSources = opts.deep ? 10 : 5;
  let picked = diversify(round1.map((s) => s.results), opts.deep ? 7 : maxSources);
  opts.onActivity?.(`Reading ${picked.length} sources`);
  let pages = await readAll(picked, question, opts.deep ? 4000 : 2500);

  if (opts.deep && opts.planner) {
    // Cross-check: ask for follow-up queries that fill gaps or independently corroborate key claims.
    const digest = pages.map((p, i) => `[${i + 1}] ${p.title}: ${p.text.slice(0, 600)}`).join("\n");
    const follow = await askJsonArray(
      opts.planner,
      "You review research notes. Return ONLY a JSON array of up to 2 web search queries that would (a) fill important gaps or (b) independently verify the most important factual claims below. Return [] if coverage is sufficient.",
      `Question: ${question}\n\nNotes:\n${digest}`,
      2,
    );
    const fresh = follow.filter((q) => !queries.includes(q));
    if (fresh.length) {
      opts.onActivity?.(`Cross-checking: ${fresh.map((q) => `“${q}”`).join(", ")}`);
      queries.push(...fresh);
      const round2 = await run(fresh);
      const known = new Set(picked.map((r) => r.url));
      const extra = diversify(round2.map((s) => s.results.filter((r) => !known.has(r.url))), maxSources - picked.length, 1);
      if (extra.length) {
        pages = pages.concat(await readAll(extra, question, 3000));
        picked = picked.concat(extra);
      }
    }
  }

  const sources: MessageSource[] = pages.map((p, i) => ({ id: i + 1, title: p.title.slice(0, 200), url: p.r.url, snippet: p.r.snippet.slice(0, 300), publishedAt: p.publishedAt }));
  const context = pages
    .map((p, i) => `[${i + 1}] ${p.title}\nURL: ${p.r.url}${p.publishedAt ? `\nPublished: ${p.publishedAt}` : ""}${p.read ? "" : "\n(snippet only — page could not be read)"}\n---\n${p.text}`)
    .join("\n\n=====\n\n");
  const hosts = new Set(sources.map((s) => { try { return new URL(s.url).hostname; } catch { return s.url; } }));
  opts.onActivity?.(`Compared ${sources.length} sources from ${hosts.size} site${hosts.size === 1 ? "" : "s"}`);
  return { sources, context, queries, searched: true, provider };
}
