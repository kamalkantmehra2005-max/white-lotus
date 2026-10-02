import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { parseKeys } from "@/lib/security/encryption";
import { publicUrl } from "@/lib/public-url";

const saved = { ...process.env };
afterEach(() => {
  for (const k of ["AUTH_URL", "APP_URL"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("bare generated keys", () => {
  it("accepts a single bare base64 key as k1", () => {
    const b = randomBytes(32).toString("base64");
    expect(parseKeys(b)).toEqual([{ id: "k1", key: Buffer.from(b, "base64") }]);
  });
  it("still requires ids when several keys are given", () => {
    expect(() => parseKeys(`${randomBytes(32).toString("base64")},${randomBytes(32).toString("base64")}`)).toThrow();
  });
});

describe("publicUrl()", () => {
  it("uses the launcher-provided address", () => {
    delete process.env.AUTH_URL;
    delete process.env.APP_URL;
    expect(publicUrl()).toBe("");
    process.env.APP_URL = "http://127.0.0.1:3000/";
    expect(publicUrl()).toBe("http://127.0.0.1:3000");
  });
});

describe("what counts as 'on this computer'", () => {
  it("classifies AI/search endpoints", async () => {
    const { isLocalEndpoint } = await import("@/lib/ai/registry");
    for (const u of ["http://127.0.0.1:11434", "http://localhost:1234/v1", "http://[::1]:8080", "http://192.168.1.20:11434", "http://10.0.0.5", "http://mybox.local:11434"]) expect(isLocalEndpoint(u)).toBe(true);
    for (const u of ["https://api.groq.com/openai/v1", "https://api.openai.com/v1", "https://api.anthropic.com", "https://8.8.8.8", null, "not a url"]) expect(isLocalEndpoint(u)).toBe(false);
  });
});
