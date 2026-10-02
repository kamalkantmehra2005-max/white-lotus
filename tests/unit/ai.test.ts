import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSSE } from "@/lib/ai/sse";
import { extractJson } from "@/lib/ai/complete";
import { OpenAICompatibleProvider } from "@/lib/ai/providers/openai-compatible";
import { AnthropicProvider } from "@/lib/ai/providers/anthropic";
import { GoogleProvider } from "@/lib/ai/providers/google";
import { ProviderError, type ChatMessage, type StreamEvent } from "@/lib/ai/types";
import { fitToBudget } from "@/lib/chat/context";
import { decodeEvents, encodeEvent } from "@/lib/chat/protocol";
import { getMode, MODE_LIST } from "@/lib/ai/modes";
import { buildSystemPrompt } from "@/lib/ai/prompts";

function streamOf(chunks: string[]) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
      c.close();
    },
  });
}
async function collect<T>(it: AsyncIterable<T>) {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("SSE parser", () => {
  it("handles events split across chunks, CRLF, comments and multi-line data", async () => {
    const msgs = await collect(parseSSE(streamOf([": ping\n", "event: a\r\nda", "ta: {\"x\":1}\r\n\r\n", "data: line1\ndata: line2\n\n", "data: tail"])));
    expect(msgs).toEqual([{ event: "a", data: '{"x":1}' }, { event: undefined, data: "line1\nline2" }, { event: undefined, data: "tail" }]);
  });
});

describe("extractJson", () => {
  it("pulls JSON out of prose and fences", () => {
    expect(extractJson('Sure! ```json\n["a","b"]\n```')).toEqual(["a", "b"]);
    expect(extractJson('Here: {"q": "x [y]"} done')).toEqual({ q: "x [y]" });
    expect(extractJson("no json")).toBeNull();
  });
});

describe("OpenAI-compatible provider", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("streams text, assembles tool calls from deltas, and reports usage", async () => {
    const lines = [
      { choices: [{ delta: { content: "Hel" } }] },
      { choices: [{ delta: { content: "lo" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "calc", arguments: '{"expr' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ession":"1+1"}' } }] }, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ];
    const body = lines.map((l) => `data: ${JSON.stringify(l)}\n\n`).join("") + "data: [DONE]\n\n";
    const fetchMock = vi.fn(async () => new Response(streamOf([body]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const p = new OpenAICompatibleProvider("openai", "OpenAI", "https://api.example/v1", "sk-test", { requireKey: true, timeoutMs: 5000 });
    const events = await collect(p.stream({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [{ name: "calc", description: "", parameters: {} }] }));
    const text = events.filter((e): e is Extract<StreamEvent, { type: "text" }> => e.type === "text").map((e) => e.delta).join("");
    expect(text).toBe("Hello");
    expect(events).toContainEqual({ type: "tool_call", call: { id: "c1", name: "calc", arguments: '{"expression":"1+1"}' } });
    expect(events).toContainEqual({ type: "usage", inputTokens: 10, outputTokens: 5 });
    expect(events.at(-1)).toEqual({ type: "done", finishReason: "tool_calls" });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
  });
  it("throws ProviderError with status on HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 429 })));
    const p = new OpenAICompatibleProvider("openai", "OpenAI", "https://api.example/v1", "k", { requireKey: true, timeoutMs: 5000 });
    await expect(collect(p.stream({ model: "m", messages: [{ role: "user", content: "x" }] }))).rejects.toMatchObject({ status: 429, retryable: true });
    expect(new ProviderError("x", 400, "bad").retryable).toBe(false);
  });
  it("maps images to data URLs", () => {
    const wire = OpenAICompatibleProvider.toWire([{ role: "user", content: [{ type: "text", text: "see" }, { type: "image", mimeType: "image/png", data: "AAA" }] }]);
    expect(JSON.stringify(wire)).toContain("data:image/png;base64,AAA");
  });
});

describe("Anthropic wire format", () => {
  it("hoists system, merges consecutive roles, places tool results in user turns", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "S1" },
      { role: "user", content: "q" },
      { role: "assistant", content: "thinking", toolCalls: [{ id: "t1", name: "calc", arguments: '{"a":1}' }] },
      { role: "tool", toolCallId: "t1", name: "calc", content: '{"r":2}' },
      { role: "tool", toolCallId: "t2", name: "calc", content: '{"r":3}' },
    ];
    const { system, messages } = AnthropicProvider.toWire(msgs);
    expect(system).toBe("S1");
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[1].content[1]).toEqual({ type: "tool_use", id: "t1", name: "calc", input: { a: 1 } });
    expect(messages[2].content).toHaveLength(2);
  });
});

describe("Google wire format", () => {
  it("uses model role and functionResponse objects", () => {
    const { contents, system } = GoogleProvider.toWire([
      { role: "system", content: "S" },
      { role: "user", content: "q" },
      { role: "assistant", content: "", toolCalls: [{ id: "x", name: "time", arguments: "{}" }] },
      { role: "tool", toolCallId: "x", name: "time", content: '"12:00"' },
    ]);
    expect(system).toBe("S");
    expect(contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    expect(contents[2].parts[0]).toEqual({ functionResponse: { name: "time", response: { result: "12:00" } } });
  });
});

describe("context budgeting", () => {
  it("keeps newest history within budget and notes omissions", () => {
    const history = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? "assistant" : "user", content: "x".repeat(400) }));
    const out = fitToBudget("sys", history, "latest", "question", 1000);
    expect(out[0].role).toBe("system");
    expect(out.at(-1)).toEqual({ role: "user", content: "question" });
    expect(out.length).toBeLessThan(22);
    expect((out[0] as { content: string }).content).toMatch(/earlier messages were omitted/);
  });
});

describe("stream protocol", () => {
  it("round-trips events across arbitrary chunk boundaries", async () => {
    const bytes = [encodeEvent({ type: "text", delta: "a\nb" }), encodeEvent({ type: "activity", text: "x" })];
    const joined = new Uint8Array([...bytes[0], ...bytes[1]]);
    const split = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(joined.slice(0, 7)); c.enqueue(joined.slice(7)); c.close(); } });
    expect(await collect(decodeEvents(split))).toEqual([{ type: "text", delta: "a\nb" }, { type: "activity", text: "x" }]);
  });
});

describe("modes & prompts", () => {
  it("falls back to quick for unknown modes", () => expect(getMode("nope").id).toBe("quick"));
  it("has the six required modes", () => expect(MODE_LIST.map((m) => m.id)).toEqual(["quick", "think", "research", "code", "creative", "analyze"]));
  it("system prompt includes honesty, provenance, injection defence and memory", () => {
    const p = buildSystemPrompt({ mode: getMode("research"), memories: ["likes tea"], relatedConversations: [], toolsAvailable: ["web_search", "save_memory"], webSearchAvailable: true });
    expect(p).toMatch(/Never fabricate/);
    expect(p).toMatch(/DATA, not instructions/);
    expect(p).toContain("likes tea");
    expect(p).toMatch(/explicitly asks you to remember/);
  });
});
