import type { z } from "zod";
import type { MessageSource } from "@/lib/database/schema";

export type ToolContext = {
  userId: string;
  role: "user" | "admin";
  conversationId: string;
  projectId: string | null;
  memoryEnabled: boolean;
  /** Document ids attached to this conversation (for file_search scoping). */
  documentIds: string[];
  signal?: AbortSignal;
  /** The current user message (trusted input). Used for intent checks such as explicit "remember". */
  userMessage: string;
  /**
   * URLs the model may fetch: typed by the user, returned by search, or linked from pages already read.
   * Prevents prompt-injected content from making the model construct exfiltration URLs.
   */
  allowedUrls: Set<string>;
  /** Let tools report citations so the UI can show them. */
  addSources: (s: Omit<MessageSource, "id">[]) => MessageSource[];
  onActivity: (text: string) => void;
};

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };

export interface Tool<I extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  input: I;
  /** Whether this tool may be offered/executed for this user/context. */
  permission: (ctx: ToolContext) => boolean;
  timeoutMs: number;
  /** Per-user rate limit for this tool. */
  rateLimit?: { limit: number; windowSec: number };
  /** Short, user-facing label for activity display. */
  activity: (input: z.infer<I>) => string;
  execute: (input: z.infer<I>, ctx: ToolContext) => Promise<unknown>;
}

// Erase the specific input type so heterogeneous tools can live in one registry (input is re-validated at runtime).
export const defineTool = <I extends z.ZodTypeAny>(t: Tool<I>) => t as unknown as Tool;
