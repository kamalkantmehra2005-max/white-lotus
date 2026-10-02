import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { logger, persistError } from "@/lib/observability/logger";

/** Errors that are safe to show to users. Anything else becomes a generic message. */
export class AppError extends Error {
  constructor(
    public code: string,
    public userMessage: string,
    public status = 400,
    public retryable = false,
  ) {
    super(userMessage);
  }
}

export const Errors = {
  unauthorized: () => new AppError("unauthorized", "Please sign in to continue.", 401),
  sessionEnded: () => new AppError("session_expired", "Your session has ended. Please sign in again.", 401),
  guestEnded: () => new AppError("guest_ended", "Your guest session has ended. Guest chats are deleted automatically. Start a new chat or sign in.", 401),
  accountRequired: (feature = "This feature") =>
    new AppError("account_required", `${feature} needs a free account. Sign in or create one — guest chats can be kept.`, 403),
  forbidden: () => new AppError("forbidden", "You don't have access to that.", 403),
  notFound: (what = "That item") => new AppError("not_found", `${what} couldn't be found.`, 404),
  blocked: () => new AppError("blocked", "This account has been suspended. Contact the administrator.", 403),
  rateLimited: (retryAfterSec: number) =>
    new AppError("rate_limited", `You're sending requests too quickly. Try again in ${retryAfterSec}s.`, 429, true),
  quota: (what: string) =>
    new AppError("quota_exceeded", `You've reached today's free ${what} limit. It resets at midnight UTC.`, 429),
  invalid: (msg = "The request was invalid.") => new AppError("invalid_request", msg, 400),
  provider: () =>
    new AppError("provider_error", "WHITE-LOTUS couldn't complete that request. Please try again.", 502, true),
  notConfigured: (what: string) =>
    new AppError("not_configured", `${what} isn't configured on this server yet.`, 503),
};

export const GENERIC_ERROR = "WHITE-LOTUS couldn't complete that request. Please try again.";

export function toPublicError(e: unknown): { code: string; message: string; status: number; retryable: boolean } {
  if (e instanceof AppError) return { code: e.code, message: e.userMessage, status: e.status, retryable: e.retryable };
  if (e instanceof ZodError)
    return {
      code: "invalid_request",
      message: e.issues[0]?.message ? `Invalid input: ${e.issues[0].message}` : "Invalid input.",
      status: 400,
      retryable: false,
    };
  return { code: "internal_error", message: GENERIC_ERROR, status: 500, retryable: true };
}

/** Wrap a route handler: consistent JSON errors, technical details only in server logs. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (e) {
      const pub = toPublicError(e);
      // Only unexpected failures are errors; deliberate AppErrors (e.g. "not configured") are normal responses.
      if (pub.status >= 500 && !(e instanceof AppError)) {
        const req = args[0] instanceof Request ? args[0] : undefined;
        const requestId = req?.headers.get("x-request-id") ?? undefined;
        logger.error("route.error", { error: e, code: pub.code, requestId, path: req ? new URL(req.url).pathname : undefined });
        persistError(req ? new URL(req.url).pathname : "route", pub.code, e, { requestId });
      }
      const headers: Record<string, string> = {};
      if (pub.code === "rate_limited") headers["Retry-After"] = "60";
      return NextResponse.json({ error: pub }, { status: pub.status, headers });
    }
  };
}
