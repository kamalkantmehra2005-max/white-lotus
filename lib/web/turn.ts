import "server-only";
import { getMode } from "@/lib/ai/modes";
import { buildSystemPrompt } from "@/lib/ai/prompts";
import { resolveFastModel, resolveModel } from "@/lib/ai/registry";
import { explainProviderFailure } from "@/lib/ai/diagnose";
import { ProviderError, type ContentPart } from "@/lib/ai/types";
import { fitToBudget } from "@/lib/chat/context";
import { generateTitle, openStream } from "@/lib/chat/orchestrator";
import type { ChatStreamEvent } from "@/lib/chat/protocol";
import type { MessageSource } from "@/lib/database/schema";
import { AppError, Errors } from "@/lib/errors";
import { normalizeUrl, urlsInText } from "@/lib/search/html";
import { isSearchAvailable } from "@/lib/search/providers";
import { looksLikeWebQuestion, runResearch } from "@/lib/search/research";
import { readUrl } from "@/lib/search/url-reader";

/**
 * Online edition: one stateless AI turn. The browser sends the conversation (it lives on the device); the server
 * adds web research if asked, streams the answer back and keeps nothing — no message content is written anywhere.
 */
export type WebTurnInput = {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  images: Array<{ mimeType: string; data: string }>;
  files: Array<{ name: string; text: string }>;
  mode: string;
  model?: string | null;
  webSearch: boolean;
  deepResearch: boolean;
  customInstructions?: string | null;
  userName?: string | null;
  timezone?: string | null;
  wantTitle: boolean;
  allowSearch: boolean;
  maxContextTokens: number;
  maxOutputTokens: number;
  signal: AbortSignal;
};

export type WebTurnResult = { model: string; provider: string; inputTokens: number; outputTokens: number; searched: boolean };

export async function runWebTurn(input: WebTurnInput, emit: (e: ChatStreamEvent) => void): Promise<WebTurnResult> {
  const mode = getMode(input.mode);
  const resolved = resolveModel(input.model);
  if (!resolved) throw Errors.notConfigured("No AI model");
  let { info, provider } = resolved;
  const latest = input.messages[input.messages.length - 1];
  if (!latest || latest.role !== "user") throw Errors.invalid("The last message must be from you.");

  const sources: MessageSource[] = [];
  const onActivity = (text: string) => emit({ type: "activity", text });
  const addSource = (s: Omit<MessageSource, "id">) => {
    const found = sources.find((x) => x.url === s.url);
    if (found) return found;
    const src = { ...s, id: sources.length + 1 };
    sources.push(src);
    emit({ type: "sources", sources: [...sources] });
    return src;
  };

  // ---------- Web research ----------
  const webBlocks: string[] = [];
  let searched = false;
  const searchAvailable = isSearchAvailable() && input.allowSearch;
  const wantResearch =
    searchAvailable &&
    (mode.research === "always" || input.deepResearch || (mode.research === "auto" && input.webSearch) || (mode.research === "auto" && looksLikeWebQuestion(latest.content)));
  if (wantResearch) {
    const fast = resolveFastModel();
    const r = await runResearch(latest.content, { planner: fast ? { provider: fast.provider, model: fast.info.model } : null, deep: input.deepResearch, onActivity, signal: input.signal });
    searched = r.searched;
    if (r.searched && r.sources.length) {
      for (const s of r.sources) addSource({ title: s.title, url: s.url, snippet: s.snippet, publishedAt: s.publishedAt });
      webBlocks.push(r.context);
    } else onActivity(r.searched ? "Web search returned no results" : "Web search is temporarily unavailable — answering from model knowledge");
  } else if ((input.webSearch || input.deepResearch) && !searchAvailable) {
    onActivity(isSearchAvailable() ? "Web search limit reached — answering from model knowledge" : "Web search isn't set up on this server — answering from model knowledge");
  }
  if (input.allowSearch) {
    for (const url of urlsInText(latest.content).slice(0, 2)) {
      try {
        onActivity(`Reading ${new URL(url).hostname}`);
        const page = await readUrl(normalizeUrl(url), { query: latest.content, maxChars: 8000 });
        const s = addSource({ title: page.title, url: page.url, snippet: page.description });
        webBlocks.push(`[${s.id}] ${page.title}\nURL: ${page.url}\n---\n${page.text}`);
      } catch (e) {
        onActivity(`Couldn't read ${url.slice(0, 80)} (${e instanceof Error ? e.message.replace(/^URL blocked: /, "") : "error"})`);
      }
    }
  }

  // ---------- Prompt ----------
  const system = buildSystemPrompt({
    mode,
    userName: input.userName,
    customInstructions: input.customInstructions,
    responseStyle: null,
    projectName: null,
    projectInstructions: null,
    memories: [],
    relatedConversations: [],
    toolsAvailable: [],
    webSearchAvailable: searchAvailable,
    timezone: input.timezone,
  });
  let text = latest.content;
  const fileBudget = Math.floor(input.maxContextTokens * 0.45) * 4; // ~4 chars per token
  if (input.files.length) {
    let used = 0;
    const parts: string[] = [];
    for (const f of input.files) {
      const room = fileBudget - used;
      if (room <= 200) break;
      const t = f.text.slice(0, room);
      used += t.length;
      parts.push(`### ${f.name}${t.length < f.text.length ? " (truncated)" : ""}\n${t}`);
    }
    text = `<user_files trust="untrusted-data">\n${parts.join("\n\n")}\n</user_files>\n\n${text}`;
    onActivity(`Read ${input.files.length} attached file${input.files.length > 1 ? "s" : ""}`);
  }
  if (webBlocks.length)
    text = `<web_sources retrieved="${new Date().toISOString()}" trust="untrusted-data">\n${webBlocks.join("\n\n=====\n\n")}\n</web_sources>\n\nAnswer using the sources above and cite them as [n]. If they don't answer the question, say so.\n\n${text}`;
  let latestParts: string | ContentPart[] = text;
  if (input.images.length) {
    if (info.capabilities.vision) latestParts = [{ type: "text", text }, ...input.images.map((i) => ({ type: "image" as const, mimeType: i.mimeType, data: i.data }))];
    else latestParts = `${text}\n\n[The user attached ${input.images.length} image(s), but the selected model can't view images — say so and suggest a vision-capable model.]`;
  }
  const history = input.messages.slice(0, -1).map((m, i) => ({ id: String(i), role: m.role, content: m.content }));
  const chat = fitToBudget(system, history, "latest", latestParts, input.maxContextTokens);

  // ---------- Stream ----------
  let content = "";
  let inTok = 0;
  let outTok = 0;
  try {
    const stream = await openStream(
      provider,
      info,
      { messages: chat, maxOutputTokens: input.maxOutputTokens, temperature: mode.temperature, reasoning: mode.reasoning && info.capabilities.reasoning, signal: input.signal },
      true,
      (fb) => {
        onActivity(`${info.label} was unavailable — switched to ${fb.info.label}`);
        info = fb.info;
        provider = fb.provider;
      },
    );
    for await (const ev of stream) {
      if (ev.type === "text") {
        content += ev.delta;
        emit({ type: "text", delta: ev.delta });
      } else if (ev.type === "usage") {
        inTok += ev.inputTokens ?? 0;
        outTok += ev.outputTokens ?? 0;
      }
    }
  } catch (e) {
    if (!input.signal.aborted) {
      const looksLikeAi = e instanceof ProviderError || (e instanceof TypeError && /fetch failed/i.test(e.message));
      throw e instanceof AppError ? e : looksLikeAi ? explainProviderFailure(info, e) : e;
    }
  }
  let title: string | undefined;
  if (input.wantTitle && content && !input.signal.aborted) title = await generateTitle(latest.content, content).catch(() => undefined);
  emit({ type: "done", messageId: "", title, usage: { inputTokens: inTok, outputTokens: outTok }, stopped: input.signal.aborted, provenance: webBlocks.length ? ["model", "web"] : ["model"] });
  return { model: info.id, provider: info.provider, inputTokens: inTok, outputTokens: outTok, searched };
}
