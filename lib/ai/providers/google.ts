import { parseSSE } from "../sse";
import { ProviderError, type AIProvider, type ChatMessage, type ChatRequest, type StreamEvent } from "../types";

type Part =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } }
  | { functionCall: { name: string; args: unknown }; thoughtSignature?: string }
  | { functionResponse: { name: string; response: unknown } };

/** Google Gemini via the Generative Language API (streamGenerateContent, SSE). */
export class GoogleProvider implements AIProvider {
  readonly id = "google";
  readonly label = "Google Gemini";
  constructor(
    private readonly apiKey: string | undefined,
    private readonly timeoutMs = 120_000,
    private readonly baseUrl = "https://generativelanguage.googleapis.com/v1beta",
  ) {}

  isConfigured() {
    return Boolean(this.apiKey);
  }

  static toWire(messages: ChatMessage[]) {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content as string).join("\n\n");
    const contents: Array<{ role: "user" | "model"; parts: Part[] }> = [];
    const push = (role: "user" | "model", parts: Part[]) => {
      const last = contents[contents.length - 1];
      if (last && last.role === role) last.parts.push(...parts);
      else contents.push({ role, parts });
    };
    for (const m of messages) {
      if (m.role === "user") {
        push(
          "user",
          typeof m.content === "string"
            ? [{ text: m.content || " " }]
            : m.content.map((p) => (p.type === "text" ? { text: p.text } : { inline_data: { mime_type: p.mimeType, data: p.data } })),
        );
      } else if (m.role === "assistant") {
        const parts: Part[] = [];
        if (m.content) parts.push({ text: m.content });
        const sigs = m.providerState?.provider === "google" ? (m.providerState.data as Array<{ id: string; thoughtSignature: string }>) : [];
        for (const c of m.toolCalls ?? []) {
          let args: unknown = {};
          try {
            args = JSON.parse(c.arguments || "{}");
          } catch {
            /* ignore */
          }
          const sig = sigs.find((s) => s.id === c.id)?.thoughtSignature;
          parts.push({ functionCall: { name: c.name, args }, ...(sig ? { thoughtSignature: sig } : {}) });
        }
        if (parts.length) push("model", parts);
      } else if (m.role === "tool") {
        let response: unknown;
        try {
          response = JSON.parse(m.content);
        } catch {
          response = { result: m.content };
        }
        if (typeof response !== "object" || response === null || Array.isArray(response)) response = { result: response };
        push("user", [{ functionResponse: { name: m.name, response } }]);
      }
    }
    return { system, contents };
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    const { system, contents } = GoogleProvider.toWire(req.messages);
    const body: Record<string, unknown> = {
      contents,
      generationConfig: { maxOutputTokens: req.maxOutputTokens, temperature: req.temperature },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (req.tools?.length) body.tools = [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.parameters) })) }];

    const url = `${this.baseUrl}/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey! },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) throw new ProviderError(this.id, res.status, (await res.text().catch(() => "")).slice(0, 300));

    let sawTool = false;
    let finish: string | undefined;
    let n = 0;
    for await (const msg of parseSSE(res.body, req.signal)) {
      let json: {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean; thoughtSignature?: string; functionCall?: { name: string; args?: unknown } }> }; finishReason?: string }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      try {
        json = JSON.parse(msg.data);
      } catch {
        continue;
      }
      const cand = json.candidates?.[0];
      for (const p of cand?.content?.parts ?? []) {
        if (p.thought) yield { type: "reasoning" };
        else if (p.text) yield { type: "text", delta: p.text };
        if (p.functionCall) {
          sawTool = true;
          const id = `gcall_${Date.now()}_${n++}`;
          if (p.thoughtSignature) yield { type: "provider_state", data: { id, thoughtSignature: p.thoughtSignature } };
          yield { type: "tool_call", call: { id, name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) } };
        }
      }
      if (cand?.finishReason) finish = cand.finishReason;
      if (json.usageMetadata) yield { type: "usage", inputTokens: json.usageMetadata.promptTokenCount, outputTokens: json.usageMetadata.candidatesTokenCount };
    }
    yield { type: "done", finishReason: sawTool ? "tool_calls" : finish === "MAX_TOKENS" ? "length" : finish === "STOP" || !finish ? "stop" : "other" };
  }
}

/** Gemini accepts an OpenAPI subset; strip keys it rejects (additionalProperties, $schema, default, …). */
const GEMINI_KEYS = new Set(["type", "format", "description", "nullable", "enum", "properties", "required", "items", "minItems", "maxItems", "minimum", "maximum"]);
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (!GEMINI_KEYS.has(k)) continue;
    if (k === "properties" && v && typeof v === "object") {
      out.properties = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
    } else out[k] = k === "items" ? toGeminiSchema(v) : v;
  }
  return out;
}
