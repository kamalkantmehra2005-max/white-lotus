/** Assistant modes. Add a mode by adding an entry here — the UI and orchestrator read from this list. */
export type ModeId = "quick" | "think" | "research" | "code" | "creative" | "analyze";

export type ModeConfig = {
  id: ModeId;
  label: string;
  description: string;
  instructions: string;
  temperature: number;
  reasoning: boolean;
  research: "off" | "auto" | "always" | "deep";
  maxSteps: number;
};

export const MODES: Record<ModeId, ModeConfig> = {
  quick: {
    id: "quick",
    label: "Quick",
    description: "Fast answers for everyday questions",
    instructions: "Answer directly and concisely. Lead with the answer; add detail only if it helps.",
    temperature: 0.5,
    reasoning: false,
    research: "auto",
    maxSteps: 4,
  },
  think: {
    id: "think",
    label: "Think",
    description: "More reasoning for complex problems",
    instructions:
      "This is a complex task. Internally: decompose it, identify missing information, use tools (calculator, search, files) where they improve accuracy, and verify key results before answering. Then give a clear, well-structured final answer. Do not reveal your private step-by-step reasoning; instead, where useful, include a brief 'How I approached this' summary of the methods used.",
    temperature: 0.3,
    reasoning: true,
    research: "auto",
    maxSteps: 8,
  },
  research: {
    id: "research",
    label: "Research",
    description: "Searches the web and cites sources",
    instructions:
      "Answer using the web sources provided. Cite every factual claim with bracketed source numbers like [1] or [2][3]. Prefer the freshest, most authoritative sources; when sources disagree, say so and explain which is more reliable. If sources don't cover something, say that plainly instead of guessing.",
    temperature: 0.2,
    reasoning: false,
    research: "always",
    maxSteps: 6,
  },
  code: {
    id: "code",
    label: "Code",
    description: "Optimized for programming",
    instructions:
      "You are an expert software engineer. Write correct, idiomatic, production-quality code with fenced code blocks and language tags. Explain briefly, point out edge cases and security issues, and prefer complete runnable snippets over fragments.",
    temperature: 0.2,
    reasoning: false,
    research: "off",
    maxSteps: 6,
  },
  creative: {
    id: "creative",
    label: "Creative",
    description: "Writing, brainstorming and ideas",
    instructions: "Be imaginative, vivid and original. Offer varied options when brainstorming. Match the requested tone and form.",
    temperature: 0.9,
    reasoning: false,
    research: "off",
    maxSteps: 2,
  },
  analyze: {
    id: "analyze",
    label: "Analyze",
    description: "Analyze uploaded files, data and images",
    instructions:
      "Analyze the provided files, data or images carefully. Quote or reference specific sections (document name + part). Use the calculator for any arithmetic. Distinguish clearly between what the material says and your interpretation.",
    temperature: 0.2,
    reasoning: true,
    research: "off",
    maxSteps: 6,
  },
};

export const MODE_LIST = Object.values(MODES);

export function getMode(id: string | null | undefined): ModeConfig {
  return MODES[(id as ModeId) ?? "quick"] ?? MODES.quick;
}
