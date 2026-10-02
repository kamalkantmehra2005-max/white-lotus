/**
 * Backup, restore, move and wipe for the local data folder. Dependency-light and free of "server-only",
 * so both the app (create backup, stage a restore) and the launcher (apply operations while the app is
 * stopped) use the same code.
 *
 * Encrypted backup file (.wlbackup):
 *   "WLBK1\n" + JSON header (kdf params, salt, iv) + "\n" + AES-256-GCM( zip ) + 16-byte tag
 *   The zip holds: manifest.json, keys.json (so a restore works on a new computer), db.tar.gz (a PGlite dump),
 *   files/… (your files, still individually encrypted). The backup key comes from your backup password via scrypt;
 *   without the password the backup is unreadable. WHITE-LOTUS never stores or sends the password.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import JSZip from "jszip";
import { readKeys, writeKeys, type LocalKeys } from "./keys";
import { configPaths, dataDir, dataPaths, ensureDataDirs, looksCloudSynced, readJson, writeJsonPrivate } from "./paths";

const MAGIC = "WLBK1\n";
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

export type PendingOp =
  | { op: "restart" }
  | { op: "wipe"; requestedAt: string }
  | { op: "move"; to: string; deleteOld: boolean; requestedAt: string }
  | { op: "restore"; stagingDir: string; requestedAt: string };

export function writePending(op: PendingOp) {
  writeJsonPrivate(configPaths().pending, op);
}
export function readPending(): PendingOp | null {
  return readJson<PendingOp>(configPaths().pending);
}
export function clearPending() {
  fs.rmSync(configPaths().pending, { force: true });
}

function walkFiles(root: string, rel = ""): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...walkFiles(root, r));
    else if (e.isFile() && !e.name.endsWith(".tmp")) out.push(r);
  }
  return out;
}

export function assertBackupPassword(password: string) {
  if (typeof password !== "string" || password.length < 10) throw new Error("The backup password must be at least 10 characters.");
}

function deriveKey(password: string, salt: Buffer) {
  return scryptSync(password.normalize("NFKC"), salt, 32, SCRYPT);
}

/** Build an encrypted backup of everything (database + files + keys). */
export async function createBackup(pg: PGlite, password: string): Promise<Buffer> {
  assertBackupPassword(password);
  const keys = readKeys();
  if (!keys) throw new Error("Encryption keys not found — cannot create a usable backup.");
  const p = dataPaths();
  const zip = new JSZip();
  const dump = await pg.dumpDataDir("gzip");
  zip.file("db.tar.gz", Buffer.from(await dump.arrayBuffer()));
  zip.file("keys.json", JSON.stringify(keys));
  let fileCount = 0;
  for (const rel of walkFiles(p.files)) {
    zip.file(`files/${rel.split(path.sep).join("/")}`, fs.readFileSync(path.join(p.files, rel)));
    fileCount++;
  }
  zip.file("manifest.json", JSON.stringify({ app: "WHITE-LOTUS", format: 1, createdAt: new Date().toISOString(), files: fileCount }, null, 2));
  const plain = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });

  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", deriveKey(password, salt), iv);
  const header = { v: 1, kdf: "scrypt", N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString("base64"), iv: iv.toString("base64"), createdAt: new Date().toISOString() };
  c.setAAD(Buffer.from(JSON.stringify(header)));
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return Buffer.concat([Buffer.from(MAGIC), Buffer.from(JSON.stringify(header)), Buffer.from("\n"), ct]);
}

/** Decrypt a backup and unpack it into a staging folder (validated). The live data is untouched. */
export async function stageRestore(backup: Buffer, password: string): Promise<{ stagingDir: string; manifest: { createdAt: string; files: number } }> {
  if (!backup.subarray(0, MAGIC.length).equals(Buffer.from(MAGIC))) throw new Error("This isn't a WHITE-LOTUS backup file.");
  const nl = backup.indexOf(0x0a, MAGIC.length);
  const headerJson = backup.subarray(MAGIC.length, nl).toString("utf8");
  const header = JSON.parse(headerJson) as { v: number; N: number; r: number; p: number; salt: string; iv: string };
  if (header.v !== 1) throw new Error("Unsupported backup version.");
  const body = backup.subarray(nl + 1);
  const key = scryptSync(password.normalize("NFKC"), Buffer.from(header.salt, "base64"), 32, { N: header.N, r: header.r, p: header.p, maxmem: SCRYPT.maxmem });
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(header.iv, "base64"));
  d.setAAD(Buffer.from(headerJson));
  d.setAuthTag(body.subarray(body.length - 16));
  let plain: Buffer;
  try {
    plain = Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]);
  } catch {
    throw new Error("Wrong backup password, or the backup file is damaged.");
  }
  const zip = await JSZip.loadAsync(plain);
  const manifest = JSON.parse((await zip.file("manifest.json")?.async("string")) ?? "null");
  const keys = JSON.parse((await zip.file("keys.json")?.async("string")) ?? "null") as LocalKeys | null;
  const db = await zip.file("db.tar.gz")?.async("nodebuffer");
  if (!manifest || manifest.app !== "WHITE-LOTUS" || !keys?.ENCRYPTION_KEYS || !db) throw new Error("The backup is incomplete.");

  const stagingDir = path.join(configPaths().staging, `restore-${Date.now()}`);
  fs.mkdirSync(path.join(stagingDir, "files"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stagingDir, "db.tar.gz"), db, { mode: 0o600 });
  fs.writeFileSync(path.join(stagingDir, "keys.json"), JSON.stringify(keys), { mode: 0o600 });
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name];
    if (entry.dir || !name.startsWith("files/")) continue;
    const rel = name.slice("files/".length);
    if (!rel || rel.includes("..") || path.isAbsolute(rel) || !/^[a-zA-Z0-9/_.-]+$/.test(rel)) continue; // no path traversal
    const dest = path.join(stagingDir, "files", rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.writeFileSync(dest, await entry.async("nodebuffer"), { mode: 0o600 });
  }
  return { stagingDir, manifest };
}

/** Validate a new data-folder location before moving there. */
export function checkNewLocation(target: string, opts: { allowCloudSynced?: boolean } = {}): { ok: true; path: string } | { ok: false; reason: string } {
  if (!target || !path.isAbsolute(target)) return { ok: false, reason: "Enter a full folder path, e.g. D:\\WHITE-LOTUS-data" };
  const abs = path.resolve(target);
  const current = dataDir();
  if (abs === current) return { ok: false, reason: "That's already the current data folder." };
  if (abs.startsWith(current + path.sep) || current.startsWith(abs + path.sep)) return { ok: false, reason: "The new folder can't be inside the current one (or the other way round)." };
  if (!opts.allowCloudSynced && looksCloudSynced(abs)) return { ok: false, reason: "That folder looks like it syncs to a cloud service (OneDrive, Dropbox, Google Drive, iCloud…). Choose a folder that stays on this computer." };
  if (fs.existsSync(abs) && fs.readdirSync(abs).length > 0) return { ok: false, reason: "Choose an empty folder (or one that doesn't exist yet)." };
  try {
    fs.mkdirSync(abs, { recursive: true });
    const probe = path.join(abs, `.wl-write-test-${process.pid}`);
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe);
    if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
  } catch {
    return { ok: false, reason: "WHITE-LOTUS can't write to that folder." };
  }
  return { ok: true, path: abs };
}

/**
 * Apply a pending operation. ONLY call while the app (and its database) is stopped — the launcher does this
 * between runs. Returns a human-readable summary.
 */
export async function applyPending(log: (s: string) => void = console.log): Promise<string | null> {
  const op = readPending();
  if (!op) return null;
  clearPending(); // never loop on a failing operation
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const current = dataDir();

  if (op.op === "restart") return "Restarted.";

  if (op.op === "wipe") {
    fs.rmSync(current, { recursive: true, force: true });
    const c = configPaths();
    fs.rmSync(c.keysPlain, { force: true });
    fs.rmSync(c.keysDpapi, { force: true });
    fs.rmSync(c.staging, { recursive: true, force: true });
    log("All local WHITE-LOTUS data and keys were deleted.");
    return "All local data deleted. WHITE-LOTUS starts fresh.";
  }

  if (op.op === "move") {
    const check = checkNewLocation(op.to, { allowCloudSynced: true });
    if (!check.ok) return `Move cancelled: ${check.reason}`;
    fs.cpSync(current, check.path, { recursive: true, errorOnExist: true, force: false });
    if (!fs.existsSync(dataPaths(check.path).db)) throw new Error("Copy failed — your data stays where it was.");
    writeJsonPrivate(configPaths().location, { dataDir: check.path, movedAt: new Date().toISOString() });
    if (op.deleteOld) fs.rmSync(current, { recursive: true, force: true });
    else fs.writeFileSync(path.join(current, "MOVED-TO.txt"), `This WHITE-LOTUS data was copied to:\n${check.path}\nYou can delete this old folder.\n`);
    log(`Data folder moved to ${check.path}`);
    return `Data folder is now ${check.path}${op.deleteOld ? " (old folder deleted)" : " (old copy kept — you can delete it)"}.`;
  }

  if (op.op === "restore") {
    const s = op.stagingDir;
    if (!fs.existsSync(path.join(s, "db.tar.gz"))) return "Restore cancelled: staged backup not found.";
    const next = `${current}.restoring-${ts}`;
    ensureDataDirs(next);
    fs.rmSync(dataPaths(next).db, { recursive: true, force: true });
    const { PGlite } = await import("@electric-sql/pglite");
    const pg = new PGlite(dataPaths(next).db, { loadDataDir: new Blob([fs.readFileSync(path.join(s, "db.tar.gz"))]) });
    await pg.query("select 1");
    await pg.close();
    fs.cpSync(path.join(s, "files"), dataPaths(next).files, { recursive: true });
    const oldKeys = readKeys();
    if (oldKeys) writeJsonPrivate(path.join(configPaths().root, `keys.before-restore-${ts}.json`), oldKeys);
    const keptOld = fs.existsSync(current) ? `${current}.before-restore-${ts}` : null;
    if (keptOld) fs.renameSync(current, keptOld);
    fs.renameSync(next, current);
    writeKeys(JSON.parse(fs.readFileSync(path.join(s, "keys.json"), "utf8")) as LocalKeys);
    fs.rmSync(s, { recursive: true, force: true });
    log("Backup restored.");
    return `Backup restored.${keptOld ? ` Your previous data was kept at ${keptOld}.` : ""}`;
  }
  return null;
}
