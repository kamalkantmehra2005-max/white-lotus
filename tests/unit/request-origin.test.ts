import { describe, expect, it } from "vitest";
import { allowedOriginHosts, isLoopbackRequest } from "@/lib/security/request-origin";

const h = (o: Record<string, string>) => new Headers(o);

describe("request origin", () => {
  it("treats a direct browser request on this computer as loopback", () => {
    expect(isLoopbackRequest(h({ host: "127.0.0.1:3000" }))).toBe(true);
    expect(isLoopbackRequest(h({ host: "localhost:3000" }))).toBe(true);
    // what Next.js adds by itself for a direct request
    expect(isLoopbackRequest(h({ host: "127.0.0.1:3000", "x-forwarded-for": "::ffff:127.0.0.1", "x-forwarded-host": "127.0.0.1:3000", "x-forwarded-proto": "http" }))).toBe(true);
  });
  it("treats anything forwarded (Tailscale serve, tunnels) as remote", () => {
    expect(isLoopbackRequest(h({ host: "127.0.0.1:3000", "x-forwarded-for": "100.64.0.2" }))).toBe(false);
    expect(isLoopbackRequest(h({ host: "my-pc.tail1234.ts.net" }))).toBe(false);
    expect(isLoopbackRequest(h({ host: "127.0.0.1:3000", "x-forwarded-host": "my-pc.tail1234.ts.net" }))).toBe(false);
    expect(isLoopbackRequest(h({ host: "127.0.0.1:3000", "tailscale-user-login": "me@example.com" }))).toBe(false);
    expect(isLoopbackRequest(h({ host: "127.0.0.1:3000", "cf-connecting-ip": "1.2.3.4" }))).toBe(false);
  });
  it("allows the public Tailscale address and the request host as origins", () => {
    const s = allowedOriginHosts(h({ host: "127.0.0.1:3000", "x-forwarded-host": "my-pc.tail1234.ts.net" }), "https://my-pc.tail1234.ts.net");
    expect(s.has("my-pc.tail1234.ts.net")).toBe(true);
    expect(s.has("127.0.0.1:3000")).toBe(true);
    expect(s.has("evil.example")).toBe(false);
  });
});
