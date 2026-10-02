/**
 * Local key management. Keys are generated on this computer on first run and kept in the CONFIG folder,
 * separate from the data folder — so a copy of the data folder alone (or a stolen backup drive holding only
 * the data folder) can't be decrypted.
 *
 *   Windows: keys.dpapi — protected with Windows DPAPI (bound to your Windows user account) when available;
 *            otherwise keys.json with permissions restricted to your user.
 *   macOS / Linux: keys.json with 0600 permissions (owner-only).
 *
 * Safety rules:
 *   • Keys are never regenerated when a database already exists (that would make your data unreadable) —
 *     the launcher stops with a clear message instead.
 *   • Encrypted backups (.wlbackup) include the keys, protected by the backup password, so you can restore on
 *     a new computer.
 *   • Keys are never logged and never sent anywhere.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { configPaths, readJson, writeJsonPrivate } from "./paths";

export type LocalKeys = { AUTH_SECRET: string; ENCRYPTION_KEYS: string; BLIND_INDEX_KEY: string; CRON_SECRET: string };

export class KeysMissingError extends Error {}

export function generateKeys(): LocalKeys {
  const r = () => randomBytes(32).toString("base64");
  return { AUTH_SECRET: r(), ENCRYPTION_KEYS: `k1:${r()}`, BLIND_INDEX_KEY: r(), CRON_SECRET: randomBytes(24).toString("base64url") };
}

function valid(k: Partial<LocalKeys> | null): k is LocalKeys {
  return Boolean(k && k.AUTH_SECRET && k.AUTH_SECRET.length >= 32 && k.ENCRYPTION_KEYS && k.BLIND_INDEX_KEY && k.CRON_SECRET);
}

// ── Windows DPAPI via the built-in Windows PowerShell (no extra software). Input/output via stdin/stdout. ──
const PS_PROTECT =
  "Add-Type -AssemblyName System.Security; $i=[Console]::In.ReadToEnd().Trim(); $b=[Convert]::FromBase64String($i); " +
  "$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($p))";
const PS_UNPROTECT =
  "Add-Type -AssemblyName System.Security; $i=[Console]::In.ReadToEnd().Trim(); $b=[Convert]::FromBase64String($i); " +
  "$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($p))";

function powershell(script: string, input: string): string {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { input, encoding: "utf8", windowsHide: true, timeout: 20_000 }).trim();
}

function dpapiProtect(plain: string): string | null {
  if (process.platform !== "win32") return null;
  try {
    const blob = powershell(PS_PROTECT, Buffer.from(plain, "utf8").toString("base64"));
    // Only trust DPAPI if a round trip gives back exactly what we stored.
    if (dpapiUnprotect(blob) === plain) return blob;
  } catch {
    /* DPAPI unavailable (e.g. restricted PowerShell) — fall back to an owner-only file */
  }
  return null;
}

function dpapiUnprotect(blob: string): string {
  return Buffer.from(powershell(PS_UNPROTECT, blob), "base64").toString("utf8");
}

function restrictWindowsAcl(file: string) {
  if (process.platform !== "win32") return;
  try {
    const user = process.env.USERNAME;
    if (user) execFileSync("icacls", [file, "/inheritance:r", "/grant:r", `${user}:F`], { windowsHide: true, stdio: "ignore", timeout: 10_000 });
  } catch {
    /* best effort */
  }
}

export function readKeys(configRoot?: string): LocalKeys | null {
  const c = configPaths(configRoot);
  if (fs.existsSync(c.keysDpapi)) {
    const blob = fs.readFileSync(c.keysDpapi, "utf8");
    const k = JSON.parse(dpapiUnprotect(blob)) as LocalKeys; // throws if this isn't the same Windows user
    if (valid(k)) return k;
  }
  const plain = readJson<LocalKeys>(c.keysPlain);
  return valid(plain) ? plain : null;
}

export function writeKeys(keys: LocalKeys, configRoot?: string): "dpapi" | "file" {
  const c = configPaths(configRoot);
  fs.mkdirSync(c.root, { recursive: true, mode: 0o700 });
  const json = JSON.stringify(keys);
  const blob = dpapiProtect(json);
  if (blob) {
    fs.writeFileSync(c.keysDpapi, blob, { mode: 0o600 });
    if (fs.existsSync(c.keysPlain)) fs.rmSync(c.keysPlain);
    return "dpapi";
  }
  writeJsonPrivate(c.keysPlain, keys);
  restrictWindowsAcl(c.keysPlain);
  return "file";
}

/** Load keys, or create them on first run. Refuses to create new keys over existing data. */
export function loadOrCreateKeys(opts: { databaseExists: boolean; configRoot?: string }): { keys: LocalKeys; created: boolean; protection: "dpapi" | "file" } {
  const existing = readKeys(opts.configRoot);
  const c = configPaths(opts.configRoot);
  if (existing) return { keys: existing, created: false, protection: fs.existsSync(c.keysDpapi) ? "dpapi" : "file" };
  if (opts.databaseExists) {
    throw new KeysMissingError(
      `Your WHITE-LOTUS data exists but its keys are missing from ${c.root}.\n` +
        "Restore them from a .wlbackup (npm run local -- restore <file>) or put back keys.json / keys.dpapi.\n" +
        "New keys are NOT created automatically, because that would make your existing data unreadable.",
    );
  }
  const keys = generateKeys();
  const protection = writeKeys(keys, opts.configRoot);
  return { keys, created: true, protection };
}
