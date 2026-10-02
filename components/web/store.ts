"use client";
/**
 * Where the online web app keeps data — always on THIS device:
 *  • With account:   IndexedDB database "white-lotus-u-<account id>" in this browser profile
 *                    (Windows: %LOCALAPPDATA%\<Browser>\User Data\<Profile>\IndexedDB\). One database per account,
 *                    so two accounts on a shared PC never mix. Survives closing the browser.
 *  • Without account: sessionStorage of this tab only — the browser deletes it when the tab/window is closed.
 */
export type Source = { id: number; title: string; url: string; snippet?: string | null };
export type Msg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  sources?: Source[];
  activity?: string[];
  files?: Array<{ name: string; text: string }>;
  images?: string[]; // names only — image data isn't kept
  error?: string;
  model?: string;
};
export type Conv = { id: string; title: string; createdAt: number; updatedAt: number; messages: Msg[]; deleted?: boolean; dirty?: boolean };
export type Settings = { customInstructions: string; model: string | null; mode: string; sync: boolean; updatedAt: number; dirty?: boolean };
export const DEFAULT_SETTINGS: Settings = { customInstructions: "", model: null, mode: "quick", sync: true, updatedAt: 0 };

export interface Store {
  kind: "account" | "temporary";
  list(): Promise<Conv[]>;
  put(c: Conv): Promise<void>;
  getSettings(): Promise<Settings>;
  putSettings(s: Settings): Promise<void>;
  getMeta(key: string): Promise<unknown>;
  setMeta(key: string, v: unknown): Promise<void>;
  destroy(): Promise<void>;
}

export const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 24);

// ───────────── IndexedDB (account) ─────────────

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("conversations")) db.createObjectStore("conversations", { keyPath: "id" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
const req = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => ((r.onsuccess = () => res(r.result)), (r.onerror = () => rej(r.error))));

export async function accountStore(userId: string): Promise<Store> {
  const name = `white-lotus-u-${userId}`;
  const db = await openDb(name);
  const tx = (s: string, mode: IDBTransactionMode = "readonly") => db.transaction(s, mode).objectStore(s);
  return {
    kind: "account",
    list: async () => (await req(tx("conversations").getAll())) as Conv[],
    put: async (c) => void (await req(tx("conversations", "readwrite").put(c))),
    getSettings: async () => ({ ...DEFAULT_SETTINGS, ...((await req(tx("meta").get("settings"))) as Settings | undefined) }),
    putSettings: async (s) => void (await req(tx("meta", "readwrite").put(s, "settings"))),
    getMeta: async (k) => req(tx("meta").get(k)),
    setMeta: async (k, v) => void (await req(tx("meta", "readwrite").put(v, k))),
    destroy: async () => {
      db.close();
      await new Promise((r) => {
        const d = indexedDB.deleteDatabase(name);
        d.onsuccess = d.onerror = d.onblocked = () => r(null);
      });
    },
  };
}

// ───────────── sessionStorage (without account) ─────────────

const GUEST_KEY = "white-lotus-temporary";
type GuestData = { conversations: Conv[]; settings: Settings; meta: Record<string, unknown> };

export function temporaryStore(): Store {
  const read = (): GuestData => {
    try {
      return { conversations: [], settings: DEFAULT_SETTINGS, meta: {}, ...JSON.parse(sessionStorage.getItem(GUEST_KEY) || "{}") };
    } catch {
      return { conversations: [], settings: DEFAULT_SETTINGS, meta: {} };
    }
  };
  const write = (d: GuestData) => {
    try {
      sessionStorage.setItem(GUEST_KEY, JSON.stringify(d));
    } catch {
      /* storage full: keep working in memory for this page */
    }
  };
  return {
    kind: "temporary",
    list: async () => read().conversations,
    put: async (c) => {
      const d = read();
      d.conversations = [...d.conversations.filter((x) => x.id !== c.id), c];
      write(d);
    },
    getSettings: async () => ({ ...DEFAULT_SETTINGS, ...read().settings, sync: false }),
    putSettings: async (s) => write({ ...read(), settings: s }),
    getMeta: async (k) => read().meta[k],
    setMeta: async (k, v) => {
      const d = read();
      d.meta[k] = v;
      write(d);
    },
    destroy: async () => sessionStorage.removeItem(GUEST_KEY),
  };
}

export const temporaryActive = () => {
  try {
    return sessionStorage.getItem(GUEST_KEY) !== null;
  } catch {
    return false;
  }
};

// ───────────── this device's unlocked accounts (vault keys) ─────────────

const KEYS_DB = "white-lotus-keys";
export type DeviceKey = { userId: string; email: string; name: string | null; vaultKey: CryptoKey };

async function keysDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(KEYS_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("keys", { keyPath: "userId" });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function saveDeviceKey(k: DeviceKey) {
  const db = await keysDb();
  await req(db.transaction("keys", "readwrite").objectStore("keys").put(k));
  db.close();
}
export async function loadDeviceKey(userId: string): Promise<DeviceKey | null> {
  const db = await keysDb();
  const k = (await req(db.transaction("keys").objectStore("keys").get(userId))) as DeviceKey | undefined;
  db.close();
  return k ?? null;
}
export async function forgetDeviceKey(userId: string) {
  const db = await keysDb();
  await req(db.transaction("keys", "readwrite").objectStore("keys").delete(userId));
  db.close();
}
