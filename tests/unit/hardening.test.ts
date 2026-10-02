import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { hashPassword, needsRehash, verifyPassword } from "@/lib/auth/password";
import { decrypt, encrypt, encryptionEnabled, isEncrypted, parseKeys, sign, verifySignature } from "@/lib/security/encryption";
import { toGeminiSchema, GoogleProvider } from "@/lib/ai/providers/google";
import { AnthropicProvider } from "@/lib/ai/providers/anthropic";
import { OpenAICompatibleProvider } from "@/lib/ai/providers/openai-compatible";
import { extractLinks, normalizeUrl, urlsInText } from "@/lib/search/html";
import { diversify } from "@/lib/search/research";
import type { StreamEvent } from "@/lib/ai/types";

import { randomBytes } from "node:crypto";
const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");

describe("password hashing (Argon2id)", () => {
  it("hashes with argon2id and verifies", async () => {
    const h = await hashPassword("correct horse 42");
    expect(h.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword("correct horse 42", h)).toBe(true);
    expect(await verifyPassword("wrong horse 42", h)).toBe(false);
    expect(needsRehash(h)).toBe(false);
  });
  it("still verifies legacy bcrypt hashes and flags them for upgrade", async () => {
    const legacy = await bcrypt.hash("old password 1", 4);
    expect(await verifyPassword("old password 1", legacy)).toBe(true);
    expect(needsRehash(legacy)).toBe(true);
  });
  it("returns false (not throws) for unknown users and garbage hashes", async () => {
    expect(await verifyPassword("x", null)).toBe(false);
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
  });
});

describe("AES-256-GCM field encryption", () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEYS = `k2:${KEY_B},k1:${KEY_A}`;
  });
  afterEach(() => {
    process.env.ENCRYPTION_KEYS = `k2:${KEY_B},k1:${KEY_A}`;
  });
  it("round-trips with the current key and random IVs", () => {
    expect(encryptionEnabled()).toBe(true);
    const a = encrypt("secret instructions", "u1:ci");
    const b = encrypt("secret instructions", "u1:ci");
    expect(a).not.toBe(b);
    expect(a.startsWith("enc:v1:k2:")).toBe(true);
    expect(isEncrypted(a)).toBe(true);
    expect(decrypt(a, "u1:ci")).toBe("secret instructions");
  });
  it("binds ciphertext to its owner (AAD) and detects tampering", () => {
    const c = encrypt("mine", "alice:mem");
    expect(() => decrypt(c, "bob:mem")).toThrow();
    const tampered = c.slice(0, -2) + (c.endsWith("A") ? "B" : "A") + c.slice(-1);
    expect(() => decrypt(tampered, "alice:mem")).toThrow();
  });
  it("decrypts data written with an older key (rotation) and passes legacy plaintext through", () => {
    process.env.ENCRYPTION_KEYS = `k1:${KEY_A}`;
    const old = encrypt("rotated", "x");
    process.env.ENCRYPTION_KEYS = `k2:${KEY_B},k1:${KEY_A}`;
    expect(decrypt(old, "x")).toBe("rotated");
    expect(decrypt("plain legacy", "x")).toBe("plain legacy");
  });
  it("rejects malformed keys", () => {
    expect(() => parseKeys("k1:tooshort")).toThrow(/32 bytes/);
    expect(() => parseKeys("nokeyid")).toThrow();
    expect(() => parseKeys(`k1:${Buffer.alloc(32, 7).toString("base64")}`)).toThrow(/not random/);
    expect(() => parseKeys(`k1:${KEY_A},k1:${KEY_B}`)).toThrow(/Duplicate/);
  });
  it("signs and verifies URL payloads", () => {
    process.env.AUTH_SECRET = "test-secret-0123456789abcdefghijkl";
    const s = sign("file:1:exp");
    expect(verifySignature("file:1:exp", s)).toBe(true);
    expect(verifySignature("file:2:exp", s)).toBe(false);
  });
});

describe("Gemini tool schemas", () => {
  it("strips keys Gemini rejects, recursively", () => {
    const out = toGeminiSchema({
      type: "object",
      additionalProperties: false,
      $schema: "x",
      properties: { q: { type: "string", minLength: 1, default: "a", description: "d" }, list: { type: "array", items: { type: "string", additionalProperties: false } } },
      required: ["q"],
    });
    expect(out).toEqual({ type: "object", properties: { q: { type: "string", description: "d" }, list: { type: "array", items: { type: "string" } } }, required: ["q"] });
  });
  it("replays thought signatures on function calls", () => {
    const { contents } = GoogleProvider.toWire([
      { role: "user", content: "q" },
      { role: "assistant", content: "", toolCalls: [{ id: "g1", name: "t", arguments: "{}" }], providerState: { provider: "google", data: [{ id: "g1", thoughtSignature: "SIG" }] } },
    ]);
    expect(contents[1].parts[0]).toMatchObject({ functionCall: { name: "t" }, thoughtSignature: "SIG" });
  });
});

describe("Anthropic extended thinking + tools", () => {
  it("puts signed thinking blocks before tool_use when replaying", () => {
    const { messages } = AnthropicProvider.toWire([
      { role: "user", content: "q" },
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "calc", arguments: "{}" }], providerState: { provider: "anthropic", data: [{ type: "thinking", thinking: "…", signature: "S" }] } },
      { role: "tool", toolCallId: "t1", name: "calc", content: "{}" },
    ]);
    expect(messages[1].content[0]).toEqual({ type: "thinking", thinking: "…", signature: "S" });
    expect(messages[1].content[1]).toMatchObject({ type: "tool_use", id: "t1" });
  });
});

describe("OpenAI-compatible: tool calls without index (older Ollama)", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("keeps two whole tool calls separate", async () => {
    const chunk = { choices: [{ delta: { tool_calls: [{ id: "a", function: { name: "time", arguments: "{}" } }, { id: "b", function: { name: "calculator", arguments: '{"expression":"1"}' } }] }, finish_reason: "tool_calls" }] };
    const body = `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode(body)), c.close()) }))));
    const p = new OpenAICompatibleProvider("ollama", "Ollama", "http://x/v1", undefined, { requireKey: false, timeoutMs: 5000 });
    const calls: StreamEvent[] = [];
    for await (const e of p.stream({ model: "m", messages: [{ role: "user", content: "x" }] })) if (e.type === "tool_call") calls.push(e);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => (c as Extract<StreamEvent, { type: "tool_call" }>).call.name)).toEqual(["time", "calculator"]);
  });
});

describe("URL allow-list helpers", () => {
  it("finds user-typed URLs and normalizes them", () => {
    expect(urlsInText("see https://Example.com/a/, and http://x.org/b?c=1.")).toEqual(["https://Example.com/a/", "http://x.org/b?c=1"]);
    expect(normalizeUrl("https://WWW.Example.com/a/#frag")).toBe("https://example.com/a");
  });
  it("extracts absolute links from pages (relative resolved against base, javascript: dropped)", () => {
    const links = extractLinks('<a href="/docs">d</a><a href="https://y.com/p#x">p</a><a href="javascript:alert(1)">x</a>', "https://base.com/page");
    expect(links).toEqual(["https://base.com/docs", "https://y.com/p"]);
  });
});

describe("research source diversity", () => {
  it("round-robins across queries, dedupes, and caps per domain", () => {
    const r = (u: string) => ({ title: u, url: u, snippet: "", source: "t" });
    const out = diversify(
      [
        [r("https://a.com/1"), r("https://a.com/2"), r("https://a.com/3")],
        [r("https://b.com/1"), r("https://a.com/1")],
      ],
      10,
      2,
    );
    expect(out.map((x) => x.url)).toEqual(["https://a.com/1", "https://b.com/1", "https://a.com/2"]);
  });
});
