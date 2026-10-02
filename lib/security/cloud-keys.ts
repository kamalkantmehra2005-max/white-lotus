import "server-only";
import { hkdfSync } from "node:crypto";
import { isCloud } from "@/lib/edition";

/**
 * Online edition convenience: only AUTH_SECRET has to be configured. If ENCRYPTION_KEYS / BLIND_INDEX_KEY /
 * CRON_SECRET are not set, they are derived from it with HKDF (separate labels, so each is independent).
 * Changing AUTH_SECRET therefore also changes these keys — keep it stable.
 */
export function ensureCloudKeys() {
  if (!isCloud()) return;
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) return;
  const derive = (label: string) => Buffer.from(hkdfSync("sha256", Buffer.from(secret), Buffer.alloc(0), `white-lotus:cloud:${label}`, 32)).toString("base64");
  process.env.ENCRYPTION_KEYS ||= `k1:${derive("encryption")}`;
  process.env.BLIND_INDEX_KEY ||= derive("blind-index");
  process.env.CRON_SECRET ||= derive("cron");
}
