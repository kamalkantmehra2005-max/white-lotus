import "server-only";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { env } from "@/config/env";
import { db } from "@/lib/database/client";
import { toolCalls } from "@/lib/database/schema";
import type { ToolCallRequest, ToolSpec } from "@/lib/ai/types";
import { searchChunks } from "@/lib/files/documents";
import { logger } from "@/lib/observability/logger";
import { isSearchAvailable, webSearch } from "@/lib/search/providers";
import { readUrl } from "@/lib/search/url-reader";
import { assertQuota, recordUsage } from "@/lib/usage/quotas";
import { isSensitiveMemory } from "@/lib/memory/sensitive";
import { createMemory } from "@/lib/memory";
import { normalizeUrl } from "@/lib/search/html";
import { rateLimit } from "@/lib/security/rate-limit";
import { evaluate } from "./calculator";
import { runJavaScript } from "./code-execution";
import { defineTool, type Tool, type ToolContext, type ToolResult } from "./types";

const webSearchTool = defineTool({
  name: "web_search",
  description: "Search the public web for current or factual information. Returns titles, URLs and snippets with citation numbers. Use for anything time-sensitive or that you are unsure about.",
  input: z.object({ query: z.string().min(1).max(300).describe("Search query"), freshness: z.enum(["day", "week", "month", "year"]).optional() }),
  permission: () => isSearchAvailable(),
  timeoutMs: 15_000,
  rateLimit: { limit: 30, windowSec: 600 },
  activity: (i) => `Searching the web for “${i.query}”`,
  async execute(i, ctx) {
    await assertQuota(ctx.userId, "search", ctx.role);
    const { results, provider } = await webSearch(i.query, { count: 6, freshness: i.freshness, signal: ctx.signal });
    await recordUsage({ userId: ctx.userId, kind: "search", provider: provider ?? "none", success: results.length > 0 });
    if (!results.length) return { results: [], note: "No results (search may be unavailable). Do not invent sources." };
    for (const r of results) ctx.allowedUrls.add(normalizeUrl(r.url));
    const sources = ctx.addSources(results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet, publishedAt: r.publishedAt })));
    return { results: sources.map((s) => ({ citation: `[${s.id}]`, title: s.title, url: s.url, snippet: s.snippet, published: s.publishedAt })) };
  },
});

const urlReaderTool = defineTool({
  name: "read_url",
  description:
    "Fetch a public web page and return its readable text. Only URLs the user provided, URLs from web_search results, or links found on pages you already read can be fetched.",
  input: z.object({ url: z.string().url().max(2048), focus: z.string().max(300).optional().describe("What to look for on the page") }),
  permission: () => !env.LOCAL_OFFLINE_MODE, // fetching a page contacts that website
  timeoutMs: 15_000,
  rateLimit: { limit: 40, windowSec: 600 },
  activity: (i) => {
    try {
      return `Reading ${new URL(i.url).hostname}`;
    } catch {
      return "Reading a web page";
    }
  },
  async execute(i, ctx) {
    if (!ctx.allowedUrls.has(normalizeUrl(i.url))) {
      return { error: "This URL wasn't provided by the user or found in search results/pages already read, so it can't be fetched. Ask the user to share it." };
    }
    const page = await readUrl(i.url, { query: i.focus, maxChars: 10_000 });
    for (const l of page.links.slice(0, 200)) ctx.allowedUrls.add(l);
    const [s] = ctx.addSources([{ title: page.title, url: page.url, snippet: page.description }]);
    return { citation: `[${s.id}]`, title: page.title, url: page.url, published: page.publishedAt, truncated: page.truncated, text: page.text };
  },
});

const calculatorTool = defineTool({
  name: "calculator",
  description: "Evaluate an arithmetic expression exactly. Supports + - * / ^ % ! parentheses, sqrt, ln, log, sin, cos, tan, min, max, pi, e. Use for any non-trivial arithmetic instead of mental math.",
  input: z.object({ expression: z.string().min(1).max(500) }),
  permission: () => true,
  timeoutMs: 1_000,
  activity: () => "Calculating",
  async execute(i) {
    const result = evaluate(i.expression);
    return { expression: i.expression, result };
  },
});

const timeTool = defineTool({
  name: "current_time",
  description: "Get the current date and time, optionally in a specific IANA time zone (e.g. 'Asia/Kolkata').",
  input: z.object({ timezone: z.string().max(64).optional() }),
  permission: () => true,
  timeoutMs: 1_000,
  activity: () => "Checking the time",
  async execute(i) {
    const now = new Date();
    const tz = i.timezone ?? "UTC";
    try {
      const local = new Intl.DateTimeFormat("en-US", { timeZone: tz, dateStyle: "full", timeStyle: "long" }).format(now);
      return { iso: now.toISOString(), timezone: tz, local };
    } catch {
      return { iso: now.toISOString(), timezone: "UTC", note: `Unknown time zone '${tz}'` };
    }
  },
});

/** Weather via Open-Meteo (free, no API key). */
const weatherTool = defineTool({
  name: "weather",
  description: "Get current weather and a 3-day forecast for a place name.",
  input: z.object({ location: z.string().min(1).max(120) }),
  permission: () => !env.LOCAL_OFFLINE_MODE, // sends the place name to Open-Meteo
  timeoutMs: 10_000,
  rateLimit: { limit: 20, windowSec: 600 },
  activity: (i) => `Checking weather in ${i.location}`,
  async execute(i, ctx) {
    const g = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(i.location)}`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json() as Promise<{ results?: Array<{ name: string; country?: string; latitude: number; longitude: number; timezone?: string }> }>);
    const place = g.results?.[0];
    if (!place) return { error: `Couldn't find a place named '${i.location}'.` };
    const u = new URL("https://api.open-meteo.com/v1/forecast");
    u.searchParams.set("latitude", String(place.latitude));
    u.searchParams.set("longitude", String(place.longitude));
    u.searchParams.set("current", "temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code");
    u.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code");
    u.searchParams.set("forecast_days", "3");
    u.searchParams.set("timezone", place.timezone ?? "auto");
    const w = await fetch(u, { signal: AbortSignal.timeout(8000) }).then((r) => r.json());
    ctx.addSources([{ title: `Open-Meteo forecast for ${place.name}`, url: "https://open-meteo.com/" }]);
    return { place: `${place.name}${place.country ? `, ${place.country}` : ""}`, units: "metric (°C, km/h)", ...w };
  },
});

const fileSearchTool = defineTool({
  name: "file_search",
  description: "Search the user's uploaded documents for passages relevant to a query. Returns excerpts labelled with document titles.",
  input: z.object({ query: z.string().min(1).max(500), scope: z.enum(["conversation", "all"]).default("conversation") }),
  permission: () => true,
  timeoutMs: 8_000,
  activity: (i) => `Searching your files for “${i.query}”`,
  async execute(i, ctx) {
    const scoped = i.scope === "conversation" && ctx.documentIds.length > 0;
    const hits = await searchChunks(ctx.userId, i.query, { documentIds: scoped ? ctx.documentIds : undefined, limit: 6 });
    if (!hits.length) return { results: [], note: "No matching passages in the user's files." };
    return { results: hits.map((h) => ({ document: h.title, part: h.ordinal + 1, excerpt: h.content })) };
  },
});

const rememberTool = defineTool({
  name: "save_memory",
  description: "Save a durable fact or preference to the user's long-term memory. ONLY call this when the user explicitly asks you to remember something. Never save passwords, financial, health or other sensitive data.",
  input: z.object({ content: z.string().min(3).max(500) }),
  // Only offered when memory is on AND the user's own message explicitly asks to remember something —
  // so injected web/document text can never trigger a memory write.
  permission: (ctx) => ctx.memoryEnabled && REMEMBER_INTENT.test(ctx.userMessage),
  timeoutMs: 3_000,
  rateLimit: { limit: 20, windowSec: 3600 },
  activity: () => "Saving to memory",
  async execute(i, ctx) {
    if (isSensitiveMemory(i.content)) {
      return { saved: false, reason: "Sensitive information is never stored in memory." };
    }
    const m = await createMemory(ctx.userId, i.content, ctx.projectId, "assistant");
    return { saved: true, id: m.id, note: "The user can view, edit or delete this in Settings → Memory." };
  },
});

export const REMEMBER_INTENT = /\b(remember|memori[sz]e|save (this|that|it)|note (this|that|it)|keep in mind|don'?t forget|add (this|that|it) to (your |my )?memory)\b/i;

const codeTool = defineTool({
  name: "run_javascript",
  description: "Execute a short JavaScript snippet in an isolated sandbox (no network, no filesystem, 3s limit). Use console.log to output. The value of the last expression is returned.",
  input: z.object({ code: z.string().min(1).max(20_000) }),
  permission: () => env.ENABLE_CODE_EXECUTION,
  timeoutMs: 5_000,
  rateLimit: { limit: 20, windowSec: 600 },
  activity: () => "Running code",
  async execute(i) {
    return runJavaScript(i.code, 3000);
  },
});

export const ALL_TOOLS: Tool[] = [webSearchTool, urlReaderTool, calculatorTool, timeTool, weatherTool, fileSearchTool, rememberTool, codeTool];

/** Custom tools: push additional definitions here (or load from a plugin directory). */
export function registerTool(t: Tool) {
  if (ALL_TOOLS.some((x) => x.name === t.name)) throw new Error(`Tool ${t.name} already registered`);
  ALL_TOOLS.push(t);
}

export function availableTools(ctx: ToolContext, opts: { exclude?: string[] } = {}): Tool[] {
  return ALL_TOOLS.filter((t) => !opts.exclude?.includes(t.name) && t.permission(ctx));
}

export function toToolSpecs(tools: Tool[]): ToolSpec[] {
  return tools.map((t) => {
    const schema = zodToJsonSchema(t.input, { target: "openApi3", $refStrategy: "none" }) as Record<string, unknown>;
    delete schema.$schema;
    return { name: t.name, description: t.description, parameters: schema };
  });
}

/** Execute one tool call: validate input, check permission, enforce timeout, log, never throw. */
export async function executeToolCall(call: ToolCallRequest, tools: Tool[], ctx: ToolContext, messageId?: string): Promise<ToolResult> {
  const tool = tools.find((t) => t.name === call.name);
  const started = Date.now();
  let input: unknown = {};
  let result: ToolResult;
  try {
    if (!tool) throw new Error(`Unknown or unavailable tool '${call.name}'`);
    if (!tool.permission(ctx)) throw new Error(`Tool '${call.name}' is not permitted here`);
    input = JSON.parse(call.arguments || "{}");
    const parsed = tool.input.safeParse(input);
    if (!parsed.success) throw new Error(`Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    if (tool.rateLimit) {
      const rl = await rateLimit(`tool:${tool.name}:${ctx.userId}`, tool.rateLimit.limit, tool.rateLimit.windowSec);
      if (!rl.allowed) throw new Error(`Rate limit reached for ${tool.name}; try again later`);
    }
    ctx.onActivity(tool.activity(parsed.data));
    const data = await Promise.race([
      tool.execute(parsed.data, ctx),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`Tool timed out after ${tool.timeoutMs}ms`)), tool.timeoutMs)),
    ]);
    result = { ok: true, data };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result = { ok: false, error: msg.slice(0, 500) };
    logger.info("tool.error", { tool: call.name, error: msg.slice(0, 120) });
  }
  const durationMs = Date.now() - started;
  // Audit log records THAT a tool ran (name, argument names, outcome, timing) — never its inputs or outputs,
  // which can contain confidential queries or document excerpts.
  db.insert(toolCalls)
    .values({
      userId: ctx.userId,
      messageId: messageId ?? null,
      toolName: call.name.slice(0, 64),
      input: { args: input && typeof input === "object" ? Object.keys(input as object).slice(0, 20) : [] },
      output: null,
      success: result.ok,
      error: result.ok ? null : "tool_error",
      durationMs,
    })
    .catch((e) => logger.warn("tool.log_failed", { error: e }));
  return result;
}
