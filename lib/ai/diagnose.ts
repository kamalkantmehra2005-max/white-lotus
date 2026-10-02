import "server-only";
import { AppError } from "@/lib/errors";
import { isLocalProvider, providerEndpoint } from "./registry";
import { ProviderError, type ModelInfo } from "./types";

/**
 * Turn a failed AI call into a message that says what's wrong and how to fix it, instead of
 * "couldn't complete that request". Never includes keys or message content.
 */
export function explainProviderFailure(info: ModelInfo, e: unknown): AppError {
  const endpoint = providerEndpoint(info.provider);
  let host = info.provider;
  try {
    if (endpoint) host = new URL(endpoint).host;
  } catch {
    /* keep provider name */
  }
  const local = isLocalProvider(info.provider);
  const isOllama = info.provider === "ollama";
  const fix = "To change the model: close WHITE-LOTUS, run “npm run local -- setup” (or edit DEFAULT_MODEL in settings.env), then start it again.";
  const err = e as { message?: string; cause?: { code?: string; message?: string } };
  const text = `${err?.message ?? ""} ${err?.cause?.code ?? ""} ${err?.cause?.message ?? ""}`;

  if (e instanceof ProviderError) {
    if (e.status === 404 || /not found|does not exist|no such model|unknown model|model_not_found/i.test(e.message)) {
      return new AppError(
        "ai_model_not_found",
        isOllama
          ? `The model “${info.model}” isn't installed in Ollama. In a terminal run “ollama list” to see installed models, or “ollama pull llama3.1” to get one. ${fix}`
          : `${host} doesn't have a model called “${info.model}”. Check the model name in the provider's list. ${fix}`,
        502,
      );
    }
    if (e.status === 401 || e.status === 403) return new AppError("ai_auth", `${host} rejected the API key. Check the key in settings.env (npm run local -- setup).`, 502);
    if (e.status === 429) return new AppError("ai_rate_limited", `${host} is rate-limiting requests (free-tier limit reached?). Wait a minute and try again.`, 429, true);
    if (e.status === 400 && /context|token|too long|maximum/i.test(e.message)) return new AppError("ai_too_long", `The conversation or file is too long for “${info.model}”. Start a new chat or lower MAX_CONTEXT_TOKENS.`, 502);
    return new AppError("provider_error", `${host} returned an error (${e.status}) for “${info.model}”. Try again, or choose another model. ${fix}`, 502, true);
  }
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|EAI_AGAIN|ECONNRESET|UND_ERR_CONNECT|socket|timed? ?out|AbortError/i.test(text)) {
    return new AppError(
      "ai_unreachable",
      local
        ? isOllama
          ? `WHITE-LOTUS couldn't reach Ollama at ${host}. Is Ollama running? Open the Ollama app (or run “ollama serve”), then press Retry.`
          : `WHITE-LOTUS couldn't reach your local AI server at ${host}. Make sure it's running, then press Retry.`
        : `WHITE-LOTUS couldn't reach ${host}. Check your internet connection (or firewall/proxy), then press Retry.`,
      503,
      true,
    );
  }
  return new AppError("provider_error", `“${info.label}” couldn't answer. Try again, or choose another model. ${fix}`, 502, true);
}
