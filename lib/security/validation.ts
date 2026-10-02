import { z } from "zod";

/**
 * Shared input validation. Every API route parses its input with zod; these are the common building blocks.
 * IDs from the browser are only ever *identifiers to look up* — ownership is always re-checked server-side.
 */
export const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "Invalid id");

export const timezoneSchema = z
  .string()
  .max(64)
  .regex(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/, "Invalid time zone");

export const emailSchema = z.string().trim().toLowerCase().email("Enter a valid email").max(254);

/** Parse a route param id; throws a 400-mapped ZodError on garbage (never reaches the database). */
export function parseId(value: unknown): string {
  return idSchema.parse(value);
}

/** Only same-origin relative paths are allowed as post-login redirects (prevents open redirects). */
export function safeRedirectPath(p: string | null | undefined, fallback = "/chat"): string {
  if (!p || !p.startsWith("/") || p.startsWith("//") || p.startsWith("/\\")) return fallback;
  return p;
}
