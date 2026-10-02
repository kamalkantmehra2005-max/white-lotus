/** Wire protocol between /api/chat and the browser: newline-delimited JSON events. Shared by server and client. */
import type { MessageSource } from "@/lib/database/schema";

export type ChatStreamEvent =
  | { type: "start"; conversationId: string; userMessageId: string; assistantMessageId: string; model: string; title: string }
  | { type: "activity"; text: string }
  | { type: "sources"; sources: MessageSource[] }
  | { type: "text"; delta: string }
  | { type: "done"; messageId: string; title?: string; usage?: { inputTokens: number; outputTokens: number }; stopped?: boolean; provenance?: string[]; searchQueries?: string[] }
  | { type: "error"; code: string; message: string; retryable: boolean };

export function encodeEvent(e: ChatStreamEvent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(e) + "\n");
}

export async function* decodeEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatStreamEvent> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) {
        try {
          yield JSON.parse(line) as ChatStreamEvent;
        } catch {
          /* ignore malformed line */
        }
      }
    }
  }
  if (buf.trim()) {
    try {
      yield JSON.parse(buf) as ChatStreamEvent;
    } catch {
      /* ignore */
    }
  }
}
