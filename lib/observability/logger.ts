/**
 * Structured JSON logger. Redacts secrets and truncates user content so logs never carry
 * API keys, passwords, tokens, or full conversations.
 */
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY = /pass(word)?|secret|token|api[-_]?key|authorization|cookie|session/i;
const SECRET_VALUE = /(sk-[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._-]+|AIza[0-9A-Za-z_-]{20,})/g;
const CONTENT_KEY = /^(content|prompt|message|text|body)$/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[depth]";
  if (typeof value === "string") return value.replace(SECRET_VALUE, "[REDACTED]");
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: redact(value.message) };
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k)) out[k] = "[REDACTED]";
      else if (CONTENT_KEY.test(k) && typeof v === "string") out[k] = `[${v.length} chars]`;
      else out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function minLevel(): Level {
  const l = (process.env.LOG_LEVEL ?? "info") as Level;
  return l in ORDER ? l : "info";
}

function write(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (ORDER[level] < ORDER[minLevel()]) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(redact(fields ?? {}) as object) });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export const logger = {
  debug: (m: string, f?: Record<string, unknown>) => write("debug", m, f),
  info: (m: string, f?: Record<string, unknown>) => write("info", m, f),
  warn: (m: string, f?: Record<string, unknown>) => write("warn", m, f),
  error: (m: string, f?: Record<string, unknown>) => write("error", m, f),
};

/** Measure latency of an async operation and log it. */
export async function timed<T>(name: string, fn: () => Promise<T>, fields?: Record<string, unknown>): Promise<T> {
  const start = performance.now();
  try {
    const r = await fn();
    logger.debug(`${name}.ok`, { ...fields, ms: Math.round(performance.now() - start) });
    return r;
  } catch (e) {
    logger.warn(`${name}.fail`, { ...fields, ms: Math.round(performance.now() - start), error: e });
    throw e;
  }
}

/**
 * Persist an error summary (code + short sanitized message, no user content) for the admin console.
 * Fire-and-forget; never throws. Imported lazily to keep this module usable in edge/client-safe contexts.
 */
export function persistError(scope: string, code: string, error: unknown, extra: { userId?: string; requestId?: string } = {}) {
  const msg = String(redact(error instanceof Error ? error.message : error) ?? "").replace(/\s+/g, " ").slice(0, 300);
  void import("@/lib/database/client")
    .then(async ({ db, schema }) => {
      await db.insert(schema.errorLogs).values({ scope: scope.slice(0, 64), code: code.slice(0, 64), message: msg, userId: extra.userId ?? null, requestId: extra.requestId ?? null });
    })
    .catch(() => {});
}
