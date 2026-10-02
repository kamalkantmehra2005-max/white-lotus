import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:net";
import { randomBytes } from "node:crypto";

process.env.ENCRYPTION_KEYS = `k1:${randomBytes(32).toString("base64")}`;
process.env.BLIND_INDEX_KEY = randomBytes(32).toString("base64");
process.env.AUTH_SECRET = "unit-test-secret-0123456789abcdefghijkl";

const { blindTokens, searchWords, decryptJson, encryptJson, encrypt, decrypt } = await import("@/lib/security/encryption");
const { AAD } = await import("@/lib/security/fields");
const { buildCsp, makeNonce } = await import("@/lib/security/csp");
const { deviceLabel, ipPrefix } = await import("@/lib/security/sessions");
const { safeRedirectPath, parseId } = await import("@/lib/security/validation");

describe("blind index (searchable encryption)", () => {
  it("normalises words: case, accents, stop-words, light stemming", () => {
    expect(searchWords("The Contracts were TERMINATED by Café owners")).toEqual(["contract", "terminat", "cafe", "owner"]);
  });
  it("produces keyed, deterministic, non-reversible tokens", () => {
    const a = blindTokens("indemnity clause breach");
    const b = blindTokens("Breach of the INDEMNITY clause");
    expect(a.sort()).toEqual(b.sort());
    expect(a.join(" ")).not.toMatch(/indemnity|clause|breach/);
    expect(a.every((t) => /^[A-Za-z0-9_-]{16}$/.test(t))).toBe(true);
  });
  it("a different key gives unrelated tokens (can't be precomputed without the key)", () => {
    const before = blindTokens("arbitration");
    process.env.BLIND_INDEX_KEY = randomBytes(32).toString("base64");
    expect(blindTokens("arbitration")).not.toEqual(before);
  });
});

describe("field encryption labels (AAD)", () => {
  it("every label is distinct, so ciphertext can't be moved between fields/owners", () => {
    const labels = [AAD.title("u"), AAD.message("c"), AAD.messageMeta("c"), AAD.chunk("u"), AAD.file("u"), AAD.project("u"), AAD.projectName("u"), AAD.projectDesc("u"), AAD.memory("u"), AAD.customInstructions("u"), AAD.responseStyle("u")];
    expect(new Set(labels).size).toBe(labels.length);
    const c = encrypt("Client: Acme v. Beta", AAD.title("alice"));
    expect(() => decrypt(c, AAD.title("bob"))).toThrow();
    expect(() => decrypt(c, AAD.file("alice"))).toThrow();
  });
  it("encrypts JSON metadata into an envelope", () => {
    const env = encryptJson({ searchQueries: ["confidential query"] }, AAD.messageMeta("c1"));
    expect(JSON.stringify(env)).not.toContain("confidential");
    expect(decryptJson(env, AAD.messageMeta("c1"))).toEqual({ searchQueries: ["confidential query"] });
    expect(decryptJson(env, AAD.messageMeta("c2"))).toEqual({}); // wrong conversation → nothing
  });
});

describe("signed download links", () => {
  it("work only for the same file, same user, before expiry; tampering fails", async () => {
    vi.resetModules();
    vi.doMock("@/config/env", () => ({ env: { DOWNLOAD_LINK_TTL_SECONDS: 60 } }));
    const { createDownloadLink, checkDownloadLink } = await import("@/lib/files/links");
    const { url } = createDownloadLink("file1", "alice");
    const q = new URL(url, "https://x").searchParams;
    const exp = q.get("exp"),
      sig = q.get("sig");
    expect(checkDownloadLink("file1", "alice", exp, sig)).toBe("ok");
    expect(checkDownloadLink("file1", "bob", exp, sig)).toBe("invalid"); // another user
    expect(checkDownloadLink("file2", "alice", exp, sig)).toBe("invalid"); // another file
    expect(checkDownloadLink("file1", "alice", String(Number(exp) + 3600), sig)).toBe("invalid"); // extended expiry
    expect(checkDownloadLink("file1", "alice", exp, null)).toBe("invalid");
    const past = createDownloadLink("file1", "alice", 10);
    const pq = new URL(past.url, "https://x").searchParams;
    vi.setSystemTime(Date.now() + 11_000);
    expect(checkDownloadLink("file1", "alice", pq.get("exp"), pq.get("sig"))).toBe("expired");
    vi.useRealTimers();
  });
});

describe("malware scanning (fake clamd)", () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((sock) => {
      const chunks: Buffer[] = [];
      sock.on("data", (d) => {
        chunks.push(d);
        const all = Buffer.concat(chunks);
        if (all.length >= 14 && all.subarray(all.length - 4).readUInt32BE(0) === 0) {
          sock.end(all.includes(Buffer.from("EICAR-STANDARD-ANTIVIRUS-TEST-FILE")) ? "stream: Win.Test.EICAR_HDB-1 FOUND\0" : "stream: OK\0");
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => server.close());

  async function scanner(overrides: Record<string, unknown>) {
    vi.resetModules();
    vi.doMock("@/config/env", () => ({ env: { MALWARE_SCANNER: "clamav", CLAMAV_HOST: "127.0.0.1", CLAMAV_PORT: port, MALWARE_SCAN_REQUIRED: false, ...overrides } }));
    return import("@/lib/files/scan");
  }
  const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

  it("clean file → clean, releasable", async () => {
    const s = await scanner({});
    const r = await s.scanBuffer(Buffer.from("ordinary contract text"));
    expect(r).toMatchObject({ status: "clean", engine: "clamav" });
    expect(r.sha256).toHaveLength(64);
    expect(s.releasable(r.status)).toBe(true);
  });
  it("EICAR test file → infected with signature, never releasable", async () => {
    const s = await scanner({});
    const r = await s.scanBuffer(Buffer.from(EICAR));
    expect(r.status).toBe("infected");
    expect(r.signature).toContain("EICAR");
    expect(s.releasable(r.status)).toBe(false);
  });
  it("scanner unreachable → error, fails closed", async () => {
    const s = await scanner({ CLAMAV_PORT: 1 });
    const r = await s.scanBuffer(Buffer.from("x"));
    expect(r.status).toBe("error");
    expect(s.releasable(r.status)).toBe(false);
  });
  it("no scanner: 'unscanned' allowed only when scanning isn't required", async () => {
    let s = await scanner({ MALWARE_SCANNER: "none" });
    expect((await s.scanBuffer(Buffer.from("x"))).status).toBe("unscanned");
    expect(s.releasable("unscanned")).toBe(true);
    s = await scanner({ MALWARE_SCANNER: "none", MALWARE_SCAN_REQUIRED: true });
    expect(s.releasable("unscanned")).toBe(false);
  });
});

describe("sessions & validation helpers", () => {
  it("labels devices coarsely and truncates IPs", () => {
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0) AppleWebKit Chrome/140 Safari Edg/140")).toBe("Edge on Windows");
    expect(deviceLabel("Mozilla/5.0 (Macintosh; Mac OS X 14) Chrome/140 Safari/537")).toBe("Chrome on macOS");
    expect(ipPrefix("203.0.113.77")).toBe("203.0.113.0/24");
    expect(ipPrefix("2001:db8:abcd:1234::1")).toBe("2001:db8:abcd::/48");
  });
  it("rejects open redirects and malformed ids", () => {
    expect(safeRedirectPath("https://evil.com")).toBe("/chat");
    expect(safeRedirectPath("//evil.com")).toBe("/chat");
    expect(safeRedirectPath("/settings?tab=security")).toBe("/settings?tab=security");
    expect(() => parseId("../../etc/passwd")).toThrow();
    expect(parseId("9a143a1c-7569-45e8-9ee4-530aeb53e04f")).toBeTruthy();
  });
});

describe("strict CSP", () => {
  it("uses a nonce + strict-dynamic, no unsafe-inline/eval scripts in production", () => {
    const n = makeNonce();
    const csp = buildCsp(n, { https: true });
    expect(csp).toContain(`'nonce-${n}'`);
    expect(csp).toContain("'strict-dynamic'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-(inline|eval)/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("upgrade-insecure-requests");
    expect(makeNonce()).not.toBe(n);
  });
});
