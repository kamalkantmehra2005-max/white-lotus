import { approxTokens } from "@/lib/ai/complete";
import type { ChatMessage, ContentPart } from "@/lib/ai/types";

/** Keep the newest history that fits the context budget; always keep the system prompt and latest user message. */
export function fitToBudget(
  system: string,
  history: Array<{ id: string; role: string; content: string }>,
  latestId: string,
  latest: string | ContentPart[],
  maxTokens: number,
): ChatMessage[] {
  const latestText = typeof latest === "string" ? latest : latest.map((p) => (p.type === "text" ? p.text : "x".repeat(3000))).join("");
  let budget = maxTokens - approxTokens(system) - approxTokens(latestText);
  const kept: ChatMessage[] = [];
  const prior = history.filter((m) => m.id !== latestId);
  for (let i = prior.length - 1; i >= 0; i--) {
    const m = prior[i];
    if (m.role !== "user" && m.role !== "assistant") continue;
    if (!m.content) continue;
    const t = approxTokens(m.content);
    if (t > budget) break;
    budget -= t;
    kept.unshift(m.role === "user" ? { role: "user", content: m.content } : { role: "assistant", content: m.content });
  }
  const omitted = prior.filter((m) => m.content).length - kept.length;
  const out: ChatMessage[] = [{ role: "system", content: system + (omitted > 0 ? `\n\n(${omitted} earlier messages were omitted to fit the context window.)` : "") }];
  out.push(...kept, { role: "user", content: latest });
  return out;
}
