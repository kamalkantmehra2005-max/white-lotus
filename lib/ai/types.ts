/** Provider-neutral types for the WHITE-LOTUS AI layer. */

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string /* base64 */ };

export type ToolCallRequest = { id: string; name: string; arguments: string /* JSON */ };

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | {
      role: "assistant";
      content: string;
      toolCalls?: ToolCallRequest[];
      /** Opaque provider data that must be replayed verbatim on the next request (Anthropic thinking blocks, Gemini thought signatures). */
      providerState?: { provider: string; data: unknown[] };
    }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };

export type ModelCapabilities = { vision: boolean; tools: boolean; reasoning: boolean };

export type ModelInfo = {
  id: string; // "<provider>:<model>"
  provider: string;
  model: string;
  label: string;
  capabilities: ModelCapabilities;
  contextWindow: number;
};

export type ChatRequest = {
  model: string; // provider-local model name
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxOutputTokens?: number;
  temperature?: number;
  reasoning?: boolean; // enable provider-native extended reasoning when supported
  signal?: AbortSignal;
};

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning" } // provider is reasoning; content intentionally NOT surfaced
  | { type: "tool_call"; call: ToolCallRequest }
  | { type: "provider_state"; data: unknown } // opaque item to replay with the assistant turn (never shown to users)
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | { type: "done"; finishReason: "stop" | "tool_calls" | "length" | "error" | "other" };

export interface AIProvider {
  readonly id: string;
  readonly label: string;
  isConfigured(): boolean;
  stream(req: ChatRequest): AsyncIterable<StreamEvent>;
}

export class ProviderError extends Error {
  constructor(
    public provider: string,
    public status: number,
    message: string,
    public retryable = status >= 500 || status === 429,
  ) {
    super(`[${provider}] ${status}: ${message}`);
  }
}
