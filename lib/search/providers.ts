import "server-only";
import { env } from "@/config/env";
import { logger } from "@/lib/observability/logger";

export type SearchResult = { title: string; url: string; snippet: string; publishedAt?: string; source: string };
export type SearchOptions = { count?: number; freshness?: "day" | "week" | "month" | "year"; signal?: AbortSignal };

export interface SearchProvider {
  id: string;
  isConfigured(): boolean;
  search(query: string, opts: SearchOptions): Promise<SearchResult[]>;
}

const clean = (s: unknown) => (typeof s === "string" ? s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() : "");

class TavilySearch implements SearchProvider {
  id = "tavily";
  isConfigured = () => Boolean(env.TAVILY_API_KEY);
  async search(query: string, o: SearchOptions) {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.TAVILY_API_KEY}` },
      body: JSON.stringify({
        query,
        max_results: o.count ?? 6,
        search_depth: "basic",
        ...(o.freshness ? { time_range: o.freshness } : {}),
      }),
      signal: o.signal ?? AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`tavily ${res.status}`);
    const j = (await res.json()) as { results?: Array<{ title: string; url: string; content: string; published_date?: string }> };
    return (j.results ?? []).map((r) => ({ title: clean(r.title), url: r.url, snippet: clean(r.content).slice(0, 500), publishedAt: r.published_date, source: this.id }));
  }
}

class BraveSearch implements SearchProvider {
  id = "brave";
  isConfigured = () => Boolean(env.BRAVE_SEARCH_API_KEY);
  async search(query: string, o: SearchOptions) {
    const u = new URL("https://api.search.brave.com/res/v1/web/search");
    u.searchParams.set("q", query);
    u.searchParams.set("count", String(o.count ?? 6));
    if (o.freshness) u.searchParams.set("freshness", { day: "pd", week: "pw", month: "pm", year: "py" }[o.freshness]);
    const res = await fetch(u, {
      headers: { Accept: "application/json", "X-Subscription-Token": env.BRAVE_SEARCH_API_KEY! },
      signal: o.signal ?? AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`brave ${res.status}`);
    const j = (await res.json()) as { web?: { results?: Array<{ title: string; url: string; description: string; page_age?: string; age?: string }> } };
    return (j.web?.results ?? []).map((r) => ({ title: clean(r.title), url: r.url, snippet: clean(r.description), publishedAt: r.page_age, source: this.id }));
  }
}

/** Self-hostable meta-search (no API key). Enable JSON format in SearXNG settings.yml: search.formats: [html, json]. */
class SearxngSearch implements SearchProvider {
  id = "searxng";
  isConfigured = () => Boolean(env.SEARXNG_URL);
  async search(query: string, o: SearchOptions) {
    const u = new URL("/search", env.SEARXNG_URL);
    u.searchParams.set("q", query);
    u.searchParams.set("format", "json");
    if (o.freshness) u.searchParams.set("time_range", o.freshness);
    const res = await fetch(u, { headers: { Accept: "application/json" }, signal: o.signal ?? AbortSignal.timeout(12_000) });
    if (!res.ok) throw new Error(`searxng ${res.status}`);
    const j = (await res.json()) as { results?: Array<{ title: string; url: string; content?: string; publishedDate?: string }> };
    return (j.results ?? []).slice(0, o.count ?? 6).map((r) => ({ title: clean(r.title), url: r.url, snippet: clean(r.content), publishedAt: r.publishedDate ?? undefined, source: this.id }));
  }
}

const ALL: Record<string, SearchProvider> = { tavily: new TavilySearch(), brave: new BraveSearch(), searxng: new SearxngSearch() };

export function configuredSearchProviders(): SearchProvider[] {
  return env.SEARCH_PROVIDERS.split(",")
    .map((s) => ALL[s.trim()])
    .filter((p): p is SearchProvider => Boolean(p?.isConfigured()));
}

export function isSearchAvailable() {
  // Offline mode: web search would send queries off this computer, so it's switched off.
  if (env.LOCAL_OFFLINE_MODE) return false;
  return configuredSearchProviders().length > 0;
}

const cache = new Map<string, { at: number; value: { results: SearchResult[]; provider: string } }>();
const CACHE_TTL = 5 * 60_000;

/** Search with provider fallback and a short cache. Returns [] only if every provider failed or none is configured. */
export async function webSearch(query: string, opts: SearchOptions = {}): Promise<{ results: SearchResult[]; provider: string | null; cached?: boolean }> {
  const key = `${query.trim().toLowerCase()}|${opts.count ?? 6}|${opts.freshness ?? ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return { ...hit.value, cached: true };
  for (const p of configuredSearchProviders()) {
    try {
      const results = dedupe(await p.search(query, opts));
      if (results.length) {
        cache.set(key, { at: Date.now(), value: { results, provider: p.id } });
        if (cache.size > 500) cache.delete(cache.keys().next().value!);
      }
      return { results, provider: p.id };
    } catch (e) {
      logger.warn("search.provider_failed", { provider: p.id, error: e });
    }
  }
  return { results: [], provider: null };
}

export function dedupe(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    try {
      const u = new URL(r.url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return false;
      const key = `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    } catch {
      return false;
    }
  });
}
