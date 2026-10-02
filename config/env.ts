import "server-only";
import { z } from "zod";
import { publicUrl } from "@/lib/public-url";
import { ensureCloudKeys } from "@/lib/security/cloud-keys";

/**
 * Server-side environment. Parsed once, validated with zod.
 * NEVER import this file from a client component — `server-only` enforces that at build time.
 */
const bool = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");
const int = (d: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== "" ? Number.parseInt(v, 10) : d))
    .pipe(z.number().int().nonnegative());

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // The local address the launcher serves on (always this computer only).
  APP_URL: z.preprocess((v) => (typeof v === "string" && v.trim() !== "" ? v.trim().replace(/\/+$/, "") : publicUrl() || undefined), z.string().url().default("http://127.0.0.1:3000")),
  // Local-first: data folder (set by the launcher; see lib/local/paths.ts). No external database is used.
  WHITE_LOTUS_DATA_DIR: z.string().optional(),
  // Offline mode: only local AI (Ollama / localhost servers); web search, URL reading and weather are disabled,
  // so nothing leaves this computer.
  LOCAL_OFFLINE_MODE: bool,
  // Personal install: only the first account can be created (you). Set false to allow more local accounts.
  LOCAL_SINGLE_USER: z.string().optional().transform((v) => v !== "false"),

  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters"),
  AUTH_GOOGLE_ID: z.string().optional(),
  AUTH_GOOGLE_SECRET: z.string().optional(),
  AUTH_ALLOW_SIGNUP: z.string().optional().transform((v) => v !== "false"),
  // Emails granted admin — ONLY once the address is verified (Google login or the email-verification link).
  ADMIN_EMAILS: z.string().optional().default(""),
  // The very first registered account becomes admin (bootstrap). Set false once you have an admin.
  AUTH_FIRST_USER_ADMIN: z.string().optional().transform((v) => v !== "false"),
  // Require email verification before password users can sign in (needs a mail provider).
  AUTH_REQUIRE_EMAIL_VERIFICATION: bool,
  // Guest mode: visitors can chat without an account (temporary, limited; no files/projects/memory).
  ALLOW_GUEST_CHAT: bool,
  GUEST_RETENTION_HOURS: int(24),
  GUEST_DAILY_MESSAGES: int(20),
  GUEST_DAILY_SEARCHES: int(5),
  GUEST_SESSIONS_PER_IP_PER_HOUR: int(10),
  GUEST_DAILY_MESSAGES_PER_IP: int(200),

  // Transactional email (password reset, verification) over HTTPS APIs
  MAIL_FROM: z.string().default("WHITE-LOTUS <no-reply@localhost>"),
  RESEND_API_KEY: z.string().optional(),
  POSTMARK_SERVER_TOKEN: z.string().optional(),

  // AI — model ids are "<provider>:<model>", e.g. "openai:gpt-4o-mini", "ollama:llama3.1"
  DEFAULT_MODEL: z.string().default("openai:gpt-4o-mini"),
  FAST_MODEL: z.string().optional(), // used for titles & query generation; falls back to DEFAULT_MODEL
  FALLBACK_MODEL: z.string().optional(), // tried automatically if the selected model's provider fails before streaming
  ENABLED_MODELS: z.string().optional().default(""),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_AI_API_KEY: z.string().optional(),
  OLLAMA_BASE_URL: z.string().url().optional(),
  CUSTOM_OPENAI_BASE_URL: z.string().url().optional(), // vLLM / LM Studio / OpenRouter / any OpenAI-compatible API
  CUSTOM_OPENAI_API_KEY: z.string().optional(),
  CUSTOM_OPENAI_NAME: z.string().default("custom"),
  AI_REQUEST_TIMEOUT_MS: int(120_000),

  // Search: tavily | brave | searxng (comma-separated = fallback order)
  SEARCH_PROVIDERS: z.string().default("tavily,brave,searxng"),
  TAVILY_API_KEY: z.string().optional(),
  BRAVE_SEARCH_API_KEY: z.string().optional(),
  SEARXNG_URL: z.string().url().optional(),

  // Files are always stored locally, encrypted, in <data folder>/files (no cloud storage).

  // Usage limits (0 = unlimited)
  FREE_DAILY_MESSAGES: int(100),
  FREE_DAILY_SEARCHES: int(30),
  FREE_FILE_LIMIT: int(50),
  FREE_DAILY_UPLOADS: int(20),
  MAX_UPLOAD_SIZE_MB: int(20),
  MAX_CONTEXT_TOKENS: int(24_000),
  MAX_OUTPUT_TOKENS: int(4_096),
  RATE_LIMIT_PER_MINUTE: int(20),
  RATE_LIMIT_SIGNUPS_PER_HOUR: int(5), // per IP
  // Sessions: absolute lifetime and inactivity timeout (0 = no idle timeout)
  SESSION_MAX_AGE_HOURS: int(168),
  SESSION_IDLE_TIMEOUT_MINUTES: int(720),
  RATE_LIMIT_LOGIN_ATTEMPTS: int(10), // per account per 15 minutes (per IP: 4×)

  // Upload scanning & downloads
  // none | clamav (clamd over TCP) | http (external scanning service, e.g. a ClamAV REST container or vendor API)
  MALWARE_SCANNER: z.enum(["none", "clamav", "http"]).default("none"),
  // Fail closed: reject uploads when no scanner is configured or it is unreachable. Strongly recommended for confidential work.
  MALWARE_SCAN_REQUIRED: bool,
  CLAMAV_HOST: z.string().default("127.0.0.1"),
  CLAMAV_PORT: int(3310),
  MALWARE_SCAN_URL: z.string().url().optional(),
  MALWARE_SCAN_TOKEN: z.string().optional(),
  // Signed download link lifetime (seconds)
  DOWNLOAD_LINK_TTL_SECONDS: int(60),
  // Delete files older than N days via the retention job (0 = keep until the user deletes them)
  FILE_RETENTION_DAYS: int(0),
  // Shared secret for the retention endpoint (the app also runs retention itself every few hours)
  CRON_SECRET: z.string().optional(),

  // Encryption at rest for confidential fields: "k1:<base64 32 bytes>[,k0:<old key>]" (see lib/security/encryption.ts)
  ENCRYPTION_KEYS: z.string().optional(),
  // Key for the searchable blind index over encrypted text. Stable — changing it requires a reindex.
  BLIND_INDEX_KEY: z.string().optional(),

  // Tools
  ENABLE_CODE_EXECUTION: bool, // off by default; see lib/tools/code-execution.ts
  URL_FETCH_ALLOW_PRIVATE: bool, // only for local dev against intranet hosts — never in production

  // ---- Online edition (see docs/ONLINE.md) ----
  WHITE_LOTUS_EDITION: z.enum(["local", "cloud"]).optional(),
  DATABASE_URL: z.string().optional(),
  // One-time code that makes the account registering with it the owner (admin). Remove it afterwards.
  OWNER_SETUP_CODE: z.string().optional(),
  WEB_GUEST_DAILY_MESSAGES: int(30), // per network (IP) per day, for "Use without account"
  WEB_GUEST_DAILY_SEARCHES: int(5),
  WEB_GUEST_PER_MINUTE: int(6),
  WEB_VAULT_MAX_MB: int(50), // encrypted sync storage per account

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  ensureCloudKeys();
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid WHITE-LOTUS environment configuration:\n${issues}\nSee .env.example.`);
  }
  if (parsed.data.NODE_ENV === "production" && process.env.NEXT_PHASE !== "phase-production-build") {
    if (parsed.data.URL_FETCH_ALLOW_PRIVATE) throw new Error("URL_FETCH_ALLOW_PRIVATE must not be enabled in production (SSRF risk).");
    if (!parsed.data.ENCRYPTION_KEYS) throw new Error("ENCRYPTION_KEYS is required in production (see .env.example).");
    if (!parsed.data.BLIND_INDEX_KEY) throw new Error("BLIND_INDEX_KEY is required in production (see .env.example).");
    if (!parsed.data.APP_URL.startsWith("https://") && !/localhost|127\.0\.0\.1/.test(parsed.data.APP_URL)) {
      throw new Error("APP_URL must be https:// in production.");
    }
  }
  return parsed.data;
}

let cached: Env | undefined;
export const env = new Proxy({} as Env, {
  get(_t, key: string) {
    cached ??= load();
    return cached[key as keyof Env];
  },
});
