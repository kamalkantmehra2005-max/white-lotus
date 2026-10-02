import { parseSSE } from "../sse";
import { ProviderError, type AIProvider, type ChatMessage, type ChatRequest, type StreamEvent } from "../types";

/**
 * Works with OpenAI and any OpenAI-compatible Chat Completions server:
 * Ollama (/v1), vLLM, LM Studio, llama.cpp server, OpenRouter, Together, Groq, etc.
 */
export class OpenAICompatibleProvider implements AIProvider {
  constructor(
    public readonly id: string,
    public readonly label: string,
    private readonly baseUrl: string | undefined,
    private readonly apiKey: string | undefined,
    private readonly opts: { requireKey: boolean; timeoutMs: number; reasoningModels?: RegExp } = { requireKey: true, timeoutMs: 120_000 },
  ) {}

  isConfigured() {
    return Boolean(this.baseUrl) && (!this.opts.requireKey || Boolean(this.apiKey));
  }

  static toWire(messages: ChatMessage[]) {
    return messages.map((m) => {
      switch (m.role) {
        case "system":
          return { role: "system", content: m.content };
        case "user":
          return {
            role: "user",
            content:
              typeof m.content === "string"
                ? m.content
                : m.content.map((p) =>
                    p.type === "text"
                      ? { type: "text", text: p.text }
                      : { type: "image_url", image_url: { url: `data:${p.mimeType};base64,${p.data}` } },
                  ),
          };
        case "assistant":
          return {
            role: "assistant",
            content: m.content || (m.toolCalls?.length ? null : ""),
            ...(m.toolCalls?.length
              ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) }
              : {}),
          };
        case "tool":
          return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
      }
    });
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const timeout = AbortSignal.timeout(this.opts.timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    const isReasoningModel = this.opts.reasoningModels?.test(req.model) ?? false;
    const body: Record<string, unknown> = {
      model: req.model,
      messages: OpenAICompatibleProvider.toWire(req.messages),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.maxOutputTokens) body[isReasoningModel ? "max_completion_tokens" : "max_tokens"] = req.maxOutputTokens;
    if (req.temperature !== undefined && !isReasoningModel) body.temperature = req.temperature;
    if (req.reasoning && isReasoningModel) body.reasoning_effort = "high";
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
      body.tool_choice = "auto";
    }

    const res = await fetch(`${this.baseUrl!.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new ProviderError(this.id, res.status, text.slice(0, 300));
    }

    const pending = new Map<number, { id: string; name: string; args: string }>();
    let finish: StreamEvent & { type: "done" } = { type: "done", finishReason: "stop" };
    for await (const msg of parseSSE(res.body, req.signal)) {
      if (msg.data === "[DONE]") break;
      let json: {
        choices?: Array<{ delta?: { content?: string | null; reasoning_content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        error?: { message?: string };
      };
      try {
        json = JSON.parse(msg.data);
      } catch {
        continue;
      }
      if (json.error) throw new ProviderError(this.id, 500, json.error.message ?? "stream error");
      if (json.usage) yield { type: "usage", inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens };
      const choice = json.choices?.[0];
      if (!choice) continue;
      const d = choice.delta;
      if (d?.reasoning_content) yield { type: "reasoning" };
      if (d?.content) yield { type: "text", delta: d.content };
      (d?.tool_calls ?? []).forEach((tc, pos) => {
        // Some servers (older Ollama) omit `index` and send each call whole; key by id, then position.
        const idx = tc.index ?? (tc.id ? [...pending.entries()].find(([, v]) => v.id === tc.id)?.[0] ?? pending.size : pos);
        const cur = pending.get(idx) ?? { id: tc.id ?? `call_${idx}_${Date.now()}`, name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name && !cur.name.endsWith(tc.function.name)) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        pending.set(idx, cur);
      });
      if (choice.finish_reason) {
        finish = {
          type: "done",
          finishReason: choice.finish_reason === "tool_calls" ? "tool_calls" : choice.finish_reason === "length" ? "length" : choice.finish_reason === "stop" ? "stop" : "other",
        };
      }
    }
    for (const c of pending.values()) {
      if (c.name) yield { type: "tool_call", call: { id: c.id, name: c.name, arguments: c.args || "{}" } };
    }
    if (pending.size > 0) finish = { type: "done", finishReason: "tool_calls" };
    yield finish;
  }
}
