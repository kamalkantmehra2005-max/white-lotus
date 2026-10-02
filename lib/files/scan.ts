import "server-only";
import { createHash } from "node:crypto";
import { connect } from "node:net";
import { env } from "@/config/env";
import { logger } from "@/lib/observability/logger";

/**
 * Malware scanning for uploads (runs while the file sits in quarantine).
 *
 *   MALWARE_SCANNER=none    → nothing scans. Files are marked "unscanned" and the UI says so. (Honest default.)
 *   MALWARE_SCANNER=clamav  → streams the file to clamd (CLAMAV_HOST:CLAMAV_PORT) using the INSTREAM protocol.
 *   MALWARE_SCANNER=http    → POSTs the bytes to MALWARE_SCAN_URL (Bearer MALWARE_SCAN_TOKEN) and expects
 *                             JSON { "clean": boolean, "signature"?: string }. Use this on serverless hosts
 *                             e.g. the scanner/ adapter in front of a local ClamAV. Prefer MALWARE_SCANNER=clamav with clamd on this computer.
 *
 *   MALWARE_SCAN_REQUIRED=true → fail closed: uploads are rejected when the result is "unscanned" or "error".
 */
export type ScanStatus = "clean" | "infected" | "unscanned" | "error";
export type ScanResult = { status: ScanStatus; engine: string; signature?: string; sha256: string };

export function scannerConfigured() {
  return env.MALWARE_SCANNER !== "none";
}

export async function scanBuffer(buf: Buffer): Promise<ScanResult> {
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const engine = env.MALWARE_SCANNER;
  if (engine === "none") return { status: "unscanned", engine: "none", sha256 };
  try {
    if (engine === "clamav") {
      const reply = await clamdInstream(buf, env.CLAMAV_HOST, env.CLAMAV_PORT);
      if (/:\s*OK\s*$/.test(reply) || reply === "OK") return { status: "clean", engine, sha256 };
      const sig = reply.match(/:\s*(.+?)\s+FOUND/)?.[1];
      if (sig) return { status: "infected", engine, signature: sig, sha256 };
      throw new Error(`unexpected clamd reply: ${reply.slice(0, 80)}`);
    }
    // http
    if (!env.MALWARE_SCAN_URL) throw new Error("MALWARE_SCAN_URL is not set");
    const res = await fetch(env.MALWARE_SCAN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", ...(env.MALWARE_SCAN_TOKEN ? { Authorization: `Bearer ${env.MALWARE_SCAN_TOKEN}` } : {}), "X-Content-SHA256": sha256 },
      body: new Uint8Array(buf),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`scanner HTTP ${res.status}`);
    const j = (await res.json()) as { clean?: unknown; signature?: unknown };
    if (j.clean === true) return { status: "clean", engine, sha256 };
    if (j.clean === false) return { status: "infected", engine, signature: typeof j.signature === "string" ? j.signature.slice(0, 120) : "unknown", sha256 };
    throw new Error("scanner response missing 'clean'");
  } catch (e) {
    logger.error("scan.failed", { engine, error: e });
    return { status: "error", engine, sha256 };
  }
}

/** Is a file with this scan status allowed to be released from quarantine under the current policy? */
export function releasable(status: ScanStatus): boolean {
  if (status === "clean") return true;
  if (status === "unscanned") return !env.MALWARE_SCAN_REQUIRED;
  return false; // infected, or scanner error (fail closed)
}

export function clamdInstream(buf: Buffer, host: string, port: number, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host, port });
    const chunks: Buffer[] = [];
    sock.setTimeout(timeoutMs, () => sock.destroy(new Error("clamd timeout")));
    sock.on("error", reject);
    sock.on("data", (d) => chunks.push(d));
    sock.on("end", () => resolve(Buffer.concat(chunks).toString("utf8").replace(/\0/g, "").trim()));
    sock.on("connect", () => {
      sock.write("zINSTREAM\0");
      const CHUNK = 64 * 1024;
      for (let i = 0; i < buf.length; i += CHUNK) {
        const part = buf.subarray(i, i + CHUNK);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(part.length);
        sock.write(len);
        sock.write(part);
      }
      sock.write(Buffer.alloc(4)); // zero-length chunk = end of stream
    });
  });
}
