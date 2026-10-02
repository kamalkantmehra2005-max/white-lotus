/** Local-first storage: files encrypted on disk, search history, export, encrypted backup round trip, keys. */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, getPglite } from "@/lib/database/client";
import { searchHistory, users } from "@/lib/database/schema";
import { ingestUpload } from "@/lib/files/documents";
import { buildExport, buildExportZip } from "@/lib/local/export";
import { generateKeys, loadOrCreateKeys, KeysMissingError, readKeys, writeKeys } from "@/lib/local/keys";
import { createBackup, stageRestore, checkNewLocation } from "@/lib/local/ops";
import { dataPaths, looksCloudSynced } from "@/lib/local/paths";
import { deleteSearches, listSearches, recordSearches } from "@/lib/local/search-history";
import { addMessage, createConversation } from "@/lib/chat/conversations";
import type { SessionUser } from "@/lib/auth";

process.env.AUTH_SECRET ??= "integration-test-secret-0123456789abcdef";
process.env.ENCRYPTION_KEYS ??= `k1:${randomBytes(32).toString("base64")}`;
process.env.BLIND_INDEX_KEY ??= randomBytes(32).toString("base64");

let owner = "";
let other = "";
const asUser = (id: string): SessionUser => ({ id, role: "user", email: "o@test.dev", name: "Owner", sid: "s", isGuest: false, guestExpiresAt: null });

beforeAll(async () => {
  const [a, b] = await db.insert(users).values([{ email: `owner-${Date.now()}@t.dev`, name: "Owner" }, { email: `other-${Date.now()}@t.dev`, name: "Other" }]).returning({ id: users.id });
  owner = a.id;
  other = b.id;
  writeKeys({ ...generateKeys(), ENCRYPTION_KEYS: process.env.ENCRYPTION_KEYS!, BLIND_INDEX_KEY: process.env.BLIND_INDEX_KEY!, AUTH_SECRET: process.env.AUTH_SECRET! });
});
afterAll(async () => {
  await db.delete(users).where(eq(users.id, owner));
  await db.delete(users).where(eq(users.id, other));
});

describe("local files", () => {
  it("are written to the local data folder, encrypted (no plaintext on disk)", async () => {
    const secret = "Privileged memo: settlement authority is 2.5 million.";
    const { attachment } = await ingestUpload({ userId: owner, fileName: "memo.txt", buffer: Buffer.from(secret), maxBytes: 1_000_000 });
    const onDisk = fs.readFileSync(path.join(dataPaths().files, attachment.storageKey));
    expect(onDisk.subarray(0, 4).toString()).toBe("WLF1");
    expect(onDisk.includes(Buffer.from("settlement"))).toBe(false);
    expect(attachment.storageKey.startsWith(`u/${owner}/`)).toBe(true);
  });
});

describe("search history (local, encrypted, owner-scoped)", () => {
  it("records, lists, isolates and deletes", async () => {
    await recordSearches(owner, null, ["trade mark opposition deadline India", "trade mark opposition deadline India", "  "]);
    const mine = await listSearches(owner);
    expect(mine.map((s) => s.query)).toEqual(["trade mark opposition deadline India"]);
    const [raw] = await db.select().from(searchHistory).where(eq(searchHistory.userId, owner));
    expect(raw.query.startsWith("enc:v1:")).toBe(true);
    expect(await listSearches(other)).toHaveLength(0);
    expect(await deleteSearches(other, [mine[0].id])).toBe(0); // can't delete someone else's
    expect(await deleteSearches(owner)).toBe(1);
  });
});

describe("export", () => {
  it("JSON and ZIP contain your conversations, search history and decrypted files", async () => {
    const c = await createConversation(owner, { title: "Export check" });
    await addMessage(c.id, { role: "user", content: "hello export" });
    await recordSearches(owner, c.id, ["export query"]);
    const data = await buildExport(asUser(owner));
    expect(data.conversations.some((x) => x.title === "Export check" && x.messages[0].content === "hello export")).toBe(true);
    expect(data.searchHistory[0].query).toBe("export query");
    const zip = await JSZip.loadAsync(await buildExportZip(asUser(owner)));
    const names = Object.keys(zip.files);
    expect(names).toContain("export.json");
    expect(names.some((n) => n.startsWith("conversations/") && n.includes("Export check"))).toBe(true);
    const memo = names.find((n) => n.startsWith("uploads/memo"));
    expect(memo).toBeTruthy();
    expect(await zip.file(memo!)!.async("string")).toContain("settlement authority");
  });
});

describe("encrypted backup", () => {
  it("round-trips with the right password and refuses a wrong one", async () => {
    const buf = await createBackup(getPglite(), "correct horse battery");
    expect(buf.subarray(0, 6).toString()).toBe("WLBK1\n");
    expect(buf.includes(Buffer.from("hello export"))).toBe(false);
    await expect(stageRestore(buf, "wrong password!!")).rejects.toThrow(/Wrong backup password/);
    const staged = await stageRestore(buf, "correct horse battery");
    expect(fs.existsSync(path.join(staged.stagingDir, "db.tar.gz"))).toBe(true);
    expect(fs.readdirSync(path.join(staged.stagingDir, "files"), { recursive: true }).length).toBeGreaterThan(0);
    const keys = JSON.parse(fs.readFileSync(path.join(staged.stagingDir, "keys.json"), "utf8"));
    expect(keys.ENCRYPTION_KEYS).toBe(process.env.ENCRYPTION_KEYS);
    // The staged database really contains the data.
    const { PGlite } = await import("@electric-sql/pglite");
    const pg = new PGlite(fs.mkdtempSync(path.join(os.tmpdir(), "wl-restore-")), { loadDataDir: new Blob([fs.readFileSync(path.join(staged.stagingDir, "db.tar.gz"))]) });
    const r = await pg.query<{ n: number }>("select count(*)::int as n from users where id = $1", [owner]);
    expect(r.rows[0].n).toBe(1);
    await pg.close();
    fs.rmSync(staged.stagingDir, { recursive: true, force: true });
  });
});

describe("keys and locations", () => {
  it("never creates new keys over existing data; loads existing keys", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-keys-"));
    expect(() => loadOrCreateKeys({ databaseExists: true, configRoot: dir })).toThrow(KeysMissingError);
    const first = loadOrCreateKeys({ databaseExists: false, configRoot: dir });
    expect(first.created).toBe(true);
    expect(fs.statSync(path.join(dir, "keys.json")).mode & 0o077).toBe(0);
    const again = loadOrCreateKeys({ databaseExists: true, configRoot: dir });
    expect(again.created).toBe(false);
    expect(again.keys).toEqual(first.keys);
    expect(readKeys(dir)).toEqual(first.keys);
  });
  it("refuses cloud-synced or non-empty folders for data", () => {
    expect(looksCloudSynced("C:\\Users\\kamal\\OneDrive - Remfry\\Desktop\\data")).toBe(true);
    expect(looksCloudSynced("/Users/k/Library/Mobile Documents/com~apple~CloudDocs/wl")).toBe(true);
    expect(looksCloudSynced("/home/k/Dropbox/wl")).toBe(true);
    expect(looksCloudSynced("D:\\WHITE-LOTUS-data")).toBe(false);
    expect(checkNewLocation("relative/path").ok).toBe(false);
    expect(checkNewLocation(dataPaths().root).ok).toBe(false);
    const full = fs.mkdtempSync(path.join(os.tmpdir(), "wl-full-"));
    fs.writeFileSync(path.join(full, "x"), "x");
    expect(checkNewLocation(full).ok).toBe(false);
    expect(checkNewLocation(path.join(os.tmpdir(), `wl-new-${Date.now()}`)).ok).toBe(true);
  });
});
