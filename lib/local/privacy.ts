import "server-only";
import { env } from "@/config/env";
import { googleCredentials } from "@/lib/auth";
import { getProviders, isLocalEndpoint, isLocalProvider, listModels, providerEndpoint } from "@/lib/ai/registry";
import { configuredSearchProviders, isSearchAvailable } from "@/lib/search/providers";

/**
 * An honest, computed list of everything that can leave this computer, based on the CURRENT configuration.
 * Shown in Settings → Privacy & storage and next to the chat box. Persistent data never leaves: it is only
 * ever written to the local data folder.
 */
export type DataFlow = {
  id: string;
  service: string;
  destination: string;
  local: boolean;
  when: string;
  sends: string[];
  neverSends: string[];
};

const host = (u: string | null | undefined) => {
  try {
    return u ? new URL(u).host : "unknown";
  } catch {
    return "unknown";
  }
};

const SEARCH_HOSTS: Record<string, string> = { tavily: "api.tavily.com", brave: "api.search.brave.com" };

export function dataFlows(): DataFlow[] {
  const flows: DataFlow[] = [];
  const models = listModels();
  const providerIds = [...new Set(models.map((m) => m.provider))];
  for (const id of providerIds) {
    const p = getProviders().get(id);
    const endpoint = providerEndpoint(id);
    const local = isLocalProvider(id);
    flows.push({
      id: `ai:${id}`,
      service: p?.label ?? id,
      destination: local ? `${host(endpoint)} (this computer / local network)` : host(endpoint),
      local,
      when: "Each time you send a message using this model",
      sends: [
        "Your new message",
        "Recent messages from the same conversation (as much as fits the context limit)",
        "Relevant excerpts of files attached to or searched in that conversation",
        "Memories and project instructions that apply to the conversation (if memory is on)",
        "Web search results used for the answer",
      ],
      neverSends: ["Your other conversations", "Your whole files (only excerpts)", "Your password, keys or data folder"],
    });
  }
  if (isSearchAvailable()) {
    for (const s of configuredSearchProviders()) {
      const dest = s.id === "searxng" ? host(env.SEARXNG_URL) : (SEARCH_HOSTS[s.id] ?? s.id);
      flows.push({
        id: `search:${s.id}`,
        service: `Web search (${s.id})`,
        destination: dest,
        local: s.id === "searxng" && isLocalEndpoint(env.SEARXNG_URL),
        when: "Only when web search / research is on for a message",
        sends: ["Short search queries written from your question"],
        neverSends: ["Your conversation", "Your files"],
      });
    }
  }
  if (!env.LOCAL_OFFLINE_MODE) {
    flows.push({
      id: "web:read_url",
      service: "Reading web pages",
      destination: "The websites being read",
      local: false,
      when: "When an answer opens a search result or a link you gave",
      sends: ["A normal page request to that website (no cookies, no personal data)"],
      neverSends: ["Your conversation", "Your files"],
    });
    flows.push({
      id: "web:weather",
      service: "Weather tool (Open-Meteo)",
      destination: "api.open-meteo.com",
      local: false,
      when: "Only when you ask about the weather",
      sends: ["The place name"],
      neverSends: ["Anything else"],
    });
  }
  if (env.MALWARE_SCANNER === "http" && env.MALWARE_SCAN_URL) {
    flows.push({
      id: "scan:http",
      service: "Malware scanning service",
      destination: host(env.MALWARE_SCAN_URL),
      local: isLocalEndpoint(env.MALWARE_SCAN_URL),
      when: "When you upload a file",
      sends: ["The uploaded file, for scanning"],
      neverSends: ["Your conversations"],
    });
  }
  if (env.RESEND_API_KEY || env.POSTMARK_SERVER_TOKEN) {
    flows.push({
      id: "mail",
      service: "Email delivery",
      destination: env.RESEND_API_KEY ? "api.resend.com" : "api.postmarkapp.com",
      local: false,
      when: "Password-reset / verification emails",
      sends: ["Your email address and the reset link"],
      neverSends: ["Your conversations", "Your files"],
    });
  }
  if (googleCredentials()) {
    flows.push({
      id: "auth:google",
      service: "Google sign-in",
      destination: "accounts.google.com",
      local: false,
      when: "Only if you choose 'Continue with Google'",
      sends: ["A sign-in request; Google returns your name and email"],
      neverSends: ["Your conversations", "Your files"],
    });
  }
  return flows;
}

export function privacySummary() {
  const flows = dataFlows();
  return {
    offlineMode: env.LOCAL_OFFLINE_MODE,
    everythingLocal: flows.every((f) => f.local),
    flows,
  };
}
