import "server-only";
import type { AIProvider, ChatMessage } from "./types";

/** Non-streaming helper built on the streaming interface (for titles, query planning, etc.). */
export async function completeText(
  provider: AIProvider,
  model: string,
  messages: ChatMessage[],
  opts: { maxOutputTokens?: number; temperature?: number; signal?: AbortSignal } = {},
): Promise<string> {
  let out = "";
  for await (const ev of provider.stream({ model, messages, maxOutputTokens: opts.maxOutputTokens ?? 400, temperature: opts.temperature ?? 0.2, signal: opts.signal })) {
    if (ev.type === "text") out += ev.delta;
  }
  return out.trim();
}

/** Extract the first JSON object/array from model output (models sometimes wrap JSON in prose or fences). */
export function extractJson<T = unknown>(text: string): T | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  const start = candidate.search(/[[{]/);
  if (start === -1) return null;
  const open = candidate[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) {
      try {
        return JSON.parse(candidate.slice(start, i + 1)) as T;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export const approxTokens = (s: string) => Math.ceil(s.length / 4);
