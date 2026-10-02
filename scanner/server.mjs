#!/usr/bin/env node
/**
 * WHITE-LOTUS malware-scan adapter: a tiny HTTP front for ClamAV's clamd, matching MALWARE_SCANNER=http.
 *   POST /scan   Authorization: Bearer $SCAN_TOKEN   body: raw file bytes
 *   → 200 {"clean": true} | {"clean": false, "signature": "..."}   (5xx on scanner failure → WHITE-LOTUS fails closed)
 *   GET  /health → 200 when clamd answers PING
 * Env: SCAN_TOKEN (required), PORT (8080), CLAMD_HOST (127.0.0.1), CLAMD_PORT (3310), MAX_BYTES (52428800)
 * Deploy the container in scanner/Dockerfile to Cloud Run / Fly.io / Render / any VM, over HTTPS only.
 */
import http from "node:http";
import net from "node:net";
import { timingSafeEqual } from "node:crypto";

const TOKEN = process.env.SCAN_TOKEN ?? "";
const PORT = Number(process.env.PORT ?? 8080);
const CLAMD_HOST = process.env.CLAMD_HOST ?? "127.0.0.1";
const CLAMD_PORT = Number(process.env.CLAMD_PORT ?? 3310);
const MAX_BYTES = Number(process.env.MAX_BYTES ?? 50 * 1024 * 1024);
if (TOKEN.length < 24) {
  console.error("SCAN_TOKEN must be set (at least 24 characters)");
  process.exit(1);
}

function clamd(command, body) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: CLAMD_HOST, port: CLAMD_PORT });
    const out = [];
    s.setTimeout(60_000, () => s.destroy(new Error("clamd timeout")));
    s.on("error", reject);
    s.on("data", (d) => out.push(d));
    s.on("end", () => resolve(Buffer.concat(out).toString("utf8").replace(/\0/g, "").trim()));
    s.on("connect", () => {
      s.write(`z${command}\0`);
      if (body) {
        for (let i = 0; i < body.length; i += 65536) {
          const part = body.subarray(i, i + 65536);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(part.length);
          s.write(len);
          s.write(part);
        }
        s.write(Buffer.alloc(4));
      }
    });
  });
}

const authorized = (h) => {
  const given = Buffer.from((h ?? "").replace(/^Bearer /, ""));
  const want = Buffer.from(TOKEN);
  return given.length === want.length && timingSafeEqual(given, want);
};
const json = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
};

http
  .createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") return json(res, (await clamd("PING")) === "PONG" ? 200 : 503, { ok: true });
      if (req.method !== "POST" || req.url !== "/scan") return json(res, 404, { error: "not found" });
      if (!authorized(req.headers.authorization)) return json(res, 401, { error: "unauthorized" });
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > MAX_BYTES) return json(res, 413, { error: "too large" });
        chunks.push(c);
      }
      const reply = await clamd("INSTREAM", Buffer.concat(chunks));
      if (/:\s*OK$/.test(reply)) return json(res, 200, { clean: true });
      const sig = reply.match(/:\s*(.+?)\s+FOUND$/)?.[1];
      if (sig) return json(res, 200, { clean: false, signature: sig });
      return json(res, 502, { error: "unexpected scanner reply" });
    } catch (e) {
      console.error("scan error:", e?.message ?? e);
      return json(res, 503, { error: "scanner unavailable" });
    }
  })
  .listen(PORT, () => console.log(`WHITE-LOTUS scan adapter on :${PORT} → clamd ${CLAMD_HOST}:${CLAMD_PORT}`));
