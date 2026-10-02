import "server-only";
import { env } from "@/config/env";
import { logger } from "@/lib/observability/logger";
import { AnthropicProvider } from "./providers/anthropic";
import { GoogleProvider } from "./providers/google";
import { OpenAICompatibleProvider } from "./providers/openai-compatible";
import type { AIProvider, ModelCapabilities, ModelInfo } from "./types";

/**
 * Provider + model registry. Models are configured, not hard-coded:
 *   ENABLED_MODELS="openai:gpt-4o-mini,anthropic:claude-sonnet-4-5,ollama:llama3.1"
 *   DEFAULT_MODEL="openai:gpt-4o-mini"
 * Add a provider = implement AIProvider and register it in buildProviders().
 */
let providers: Map<string, AIProvider> | undefined;

/** Admin overrides from the model_settings table (loaded by loadModelOverrides, cached 30s). */
export type ModelOverride = { enabled: boolean; displayName: string; isDefault: boolean };
let overrides = new Map<string, ModelOverride>();
let overridesAt = 0;
export async function loadModelOverrides(force = false) {
  if (!force && Date.now() - overridesAt < 30_000) return overrides;
  try {
    const { db } = await import("@/lib/database/client");
    const { modelSettings } = await import("@/lib/database/schema");
    const rows = await db.select().from(modelSettings);
    overrides = new Map(rows.map((r) => [r.modelId, { enabled: r.enabled, displayName: r.displayName, isDefault: r.isDefault }]));
  } catch {
    /* keep previous overrides if the DB is momentarily unavailable */
  }
  overridesAt = Date.now();
  return overrides;
}

function buildProviders(): Map<string, AIProvider> {
  const t = env.AI_REQUEST_TIMEOUT_MS;
  const m = new Map<string, AIProvider>();
  m.set(
    "openai",
    new OpenAICompatibleProvider("openai", "OpenAI", env.OPENAI_BASE_URL, env.OPENAI_API_KEY, {
      requireKey: true,
      timeoutMs: t,
      reasoningModels: /^(o\d|gpt-5)/,
    }),
  );
  m.set("anthropic", new AnthropicProvider(env.ANTHROPIC_API_KEY, t));
  m.set("google", new GoogleProvider(env.GOOGLE_AI_API_KEY, t));
  if (env.OLLAMA_BASE_URL) {
    const base = env.OLLAMA_BASE_URL.replace(/\/$/, "").replace(/\/v1$/, "") + "/v1";
    m.set("ollama", new OpenAICompatibleProvider("ollama", "Ollama (local)", base, undefined, { requireKey: false, timeoutMs: Math.max(t, 300_000) }));
  }
  if (env.CUSTOM_OPENAI_BASE_URL) {
    m.set(
      env.CUSTOM_OPENAI_NAME,
      new OpenAICompatibleProvider(env.CUSTOM_OPENAI_NAME, `${env.CUSTOM_OPENAI_NAME} (OpenAI-compatible)`, env.CUSTOM_OPENAI_BASE_URL, env.CUSTOM_OPENAI_API_KEY, {
        requireKey: false,
        timeoutMs: Math.max(t, 300_000),
      }),
    );
  }
  return m;
}

export function getProviders() {
  providers ??= buildProviders();
  return providers;
}

/** Where a provider's requests go — shown to the user (what leaves the computer) and used by offline mode. */
export function providerEndpoint(providerId: string): string | null {
  if (providerId === "openai") return env.OPENAI_BASE_URL;
  if (providerId === "anthropic") return "https://api.anthropic.com";
  if (providerId === "google") return "https://generativelanguage.googleapis.com";
  if (providerId === "ollama") return env.OLLAMA_BASE_URL ?? null;
  if (providerId === env.CUSTOM_OPENAI_NAME) return env.CUSTOM_OPENAI_BASE_URL ?? null;
  return null;
}

/** True when the endpoint is this computer or the local network (e.g. Ollama at http://127.0.0.1:11434). */
export function isLocalEndpoint(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h === "::1" || h === "host.docker.internal") return true;
    if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
    return false;
  } catch {
    return false;
  }
}

export function isLocalProvider(providerId: string) {
  return isLocalEndpoint(providerEndpoint(providerId));
}

export function parseModelId(id: string): { provider: string; model: string } {
  const i = id.indexOf(":");
  if (i <= 0) return { provider: "openai", model: id };
  return { provider: id.slice(0, i), model: id.slice(i + 1) };
}

/** Capability heuristics. Override per model in ENABLED_MODELS with suffix flags, e.g. "ollama:llava|vision". */
export function inferCapabilities(provider: string, model: string): ModelCapabilities {
  const m = model.toLowerCase();
  const localVision = /llava|vision|vl\b|-vl|gemma3|minicpm-v|moondream|pixtral/.test(m);
  const reasoning = /(^o\d|gpt-5|reason|think|r1|qwq|claude-(opus|sonnet)-4|claude-3-7|gemini-2\.5|gemini-3)/.test(m);
  if (provider === "openai") return { vision: !/^o1-mini|^o3-mini|gpt-3\.5/.test(m), tools: true, reasoning };
  if (provider === "anthropic") return { vision: true, tools: true, reasoning };
  if (provider === "google") return { vision: true, tools: true, reasoning: false };
  return { vision: localVision, tools: !/gemma(?!3)|phi-?2|tinyllama/.test(m), reasoning };
}

function labelFor(model: string) {
  return model.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function parseEntry(entry: string): ModelInfo | null {
  const [idPart, ...flags] = entry.trim().split("|");
  if (!idPart) return null;
  const { provider, model } = parseModelId(idPart);
  // Reject malformed ids (e.g. a stray "\" typed during setup) instead of offering a model that can never answer.
  if (!provider || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(model)) {
    logger.warn("ai.invalid_model_id", { id: idPart.slice(0, 80) });
    return null;
  }
  const caps = inferCapabilities(provider, model);
  for (const f of flags) {
    if (f === "vision") caps.vision = true;
    if (f === "novision") caps.vision = false;
    if (f === "tools") caps.tools = true;
    if (f === "notools") caps.tools = false;
    if (f === "reasoning") caps.reasoning = true;
  }
  return { id: `${provider}:${model}`, provider, model, label: labelFor(model), capabilities: caps, contextWindow: 128_000 };
}

/** Models whose provider is configured, with admin overrides applied (disabled ones hidden unless includeDisabled). */
export function listModels(opts: { includeDisabled?: boolean } = {}): ModelInfo[] {
  const p = getProviders();
  const raw = env.ENABLED_MODELS.split(",").map((s) => s.trim()).filter(Boolean);
  const entries = raw.length ? raw : [env.DEFAULT_MODEL, env.FAST_MODEL, env.FALLBACK_MODEL].filter((x): x is string => Boolean(x));
  const seen = new Set<string>();
  const out: ModelInfo[] = [];
  for (const e of entries) {
    const info = parseEntry(e);
    if (!info || seen.has(info.id)) continue;
    if (!p.get(info.provider)?.isConfigured()) continue;
    // Offline mode: only AI that runs on this computer / local network.
    if (env.LOCAL_OFFLINE_MODE && !isLocalProvider(info.provider)) continue;
    seen.add(info.id);
    const o = overrides.get(info.id);
    if (o && !o.enabled && !opts.includeDisabled) continue;
    if (o?.displayName) info.label = o.displayName;
    out.push(info);
  }
  return out;
}

export function defaultModelId(): string | null {
  const models = listModels();
  const adminDefault = [...overrides.entries()].find(([id, o]) => o.isDefault && o.enabled && models.some((m) => m.id === id))?.[0];
  return adminDefault ?? models.find((m) => m.id === env.DEFAULT_MODEL)?.id ?? models[0]?.id ?? null;
}

export function resolveModel(requested?: string | null): { info: ModelInfo; provider: AIProvider } | null {
  const models = listModels();
  const pick = (id?: string | null) => (id ? models.find((m) => m.id === id) : undefined);
  const info = pick(requested) ?? pick(defaultModelId()) ?? models[0];
  if (!info) return null;
  return { info, provider: getProviders().get(info.provider)! };
}

export function resolveFastModel() {
  return resolveModel(env.FAST_MODEL ?? env.DEFAULT_MODEL);
}

export function resolveFallback(excludeId: string) {
  if (!env.FALLBACK_MODEL || env.FALLBACK_MODEL === excludeId) return null;
  const r = resolveModel(env.FALLBACK_MODEL);
  return r && r.info.id !== excludeId ? r : null;
}
