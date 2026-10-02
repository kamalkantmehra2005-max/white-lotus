/**
 * Runs on the embedded local database (see tests/integration/setup.ts):  npm run test:integration
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { users, usageRecords } from "@/lib/database/schema";
import { rateLimit } from "@/lib/security/rate-limit";
import { adminOverview, adminUsers } from "@/lib/admin/stats";
import { checkSession, createSession, listSessions, revokeAllSessions, revokeSession } from "@/lib/security/sessions";
import { conversations as convTable, messages as msgTable, projects as projTable, attachments as attTable, userSessions } from "@/lib/database/schema";
import { createProject, getProject, listProjects } from "@/lib/projects";
import { getConversationWithMessages as getConvFull } from "@/lib/chat/conversations";
import { assertQuota, recordUsage, usedToday } from "@/lib/usage/quotas";
import { addMessage, createConversation, deleteConversation, getConversation, listConversations, updateConversation } from "@/lib/chat/conversations";
import { ingestUpload, searchChunks, deleteUserFile } from "@/lib/files/documents";
import { createMemory, deleteMemory, getSettings, listAllMemories, updateSettings } from "@/lib/memory";
import { memories, userSettings } from "@/lib/database/schema";
import { claimGuest, createGuest, issueClaimToken, purgeExpiredGuests, verifyClaimToken } from "@/lib/auth/guest";
import { runRetention } from "@/lib/files/retention";

process.env.AUTH_SECRET ??= "integration-test-secret-0123456789abcdef";
process.env.FREE_DAILY_MESSAGES = "3";
process.env.ALLOW_GUEST_CHAT = "true";
process.env.GUEST_DAILY_MESSAGES = "2";
process.env.GUEST_SESSIONS_PER_IP_PER_HOUR = "1000";
process.env.ENCRYPTION_KEYS ??= `k1:${randomBytes(32).toString("base64")}`;
process.env.BLIND_INDEX_KEY ??= randomBytes(32).toString("base64");

let alice = "";
let bob = "";

beforeAll(async () => {
  const [a, b] = await db
    .insert(users)
    .values([{ email: `alice-${Date.now()}@test.dev`, name: "Alice" }, { email: `bob-${Date.now()}@test.dev`, name: "Bob" }])
    .returning({ id: users.id });
  alice = a.id;
  bob = b.id;
});
afterAll(async () => {
  await db.delete(users).where(inArray(users.id, [alice, bob]));
});

describe("rate limiting (Postgres fixed window)", () => {
  it("allows up to the limit then blocks, per key", async () => {
    const key = `test:${Date.now()}`;
    const results = [];
    for (let i = 0; i < 4; i++) results.push((await rateLimit(key, 3, 60)).allowed);
    expect(results).toEqual([true, true, true, false]);
    expect((await rateLimit(`${key}:other`, 3, 60)).allowed).toBe(true);
  });
  it("is atomic under concurrency", async () => {
    const key = `conc:${Date.now()}`;
    const r = await Promise.all(Array.from({ length: 20 }, () => rateLimit(key, 10, 60)));
    expect(r.filter((x) => x.allowed)).toHaveLength(10);
  });
});

describe("usage quotas", () => {
  it("counts usage and enforces the daily limit; admins exempt", async () => {
    for (let i = 0; i < 3; i++) await recordUsage({ userId: alice, kind: "message" });
    expect(await usedToday(alice, "message")).toBe(3);
    await expect(assertQuota(alice, "message", "user")).rejects.toMatchObject({ code: "quota_exceeded" });
    await expect(assertQuota(alice, "message", "admin")).resolves.toBeUndefined();
    await db.delete(usageRecords).where(eq(usageRecords.userId, alice));
  });
});

describe("conversation authorization", () => {
  it("creates, lists, searches, renames, archives and deletes — owner only", async () => {
    const c = await createConversation(alice, { title: "Quantum tea" });
    await addMessage(c.id, { role: "user", content: "Tell me about photosynthesis in orchids" });
    expect((await listConversations(alice)).map((x) => x.id)).toContain(c.id);
    expect((await listConversations(alice, { q: "photosynthesis" })).map((x) => x.id)).toContain(c.id);
    expect((await listConversations(bob)).map((x) => x.id)).not.toContain(c.id);

    await expect(getConversation(bob, c.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(updateConversation(bob, c.id, { title: "hacked" })).rejects.toMatchObject({ code: "not_found" });
    await expect(deleteConversation(bob, c.id)).rejects.toMatchObject({ code: "not_found" });

    await updateConversation(alice, c.id, { title: "Renamed", archived: true });
    expect((await listConversations(alice)).map((x) => x.id)).not.toContain(c.id);
    expect((await listConversations(alice, { archived: true })).map((x) => x.id)).toContain(c.id);

    await deleteConversation(alice, c.id);
    await expect(getConversation(alice, c.id)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("documents: upload → chunk → full-text retrieval", () => {
  it("indexes text and retrieves only the owner's chunks", async () => {
    const text = "Chapter one is about gardening.\n\n" + "The lotus flower grows in muddy water yet blooms clean. ".repeat(40) + "\n\nFinal chapter discusses astronomy and telescopes.";
    const { attachment } = await ingestUpload({ userId: alice, fileName: "book.txt", buffer: Buffer.from(text), maxBytes: 5_000_000 });
    const hits = await searchChunks(alice, "telescopes astronomy");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].content).toContain("telescopes");
    expect(await searchChunks(bob, "telescopes astronomy")).toHaveLength(0);
    expect(await deleteUserFile(bob, attachment.id)).toBe(false);
    expect(await deleteUserFile(alice, attachment.id)).toBe(true);
    expect(await searchChunks(alice, "telescopes astronomy")).toHaveLength(0);
  });
});

describe("memory", () => {
  it("CRUD is scoped to the user and blocks sensitive content", async () => {
    const m = await createMemory(alice, "Prefers dark mode");
    expect((await listAllMemories(alice)).map((x) => x.id)).toContain(m.id);
    expect((await listAllMemories(bob)).map((x) => x.id)).not.toContain(m.id);
    await expect(deleteMemory(bob, m.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(createMemory(alice, "my password is swordfish")).rejects.toMatchObject({ code: "invalid_request" });
    await deleteMemory(alice, m.id);
  });
});

describe("encryption at rest", () => {
  it("stores memories and custom instructions as AES-GCM ciphertext; owners read plaintext", async () => {
    const m = await createMemory(alice, "Allergic to nothing, likes jasmine tea");
    const [raw] = await db.select({ content: memories.content }).from(memories).where(eq(memories.id, m.id));
    expect(raw.content.startsWith("enc:v1:")).toBe(true);
    expect(raw.content).not.toContain("jasmine");
    expect((await listAllMemories(alice)).find((x) => x.id === m.id)?.content).toBe("Allergic to nothing, likes jasmine tea");

    await updateSettings(alice, { customInstructions: "Answer in Hindi when asked", responseStyle: "short" });
    const [rawS] = await db.select().from(userSettings).where(eq(userSettings.userId, alice));
    expect(rawS.customInstructions?.startsWith("enc:v1:")).toBe(true);
    expect((await getSettings(alice)).customInstructions).toBe("Answer in Hindi when asked");
  });
});

describe("admin analytics", () => {
  it("overview and user list queries run (metadata only)", async () => {
    await recordUsage({ userId: alice, kind: "message", model: "custom:mock-model", inputTokens: 5, outputTokens: 7 });
    const o = await adminOverview();
    expect(o.totals.users).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(o.daily)).toBe(true);
    expect(JSON.stringify(o)).not.toContain("jasmine"); // no message/memory content
    const list = await adminUsers("alice");
    expect(list.some((u) => u.id === alice)).toBe(true);
  });
});

describe("server-side sessions", () => {
  it("create → valid; revoke one; revoke all; other users can't revoke; idle timeout", async () => {
    const s1 = await createSession(alice, { userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/140 Edg/140", ip: "203.0.113.9" });
    const s2 = await createSession(alice, {});
    expect(await checkSession(s1, alice)).toBe("ok");
    expect(await checkSession(s1, bob)).toBe("missing"); // bound to its user
    expect((await listSessions(alice)).find((x) => x.id === s1)).toMatchObject({ device: "Edge on Windows", ipPrefix: "203.0.113.0/24" });
    expect(await revokeSession(bob, s1)).toBe(false); // IDOR: bob can't revoke alice's session
    expect(await revokeSession(alice, s1)).toBe(true);
    expect(await checkSession(s1, alice)).toBe("revoked");
    expect(await checkSession(s2, alice)).toBe("ok");
    expect(await revokeAllSessions(alice, "test")).toBeGreaterThanOrEqual(1);
    expect(await checkSession(s2, alice)).toBe("revoked");
    const s3 = await createSession(alice, {});
    await db.update(userSessions).set({ lastSeenAt: new Date(Date.now() - 13 * 3_600_000) }).where(eq(userSessions.id, s3));
    expect(await checkSession(s3, alice)).toBe("idle");
    const s4 = await createSession(alice, {});
    await db.update(userSessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(userSessions.id, s4));
    expect(await checkSession(s4, alice)).toBe("expired");
  });
});

describe("confidential data is ciphertext at rest", () => {
  it("conversation titles, messages, metadata, project names are encrypted; owners read plaintext; blind search works", async () => {
    const c = await createConversation(alice, { title: "Acme Corp v. Beta Ltd — settlement" });
    await addMessage(c.id, { role: "user", content: "Draft a settlement term sheet for Acme", metadata: { searchQueries: ["acme settlement precedent"] } });
    const [rawC] = await db.select().from(convTable).where(eq(convTable.id, c.id));
    const [rawM] = await db.select().from(msgTable).where(eq(msgTable.conversationId, c.id));
    expect(rawC.title.startsWith("enc:v1:")).toBe(true);
    expect(rawM.content.startsWith("enc:v1:")).toBe(true);
    expect(JSON.stringify(rawM.metadata)).not.toContain("acme");
    expect(JSON.stringify(rawM.searchTokens)).not.toMatch(/acme|settlement/i);
    const full = await getConvFull(alice, c.id);
    expect(full.title).toBe("Acme Corp v. Beta Ltd — settlement");
    expect(full.messages[0].content).toBe("Draft a settlement term sheet for Acme");
    expect(full.messages[0].metadata.searchQueries).toEqual(["acme settlement precedent"]);
    expect((await listConversations(alice, { q: "term sheet" })).map((x) => x.id)).toContain(c.id); // message body via blind index
    expect((await listConversations(alice, { q: "beta ltd" })).map((x) => x.id)).toContain(c.id); // title after decryption
    expect((await listConversations(bob, { q: "term sheet" })).map((x) => x.id)).not.toContain(c.id);
    await expect(getConvFull(bob, c.id)).rejects.toMatchObject({ code: "not_found" });

    const p = await createProject(alice, { name: "Matter 2026-114 (Acme)", description: "Confidential", instructions: "Privileged" });
    const [rawP] = await db.select().from(projTable).where(eq(projTable.id, p.id));
    expect([rawP.name, rawP.description, rawP.instructions].every((v) => v?.startsWith("enc:v1:"))).toBe(true);
    expect((await getProject(alice, p.id)).name).toBe("Matter 2026-114 (Acme)");
    expect((await listProjects(bob)).map((x) => x.id)).not.toContain(p.id);
    await expect(getProject(bob, p.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("uploads: quarantine → released; file name + extracted text encrypted; retrieval via blind index", async () => {
    const { attachment, scan } = await ingestUpload({ userId: alice, fileName: "Acme_NDA_draft.txt", buffer: Buffer.from("The receiving party shall keep the disclosing party's information strictly confidential."), maxBytes: 1_000_000 });
    expect(scan.status).toBe("unscanned"); // no scanner configured in this test run → honestly labelled
    const [raw] = await db.select().from(attTable).where(eq(attTable.id, attachment.id));
    expect(raw.fileName.startsWith("enc:v1:")).toBe(true);
    expect(raw.storageKey.startsWith(`u/${alice}/`)).toBe(true); // released out of quarantine
    expect(raw.sha256).toHaveLength(64);
    const hits = await searchChunks(alice, "disclosing party confidential");
    expect(hits[0]?.content).toContain("strictly confidential");
    expect(hits[0]?.title).toBe("Acme_NDA_draft.txt");
    expect(await searchChunks(bob, "disclosing party confidential")).toHaveLength(0);
    await deleteUserFile(alice, attachment.id);
  });
});

describe("guest mode (ALLOW_GUEST_CHAT)", () => {
  it("guests are isolated from each other and from accounts", async () => {
    const g1 = await createGuest("203.0.113.10");
    const g2 = await createGuest("203.0.113.10");
    const c1 = await createConversation(g1.id, { title: "guest one secret" });
    await addMessage(c1.id, { role: "user", content: "guest confidential text" });
    // Another guest and a real account can neither read nor list it.
    await expect(getConversation(g2.id, c1.id)).rejects.toThrow();
    await expect(getConversation(bob, c1.id)).rejects.toThrow();
    expect((await listConversations(g2.id, {})).map((c) => c.id)).not.toContain(c1.id);
    // And a guest can't read an account's conversation.
    const acct = await createConversation(bob, { title: "bob private" });
    await expect(getConversation(g1.id, acct.id)).rejects.toThrow();
    await deleteConversation(bob, acct.id);
    // The guest session can't outlive the guest.
    const [g] = await db.select().from(users).where(eq(users.id, g1.id));
    expect(g.isGuest).toBe(true);
    expect(g.guestExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    await db.delete(users).where(inArray(users.id, [g1.id, g2.id]));
  });

  it("guests get stricter limits and no uploads", async () => {
    const g = await createGuest("203.0.113.11");
    await assertQuota(g.id, "message", "user");
    for (let i = 0; i < 2; i++) await recordUsage({ userId: g.id, kind: "message" });
    await expect(assertQuota(g.id, "message", "user")).rejects.toMatchObject({ code: "quota_exceeded" });
    await expect(assertQuota(g.id, "upload", "user")).rejects.toMatchObject({ code: "account_required" });
    await db.delete(users).where(eq(users.id, g.id));
  });

  it("expired guests and everything they own are purged (also by the retention job)", async () => {
    const g = await createGuest("203.0.113.12");
    const c = await createConversation(g.id, { title: "temp" });
    await addMessage(c.id, { role: "user", content: "to be deleted" });
    await db.update(users).set({ guestExpiresAt: new Date(Date.now() - 1000) }).where(eq(users.id, g.id));
    const r = await runRetention();
    expect(r.guests).toBeGreaterThanOrEqual(1);
    expect(await db.select().from(users).where(eq(users.id, g.id))).toHaveLength(0);
    expect(await db.select().from(convTable).where(eq(convTable.id, c.id))).toHaveLength(0);
    expect(await db.select().from(msgTable).where(eq(msgTable.conversationId, c.id))).toHaveLength(0);
    expect(await purgeExpiredGuests()).toBe(0);
  });

  it("a guest can keep its chats in an account via a signed claim token — never someone else's", async () => {
    const g = await createGuest("203.0.113.13");
    const c = await createConversation(g.id, { title: "keep me" });
    await addMessage(c.id, { role: "user", content: "guest message kept" });
    const token = issueClaimToken(g.id);
    expect(verifyClaimToken(token)).toBe(g.id);
    // Tampered / forged tokens are rejected.
    const forged = token.replace(/.$/, (ch) => (ch === "A" ? "B" : "A"));
    expect(verifyClaimToken(forged)).toBeNull();
    expect(verifyClaimToken(`${bob}.${Math.floor(Date.now() / 1000) + 600}.xxxx`)).toBeNull();
    expect((await claimGuest(forged, alice)).moved).toBe(0);
    // A real account can't be "claimed" into another account, even with a validly signed token.
    expect((await claimGuest(issueClaimToken(bob), alice)).moved).toBe(0);
    // Valid claim: conversation moves (title re-encrypted for the new owner), guest is deleted.
    expect((await claimGuest(token, alice)).moved).toBe(1);
    const moved = await getConvFull(alice, c.id);
    expect(moved.title).toBe("keep me");
    expect(moved.messages[0].content).toBe("guest message kept");
    expect(await db.select().from(users).where(eq(users.id, g.id))).toHaveLength(0);
    // Replay does nothing.
    expect((await claimGuest(token, bob)).moved).toBe(0);
    await deleteConversation(alice, c.id);
  });
});
