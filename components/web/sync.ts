"use client";
import { decryptJSON, encryptJSON } from "./crypto";
import type { Conv, Settings, Store } from "./store";

/**
 * End-to-end encrypted sync between this device and the account's other devices.
 * Each conversation (and the settings) is one item; the newest updatedAt wins. The server only sees ciphertext.
 */
type Remote = { id: string; seq: number; updatedAt: number; deleted: boolean; iv: string; ct: string };
const aad = (userId: string, id: string) => `white-lotus:vault:${userId}:${id}`;
const MAX_BATCH_BYTES = 3_000_000;

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) }, credentials: "same-origin" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message ?? `Sync failed (${r.status})`);
  return j as T;
}

export async function syncNow(store: Store, userId: string, key: CryptoKey): Promise<{ pushed: number; pulled: number }> {
  const settings = await store.getSettings();
  if (!settings.sync) return { pushed: 0, pulled: 0 };
  // ---- push local changes ----
  const convs = await store.list();
  const dirty = convs.filter((c) => c.dirty);
  let pushed = 0;
  let batch: Array<{ id: string; updatedAt: number; deleted: boolean; iv: string; ct: string }> = [];
  let size = 0;
  const flush = async () => {
    if (!batch.length) return;
    const r = await api<{ accepted: string[] }>("/api/web/vault", { method: "POST", body: JSON.stringify({ items: batch }) });
    pushed += r.accepted.length;
    batch = [];
    size = 0;
  };
  for (const c of dirty) {
    const { dirty: _d, ...clean } = c;
    void _d;
    const e = c.deleted ? { iv: "AAAAAAAAAAAAAAAA", ct: "" } : await encryptJSON(key, clean, aad(userId, c.id));
    if (size + e.ct.length > MAX_BATCH_BYTES || batch.length >= 50) await flush();
    batch.push({ id: c.id, updatedAt: c.updatedAt, deleted: Boolean(c.deleted), ...e });
    size += e.ct.length;
  }
  if (settings.dirty) {
    const { dirty: _d, ...clean } = settings;
    void _d;
    batch.push({ id: "settings", updatedAt: settings.updatedAt, deleted: false, ...(await encryptJSON(key, clean, aad(userId, "settings"))) });
  }
  await flush();
  for (const c of dirty) await store.put({ ...c, dirty: false });
  if (settings.dirty) await store.putSettings({ ...settings, dirty: false });

  // ---- pull remote changes ----
  let cursor = Number((await store.getMeta("cursor")) ?? 0);
  let pulled = 0;
  const local = new Map((await store.list()).map((c) => [c.id, c]));
  for (let page = 0; page < 50; page++) {
    const r = await api<{ items: Remote[]; cursor: number; more: boolean }>(`/api/web/vault?since=${cursor}`);
    for (const it of r.items) {
      if (it.id === "settings") {
        const mine = await store.getSettings();
        if (it.updatedAt > mine.updatedAt && !it.deleted) {
          const s = await decryptJSON<Settings>(key, it.iv, it.ct, aad(userId, "settings")).catch(() => null);
          if (s) await store.putSettings({ ...s, sync: mine.sync, dirty: false });
        }
        continue;
      }
      const mine = local.get(it.id);
      if (mine && mine.updatedAt >= it.updatedAt) continue;
      if (it.deleted) {
        await store.put({ id: it.id, title: "", createdAt: mine?.createdAt ?? it.updatedAt, updatedAt: it.updatedAt, messages: [], deleted: true, dirty: false });
      } else {
        const c = await decryptJSON<Conv>(key, it.iv, it.ct, aad(userId, it.id)).catch(() => null);
        if (!c) continue; // wrong key / corrupted: leave the local copy alone
        await store.put({ ...c, dirty: false });
      }
      pulled++;
    }
    cursor = r.cursor;
    await store.setMeta("cursor", cursor);
    if (!r.more) break;
  }
  return { pushed, pulled };
}
