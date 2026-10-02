import { describe, expect, it } from "vitest";
import { isPrivateAddress, validateUrl, UrlBlockedError } from "@/lib/security/url-guard";
import { redact } from "@/lib/observability/logger";
import { isSensitiveMemory } from "@/lib/memory/sensitive";
import { linkCitations } from "@/components/chat/markdown";
import { REMEMBER_INTENT } from "@/lib/tools/registry";

const publicResolver = async () => ["93.184.216.34"];

describe("SSRF guard", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
    "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1",
  ])("blocks private/reserved address %s", (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(["8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111"])("allows public address %s", (ip) => expect(isPrivateAddress(ip)).toBe(false));

  it("rejects non-http schemes", async () => {
    for (const u of ["file:///etc/passwd", "gopher://x", "ftp://example.com", "javascript:alert(1)", "data:text/html,hi"]) {
      await expect(validateUrl(u, { resolver: publicResolver })).rejects.toBeInstanceOf(UrlBlockedError);
    }
  });
  it("rejects credentials and odd ports", async () => {
    await expect(validateUrl("http://user:pass@example.com/", { resolver: publicResolver })).rejects.toThrow(/credentials/);
    await expect(validateUrl("http://example.com:6379/", { resolver: publicResolver })).rejects.toThrow(/port/);
  });
  it("rejects internal hostnames and numeric IP tricks", async () => {
    await expect(validateUrl("http://localhost/")).rejects.toThrow();
    await expect(validateUrl("http://metadata.google.internal/")).rejects.toThrow();
    await expect(validateUrl("http://2130706433/")).rejects.toThrow(/private/); // 127.0.0.1 as integer
    await expect(validateUrl("http://0x7f.0.0.1/")).rejects.toThrow(/private/);
    await expect(validateUrl("http://[::1]/")).rejects.toThrow(/private/);
  });
  it("rejects hostnames that resolve to private IPs (DNS pointing inward)", async () => {
    await expect(validateUrl("https://evil.example/", { resolver: async () => ["93.184.216.34", "10.0.0.5"] })).rejects.toThrow(/private/);
  });
  it("accepts a normal public URL", async () => {
    const u = await validateUrl("https://example.com/path?q=1", { resolver: publicResolver });
    expect(u.hostname).toBe("example.com");
  });
});

describe("log redaction", () => {
  it("redacts secrets and truncates user content", () => {
    const out = redact({ apiKey: "sk-abc", password: "x", content: "private message", nested: { authorization: "Bearer abc.def" }, note: "key sk-1234567890abcdef leaked" }) as Record<string, unknown>;
    expect(out.apiKey).toBe("[REDACTED]");
    expect(out.password).toBe("[REDACTED]");
    expect(out.content).toBe("[15 chars]");
    expect((out.nested as Record<string, unknown>).authorization).toBe("[REDACTED]");
    expect(out.note).not.toContain("sk-1234567890abcdef");
  });
});

describe("memory safety", () => {
  it("flags sensitive memories", () => {
    expect(isSensitiveMemory("my password is hunter2")).toBe(true);
    expect(isSensitiveMemory("card 4111 1111 1111 1111")).toBe(true);
    expect(isSensitiveMemory("my API key is abc")).toBe(true);
  });
  it("allows ordinary preferences", () => {
    expect(isSensitiveMemory("I prefer metric units")).toBe(false);
    expect(isSensitiveMemory("I live in Delhi and like cricket")).toBe(false);
  });
});

describe("citation linking (safe markdown)", () => {
  it("links valid citations outside code only", () => {
    const md = "Fact [1] and [2][3]. Code: `arr[1]`\n```\nx[1]\n```";
    const out = linkCitations(md, 3);
    expect(out).toContain("[1](#cite-1)");
    expect(out).toContain("[2](#cite-2)[3](#cite-3)");
    expect(out).toContain("`arr[1]`");
    expect(out).toContain("x[1]\n```");
  });
  it("ignores out-of-range numbers and markdown links", () => {
    expect(linkCitations("see [9]", 3)).toBe("see [9]");
    expect(linkCitations("[1](http://x)", 3)).toBe("[1](http://x)");
  });
});

describe("save_memory intent gate (prompt-injection defence)", () => {
  it("only matches explicit remember requests from the user", () => {
    expect(REMEMBER_INTENT.test("Please remember that I prefer metric units")).toBe(true);
    expect(REMEMBER_INTENT.test("save this to memory")).toBe(true);
    expect(REMEMBER_INTENT.test("don't forget my deadline is Friday")).toBe(true);
    expect(REMEMBER_INTENT.test("summarize this article")).toBe(false);
    expect(REMEMBER_INTENT.test("what's the weather?")).toBe(false);
  });
});
