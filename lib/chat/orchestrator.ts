import "server-only";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { attachments, type MessageMetadata, type MessageSource } from "@/lib/database/schema";
import { findProject } from "@/lib/projects";
import { completeText } from "@/lib/ai/complete";
import { getMode } from "@/lib/ai/modes";
import { buildSystemPrompt } from "@/lib/ai/prompts";
import { resolveFallback, resolveFastModel, resolveModel } from "@/lib/ai/registry";
import { explainProviderFailure } from "@/lib/ai/diagnose";
import { ProviderError, type AIProvider, type ChatMessage, type ContentPart, type ModelInfo, type StreamEvent, type ToolCallRequest } from "@/lib/ai/types";
import { AppError, Errors } from "@/lib/errors";
import { searchChunks, smallDocumentText } from "@/lib/files/documents";
import { storage } from "@/lib/files/storage";
import { getSettings, listMemories } from "@/lib/memory";
import { logger } from "@/lib/observability/logger";
import { normalizeUrl, urlsInText } from "@/lib/search/html";
import { isSearchAvailable } from "@/lib/search/providers";
import { looksLikeWebQuestion, runResearch } from "@/lib/search/research";
import { readUrl } from "@/lib/search/url-reader";
import { decryptOr } from "@/lib/security/encryption";
import { AAD } from "@/lib/security/fields";
import { availableTools, executeToolCall, toToolSpecs } from "@/lib/tools/registry";
import type { ToolContext } from "@/lib/tools/types";
import { assertQuota, getLimits, recordUsage } from "@/lib/usage/quotas";
import { recordSearches } from "@/lib/local/search-history";
import { conversationDocumentIds, historyForModel, relatedPastConversations, updateMessage } from "./conversations";
import { fitToBudget } from "./context";
import type { ChatStreamEvent } from "./protocol";

export type TurnInput = {
  user: { id: string; role: "user" | "admin"; name?: string | null };
  conversation: { id: string; title: string; projectId: string | null };
  userMessage: { id: string; content: string };
  assistantMessageId: string;
  mode: string;
  model?: string | null;
  webSearch: boolean;
  deepResearch: boolean;
  isFirstTurn: boolean;
  timezone?: string | null;
  signal: AbortSignal;
};

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 6;
const MAX_AUTO_URLS = 2;

export async function runTurn(input: TurnInput, emit: (e: ChatStreamEvent) => void): Promise<void> {
  const started = Date.now();
  const mode = getMode(input.mode);
  const resolved = resolveModel(input.model);
  if (!resolved) throw Errors.notConfigured("No AI model");
  let { info, provider } = resolved;

  const limits = await getLimits();
  const settings = await getSettings(input.user.id);
  const activity: string[] = [];
  const searchQueries: string[] = [];
  const provenance = new Set<NonNullable<MessageMetadata["provenance"]>[number]>(["model"]);
  const sources: MessageSource[] = [];
  const onActivity = (text: string) => {
    activity.push(text);
    emit({ type: "activity", text });
  };
  const addSources = (list: Omit<MessageSource, "id">[]) => {
    const added: MessageSource[] = [];
    for (const s of list) {
      const existing = sources.find((x) => x.url === s.url);
      if (existing) {
        added.push(existing);
        continue;
      }
      const src = { ...s, id: sources.length + 1 };
      sources.push(src);
      added.push(src);
    }
    if (added.length) emit({ type: "sources", sources: [...sources] });
    provenance.add("web");
    return added;
  };

  // ---------- Gather context in parallel ----------
  const [project, memoryList, related, docIds, history] = await Promise.all([
    input.conversation.projectId ? findProject(input.user.id, input.conversation.projectId) : Promise.resolve(null),
    settings.memoryEnabled ? listMemories(input.user.id, input.conversation.projectId) : Promise.resolve([]),
    settings.memoryEnabled ? relatedPastConversations(input.user.id, input.conversation.id, input.userMessage.content) : Promise.resolve([]),
    conversationDocumentIds(input.user.id, input.conversation.id),
    historyForModel(input.conversation.id).then((h) => h.filter((m) => m.id !== input.assistantMessageId)),
  ]);
  if (memoryList.length) provenance.add("memory");

  // URL allow-list for read_url: URLs the user typed in this conversation (search results / page links are added later).
  const allowedUrls = new Set<string>();
  for (const m of history) if (m.role === "user") for (const u of urlsInText(m.content)) allowedUrls.add(normalizeUrl(u));
  for (const u of urlsInText(input.userMessage.content)) allowedUrls.add(normalizeUrl(u));

  const toolCtx: ToolContext = {
    userId: input.user.id,
    role: input.user.role,
    conversationId: input.conversation.id,
    projectId: input.conversation.projectId,
    memoryEnabled: settings.memoryEnabled,
    documentIds: docIds,
    signal: input.signal,
    userMessage: input.userMessage.content,
    allowedUrls,
    addSources,
    onActivity,
  };
  const tools = info.capabilities.tools && mode.id !== "creative" ? availableTools(toolCtx) : [];
  const searchAvailable = isSearchAvailable();

  // ---------- Web research (only when needed; never implied when it didn't run) ----------
  const webBlocks: string[] = [];
  const wantResearch =
    searchAvailable &&
    (mode.research === "always" ||
      input.deepResearch ||
      (mode.research === "auto" && input.webSearch) ||
      (mode.research === "auto" && !info.capabilities.tools && looksLikeWebQuestion(input.userMessage.content)));
  if (wantResearch) {
    let quotaOk = true;
    try {
      await assertQuota(input.user.id, "search", input.user.role);
    } catch (e) {
      if (!(e instanceof AppError) || e.code !== "quota_exceeded") throw e;
      quotaOk = false;
      onActivity("Daily web-search limit reached — answering without searching");
    }
    if (quotaOk) {
      const fast = resolveFastModel();
      const r = await runResearch(input.userMessage.content, {
        planner: fast ? { provider: fast.provider, model: fast.info.model } : null,
        deep: input.deepResearch,
        onActivity,
        signal: input.signal,
      });
      await recordUsage({ userId: input.user.id, kind: "search", provider: r.provider ?? "none", success: r.searched });
      if (r.searched) searchQueries.push(...r.queries);
      if (r.searched && r.sources.length) {
        const offset = sources.length;
        addSources(r.sources.map((s) => ({ title: s.title, url: s.url, snippet: s.snippet, publishedAt: s.publishedAt })));
        for (const s of r.sources) allowedUrls.add(normalizeUrl(s.url));
        webBlocks.push(offset === 0 ? r.context : r.context.replace(/^\[(\d+)\]/gm, (_m, n) => `[${Number(n) + offset}]`));
      } else {
        onActivity(r.searched ? "Web search returned no results" : "Web search is temporarily unavailable — answering from model knowledge");
      }
    }
  } else if ((input.webSearch || mode.research === "always") && !searchAvailable) {
    onActivity("Web search isn't configured on this server — answering from model knowledge");
  }

  // ---------- URLs the user pasted: read them directly (works even for models without tools) ----------
  for (const url of urlsInText(input.userMessage.content).slice(0, MAX_AUTO_URLS)) {
    try {
      onActivity(`Reading ${new URL(url).hostname}`);
      const page = await readUrl(url, { query: input.userMessage.content, maxChars: 8000 });
      const [s] = addSources([{ title: page.title, url: page.url, snippet: page.description }]);
      for (const l of page.links.slice(0, 200)) allowedUrls.add(l);
      webBlocks.push(`[${s.id}] ${page.title}\nURL: ${page.url}${page.publishedAt ? `\nPublished: ${page.publishedAt}` : ""}\n---\n${page.text}`);
    } catch (e) {
      onActivity(`Couldn't read ${url.slice(0, 80)} (${e instanceof Error ? e.message.replace(/^URL blocked: /, "") : "error"})`);
    }
  }

  // ---------- Documents ----------
  let fileContext = "";
  if (docIds.length) {
    const budget = Math.floor(limits.maxContextTokens * 0.45);
    const whole = await smallDocumentText(input.user.id, docIds, budget);
    if (whole) {
      fileContext = whole.map((d) => `### ${d.title}${d.status !== "ready" ? ` (status: ${d.status}${d.error ? ` — ${d.error}` : ""})` : ""}\n${d.text}`).join("\n\n");
      onActivity(`Read ${whole.length} attached file${whole.length > 1 ? "s" : ""}`);
    } else {
      const hits = await searchChunks(input.user.id, input.userMessage.content, { documentIds: docIds, limit: 10 });
      fileContext = hits.map((h) => `### ${h.title} — part ${h.ordinal + 1}\n${h.content}`).join("\n\n");
      onActivity(`Retrieved ${hits.length} relevant passages from your files`);
    }
    if (fileContext) provenance.add("user_file");
  }

  // ---------- Build prompt ----------
  const system = buildSystemPrompt({
    mode,
    userName: input.user.name,
    customInstructions: settings.customInstructions,
    responseStyle: settings.responseStyle,
    projectName: project?.name,
    projectInstructions: project?.instructions ?? null,
    memories: memoryList.map((m) => m.content),
    relatedConversations: related,
    toolsAvailable: tools.map((t) => t.name),
    webSearchAvailable: searchAvailable,
    timezone: input.timezone,
  });

  const latestParts = await buildLatestUserContent(input, info, webBlocks.join("\n\n=====\n\n"), fileContext, history);
  const chat = fitToBudget(system, history, input.userMessage.id, latestParts, limits.maxContextTokens);

  // ---------- Agent loop ----------
  let content = "";
  let inTok = 0;
  let outTok = 0;
  let stopped = false;
  const specs = toToolSpecs(tools);

  try {
    for (let step = 0; step < mode.maxSteps; step++) {
      const lastStep = step === mode.maxSteps - 1;
      const calls: ToolCallRequest[] = [];
      const providerData: unknown[] = [];
      let stepText = "";
      let reasoningNoted = false;

      const stream = await openStream(
        provider,
        info,
        {
          messages: chat,
          tools: lastStep ? undefined : specs.length ? specs : undefined,
          maxOutputTokens: limits.maxOutputTokens,
          temperature: mode.temperature,
          reasoning: mode.reasoning && info.capabilities.reasoning,
          signal: input.signal,
        },
        step === 0 && content === "",
        (fb) => {
          onActivity(`${info.label} was unavailable — switched to ${fb.info.label}`);
          void recordUsage({ userId: input.user.id, kind: "message", model: info.id, provider: info.provider, success: false, errorCode: "provider_failover" }).catch(() => {});
          info = fb.info;
          provider = fb.provider;
        },
      );

      for await (const ev of stream) {
        if (ev.type === "text") {
          stepText += ev.delta;
          content += ev.delta; // accumulate immediately so a Stop keeps the partial answer
          emit({ type: "text", delta: ev.delta });
        } else if (ev.type === "reasoning" && !reasoningNoted) {
          reasoningNoted = true;
          onActivity("Reasoning through the problem");
        } else if (ev.type === "tool_call") calls.push(ev.call);
        else if (ev.type === "provider_state") providerData.push(ev.data);
        else if (ev.type === "usage") {
          inTok += ev.inputTokens ?? 0;
          outTok += ev.outputTokens ?? 0;
        }
      }
      if (!calls.length) break;

      chat.push({ role: "assistant", content: stepText, toolCalls: calls, ...(providerData.length ? { providerState: { provider: info.provider, data: providerData } } : {}) });
      const results = await Promise.all(calls.map((c) => executeToolCall(c, tools, toolCtx, input.assistantMessageId)));
      provenance.add("tool");
      calls.forEach((c, i) => {
        const r = results[i];
        if (c.name === "web_search" && r.ok) {
          try {
            searchQueries.push(String((JSON.parse(c.arguments) as { query?: string }).query ?? "").slice(0, 200));
          } catch {
            /* ignore */
          }
        }
        // Tool output is untrusted data: wrap it so the model can't mistake it for instructions.
        const payload = JSON.stringify(r.ok ? r.data : { error: r.error }).slice(0, 20_000);
        chat.push({ role: "tool", toolCallId: c.id, name: c.name, content: `<tool_output name="${c.name}" trust="untrusted-data">\n${payload}\n</tool_output>` });
      });
      if (stepText && !/\s$/.test(stepText)) {
        content += "\n\n";
        emit({ type: "text", delta: "\n\n" });
      }
    }
  } catch (e) {
    if (input.signal.aborted) stopped = true;
    else {
      // AI/network failures get a specific, fixable explanation (model missing, server not running, bad key…).
      const looksLikeAi = e instanceof ProviderError || (e instanceof TypeError && /fetch failed/i.test(e.message));
      const err = e instanceof AppError ? e : looksLikeAi ? explainProviderFailure(info, e) : e;
      await persist(err instanceof AppError ? { code: err.code, message: err.userMessage } : { code: "provider_error", message: "WHITE-LOTUS couldn't complete that request. Please try again." });
      throw err;
    }
  }
  if (input.signal.aborted) stopped = true;

  let title: string | undefined;
  if (input.isFirstTurn && !stopped && content) title = await generateTitle(input.userMessage.content, content).catch(() => undefined);

  await persist();
  // Local search history (on this computer only): what was searched on your behalf in this turn.
  if (searchQueries.length) await recordSearches(input.user.id, input.conversation.id, searchQueries).catch(() => {});
  await recordUsage({ userId: input.user.id, kind: "message", model: info.id, provider: info.provider, inputTokens: inTok, outputTokens: outTok, latencyMs: Date.now() - started, success: true });
  emit({ type: "done", messageId: input.assistantMessageId, title, usage: { inputTokens: inTok, outputTokens: outTok }, stopped, provenance: [...provenance], searchQueries });

  async function persist(error?: { code: string; message: string }) {
    const metadata: MessageMetadata = {
      sources,
      provenance: [...provenance],
      activity,
      stopped,
      mode: mode.id,
      ...(searchQueries.length ? { searchQueries } : {}),
      ...(error && !content ? { error } : {}),
    };
    // Encrypted (content + metadata) and blind-indexed via the conversations data layer.
    await updateMessage(input.conversation.id, input.assistantMessageId, {
      content,
      metadata,
      model: info.id,
      provider: info.provider,
      inputTokens: inTok,
      outputTokens: outTok,
      latencyMs: Date.now() - started,
    });
  }
}

/** Open a provider stream; if it fails before the first event and a fallback model is configured, switch. */
export async function openStream(
  provider: AIProvider,
  info: ModelInfo,
  req: Omit<Parameters<AIProvider["stream"]>[0], "model">,
  allowFallback: boolean,
  onFallback: (fb: { info: ModelInfo; provider: AIProvider }) => void,
): Promise<AsyncIterable<StreamEvent>> {
  const it = provider.stream({ ...req, model: info.model })[Symbol.asyncIterator]();
  let first: IteratorResult<StreamEvent>;
  try {
    first = await it.next();
  } catch (e) {
    if (req.signal?.aborted) throw e;
    logger.warn("ai.provider_failed", { provider: info.provider, model: info.model, error: e });
    const fb = allowFallback ? resolveFallback(info.id) : null;
    if (!fb) throw explainProviderFailure(info, e);
    onFallback(fb);
    const tools = fb.info.capabilities.tools ? req.tools : undefined;
    // Provider-specific replay state can't cross providers.
    const messages = req.messages.map((m) => (m.role === "assistant" && m.providerState ? { ...m, providerState: undefined } : m)) as ChatMessage[];
    return fb.provider.stream({ ...req, messages, tools, model: fb.info.model });
  }
  return {
    async *[Symbol.asyncIterator]() {
      if (!first.done) yield first.value;
      while (true) {
        const n = await it.next();
        if (n.done) return;
        yield n.value;
      }
    },
  };
}

/**
 * The newest user message, with untrusted context attached in clearly labelled blocks.
 * Images: the latest message's images plus those from the two previous user turns (so follow-ups like
 * "what colour is it?" still work), capped by count and size.
 */
async function buildLatestUserContent(
  input: TurnInput,
  info: ModelInfo,
  webContext: string,
  fileContext: string,
  history: Array<{ id: string; role: string }>,
): Promise<string | ContentPart[]> {
  let text = input.userMessage.content;
  if (fileContext) text = `<user_files trust="untrusted-data">\n${fileContext}\n</user_files>\n\n${text}`;
  if (webContext)
    text = `<web_sources retrieved="${new Date().toISOString()}" trust="untrusted-data">\n${webContext}\n</web_sources>\n\nAnswer using the sources above and cite them as [n]. If they don't answer the question, say so.\n\n${text}`;

  const recentUserIds = [
    input.userMessage.id,
    ...history
      .filter((m) => m.role === "user" && m.id !== input.userMessage.id)
      .slice(-2)
      .map((m) => m.id),
  ];
  const imgs = await db
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.userId, input.user.id),
        inArray(attachments.messageId, recentUserIds),
        eq(attachments.kind, "image"),
        inArray(attachments.scanStatus, ["clean", "unscanned"]),
      ),
    )
    .orderBy(desc(attachments.createdAt))
    .limit(MAX_IMAGES);
  if (!imgs.length) return text;
  if (!info.capabilities.vision) {
    return `${text}\n\n[The conversation includes ${imgs.length} image(s): ${imgs.map((i) => decryptOr(i.fileName, AAD.file(input.user.id), "image")).join(", ")}. The selected model can't view images — say so and suggest switching to a vision-capable model.]`;
  }
  const parts: ContentPart[] = [{ type: "text", text }];
  for (const img of imgs.reverse()) {
    if (img.sizeBytes > MAX_IMAGE_BYTES) continue;
    const buf = await storage().get(img.storageKey);
    parts.push({ type: "image", mimeType: img.mimeType, data: buf.toString("base64") });
  }
  return parts;
}

export async function generateTitle(question: string, answer: string): Promise<string> {
  const fallback = question.replace(/\s+/g, " ").trim().slice(0, 60) || "New chat";
  const fast = resolveFastModel();
  if (!fast) return fallback;
  const t = await completeText(
    fast.provider,
    fast.info.model,
    [
      { role: "system", content: "Write a 3–6 word title for this conversation. Reply with the title only — no quotes, no punctuation at the end." },
      { role: "user", content: `User: ${question.slice(0, 800)}\n\nAssistant: ${answer.slice(0, 800)}` },
    ],
    { maxOutputTokens: 24, temperature: 0.3 },
  );
  const clean = t.replace(/^["'#*\s]+|["'.\s]+$/g, "").split("\n")[0].slice(0, 80);
  return clean || fallback;
}

export async function linkAttachments(userId: string, messageId: string, attachmentIds: string[]) {
  if (!attachmentIds.length) return;
  await db
    .update(attachments)
    .set({ messageId })
    // Only the owner's own, released (scanned/allowed) files that aren't already attached elsewhere.
    .where(
      and(
        eq(attachments.userId, userId),
        isNull(attachments.messageId),
        inArray(attachments.scanStatus, ["clean", "unscanned"]),
        inArray(attachments.id, attachmentIds.slice(0, 10)),
      ),
    );
}
