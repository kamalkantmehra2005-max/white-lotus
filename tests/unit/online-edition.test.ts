import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  vi.resetModules();
});

describe("online edition", () => {
  it("is chosen by DATABASE_URL unless the local launcher is running", async () => {
    const { edition } = await import("@/lib/edition");
    delete process.env.WHITE_LOTUS_EDITION;
    delete process.env.DATABASE_URL;
    expect(edition()).toBe("local");
    process.env.DATABASE_URL = "postgres://x";
    expect(edition()).toBe("cloud");
    process.env.WHITE_LOTUS_LAUNCHER = "1";
    expect(edition()).toBe("local");
    process.env.WHITE_LOTUS_EDITION = "cloud";
    expect(edition()).toBe("cloud");
  });

  it("derives stable, independent keys from AUTH_SECRET when they aren't set", async () => {
    process.env.WHITE_LOTUS_EDITION = "cloud";
    process.env.AUTH_SECRET = "a".repeat(20) + "b".repeat(20);
    delete process.env.ENCRYPTION_KEYS;
    delete process.env.BLIND_INDEX_KEY;
    const { ensureCloudKeys } = await import("@/lib/security/cloud-keys");
    ensureCloudKeys();
    const enc = process.env.ENCRYPTION_KEYS!;
    const idx = process.env.BLIND_INDEX_KEY!;
    expect(enc).toMatch(/^k1:[A-Za-z0-9+/]{43}=$/);
    expect(Buffer.from(idx, "base64")).toHaveLength(32);
    expect(enc.slice(3)).not.toBe(idx);
    delete process.env.ENCRYPTION_KEYS;
    ensureCloudKeys();
    expect(process.env.ENCRYPTION_KEYS).toBe(enc);
  });

  it("never overrides keys that are configured", async () => {
    process.env.WHITE_LOTUS_EDITION = "cloud";
    process.env.AUTH_SECRET = "x".repeat(40);
    process.env.ENCRYPTION_KEYS = "k1:custom";
    const { ensureCloudKeys } = await import("@/lib/security/cloud-keys");
    ensureCloudKeys();
    expect(process.env.ENCRYPTION_KEYS).toBe("k1:custom");
  });

  it("detects the host's public address", async () => {
    delete process.env.AUTH_URL;
    delete process.env.APP_URL;
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "white-lotus.vercel.app";
    const { publicUrl } = await import("@/lib/public-url");
    expect(publicUrl()).toBe("https://white-lotus.vercel.app");
  });
});
