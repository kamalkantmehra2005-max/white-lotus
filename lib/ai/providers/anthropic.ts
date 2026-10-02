import { parseSSE } from "../sse";
import { ProviderError, type AIProvider, type ChatMessage, type ChatRequest, type StreamEvent } from "../types";

type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

export class AnthropicProvider implements AIProvider {
  readonly id = "anthropic";
  readonly label = "Anthropic";
  constructor(
    private readonly apiKey: string | undefined,
    private readonly timeoutMs = 120_000,
    private readonly baseUrl = "https://api.anthropic.com/v1",
  ) {}

  isConfigured() {
    return Boolean(this.apiKey);
  }

  /** Anthropic wants: top-level system, strictly alternating user/assistant, tool results inside user turns. */
  static toWire(messages: ChatMessage[]) {
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content as string)
      .join("\n\n");
    const out: Array<{ role: "user" | "assistant"; content: Block[] }> = [];
    const push = (role: "user" | "assistant", blocks: Block[]) => {
      if (blocks.length === 0) return;
      const last = out[out.length - 1];
      if (last && last.role === role) last.content.push(...blocks);
      else out.push({ role, content: blocks });
    };
    for (const m of messages) {
      if (m.role === "system") continue;
      if (m.role === "user") {
        const blocks: Block[] =
          typeof m.content === "string"
            ? [{ type: "text", text: m.content || " " }]
            : m.content.map((p) =>
                p.type === "text" ? { type: "text", text: p.text } : { type: "image", source: { type: "base64", media_type: p.mimeType, data: p.data } },
              );
        push("user", blocks);
      } else if (m.role === "assistant") {
        const blocks: Block[] = [];
        // Extended thinking + tool use: the signed thinking blocks must precede tool_use blocks, unmodified.
        if (m.providerState?.provider === "anthropic" && m.toolCalls?.length) blocks.push(...(m.providerState.data as Block[]));
        if (m.content) blocks.push({ type: "text", text: m.content });
        for (const c of m.toolCalls ?? []) {
          let input: unknown = {};
          try {
            input = JSON.parse(c.arguments || "{}");
          } catch {
            /* keep {} */
          }
          blocks.push({ type: "tool_use", id: c.id, name: c.name, input });
        }
        push("assistant", blocks);
      } else if (m.role === "tool") {
        push("user", [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }]);
      }
    }
    if (out[0]?.role === "assistant") out.unshift({ role: "user", content: [{ type: "text", text: "(continue)" }] });
    return { system, messages: out };
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    const { system, messages } = AnthropicProvider.toWire(req.messages);
    const maxTokens = req.maxOutputTokens ?? 4096;
    const body: Record<string, unknown> = { model: req.model, system, messages, max_tokens: maxTokens, stream: true };
    if (req.reasoning) {
      const budget = Math.max(1024, Math.min(8000, Math.floor(maxTokens * 0.6)));
      body.max_tokens = Math.max(maxTokens, budget + 2048);
      body.thinking = { type: "enabled", budget_tokens: budget };
    } else if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools?.length) body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));

    const res = await fetch(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": this.apiKey!, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) throw new ProviderError(this.id, res.status, (await res.text().catch(() => "")).slice(0, 300));

    const blocks = new Map<number, { kind: "text" | "tool_use" | "thinking" | "redacted" | "other"; id?: string; name?: string; json: string; thinking: string; signature: string; data?: string }>();
    let stop: string | undefined;
    for await (const msg of parseSSE(res.body, req.signal)) {
      let ev: {
        type: string;
        index?: number;
        message?: { usage?: { input_tokens?: number } };
        content_block?: { type: string; id?: string; name?: string; data?: string };
        delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string; thinking?: string; signature?: string };
        usage?: { output_tokens?: number };
        error?: { message?: string };
      };
      try {
        ev = JSON.parse(msg.data);
      } catch {
        continue;
      }
      switch (ev.type) {
        case "message_start":
          yield { type: "usage", inputTokens: ev.message?.usage?.input_tokens };
          break;
        case "content_block_start": {
          const t = ev.content_block?.type;
          blocks.set(ev.index!, {
            kind: t === "text" ? "text" : t === "tool_use" ? "tool_use" : t === "thinking" ? "thinking" : t === "redacted_thinking" ? "redacted" : "other",
            id: ev.content_block?.id,
            name: ev.content_block?.name,
            json: "",
            thinking: "",
            signature: "",
            data: ev.content_block?.data,
          });
          if (t === "thinking" || t === "redacted_thinking") yield { type: "reasoning" };
          break;
        }
        case "content_block_delta": {
          const b = blocks.get(ev.index!);
          if (ev.delta?.type === "text_delta" && ev.delta.text) yield { type: "text", delta: ev.delta.text };
          else if (ev.delta?.type === "input_json_delta" && b) b.json += ev.delta.partial_json ?? "";
          else if (ev.delta?.type === "thinking_delta" && b) b.thinking += ev.delta.thinking ?? "";
          else if (ev.delta?.type === "signature_delta" && b) b.signature += ev.delta.signature ?? "";
          break;
        }
        case "content_block_stop": {
          const b = blocks.get(ev.index!);
          if (b?.kind === "tool_use" && b.id && b.name) yield { type: "tool_call", call: { id: b.id, name: b.name, arguments: b.json || "{}" } };
          else if (b?.kind === "thinking") yield { type: "provider_state", data: { type: "thinking", thinking: b.thinking, signature: b.signature } };
          else if (b?.kind === "redacted" && b.data) yield { type: "provider_state", data: { type: "redacted_thinking", data: b.data } };
          break;
        }
        case "message_delta":
          if (ev.delta?.stop_reason) stop = ev.delta.stop_reason;
          if (ev.usage?.output_tokens) yield { type: "usage", outputTokens: ev.usage.output_tokens };
          break;
        case "error":
          throw new ProviderError(this.id, 500, ev.error?.message ?? "stream error");
      }
    }
    yield {
      type: "done",
      finishReason: stop === "tool_use" ? "tool_calls" : stop === "max_tokens" ? "length" : stop === "end_turn" || stop === "stop_sequence" ? "stop" : "other",
    };
  }
}
