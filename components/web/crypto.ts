"use client";
/**
 * Browser-side cryptography for the online edition (WebCrypto only — nothing here reaches the server):
 *   master   = PBKDF2-SHA256(password, salt, ≥600k iterations)
 *   login    = HKDF(master, "white-lotus:auth")   → sent to the server instead of the password
 *   vaultKey = HKDF(master, "white-lotus:vault")  → AES-256-GCM key that encrypts sync copies; never leaves the device
 * The server stores Argon2id(login), so it can check sign-ins but can't derive the vault key.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64u = (buf: ArrayBuffer | Uint8Array) => {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

export function randomSalt(): string {
  return b64u(crypto.getRandomValues(new Uint8Array(16)));
}

export async function deriveKeys(password: string, salt: string, iterations: number): Promise<{ authSecret: string; vaultKey: CryptoKey }> {
  const base = await crypto.subtle.importKey("raw", enc.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  const master = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(`white-lotus:${salt}`), iterations }, base, 256);
  const hk = await crypto.subtle.importKey("raw", master, "HKDF", false, ["deriveBits", "deriveKey"]);
  const auth = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode("white-lotus:auth") }, hk, 256);
  // Non-extractable: the browser can use it but scripts can't read the raw key bytes out.
  const vaultKey = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode("white-lotus:vault") }, hk, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  return { authSecret: b64u(auth), vaultKey };
}

export async function encryptJSON(key: CryptoKey, value: unknown, aad: string): Promise<{ iv: string; ct: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, enc.encode(JSON.stringify(value)));
  return { iv: b64u(iv), ct: b64u(ct) };
}

export async function decryptJSON<T>(key: CryptoKey, iv: string, ct: string, aad: string): Promise<T> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64u(iv), additionalData: enc.encode(aad) }, key, fromB64u(ct));
  return JSON.parse(dec.decode(pt)) as T;
}
