/**
 * Where WHITE-LOTUS keeps everything on this computer. Dependency-free: used by the app, the launcher and scripts.
 *
 *   <config dir>  (never inside the data folder, never synced)
 *     keys.json | keys.dpapi   encryption + session keys (DPAPI-protected on Windows when available)
 *     location.json            { "dataDir": "…" }  — the folder you chose for your data
 *     pending.json             an operation the launcher runs while the app is stopped (move / restore / wipe)
 *
 *   <data dir>    (default below; you can choose another folder)
 *     db/          embedded PostgreSQL (PGlite) — conversations, messages, search history, settings, memories,
 *                  projects, file metadata, search indexes. Sensitive fields are AES-256-GCM encrypted.
 *     files/q/     uploads waiting for the malware scan (quarantine)
 *     files/u/     your files and AI-generated files (each encrypted with AES-256-GCM)
 *     backups/     encrypted backups you create (.wlbackup)
 *     exports/     readable exports you create (.zip)
 *     logs/        server logs (redacted: never message content, keys or passwords)
 *     tmp/         scratch space, cleaned automatically
 *
 * Defaults (outside OneDrive/iCloud and not part of roaming profiles):
 *   Windows  %LOCALAPPDATA%\WHITE-LOTUS\data        config: %LOCALAPPDATA%\WHITE-LOTUS\config
 *   macOS    ~/Library/Application Support/WHITE-LOTUS/data   config: …/WHITE-LOTUS/config
 *   Linux    $XDG_DATA_HOME/white-lotus (~/.local/share)       config: $XDG_CONFIG_HOME/white-lotus (~/.config)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const APP_FOLDER = "WHITE-LOTUS";

function home() {
  return os.homedir();
}

export function defaultRoot(): { data: string; config: string } {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(home(), "AppData", "Local");
    return { data: path.join(base, APP_FOLDER, "data"), config: path.join(base, APP_FOLDER, "config") };
  }
  if (process.platform === "darwin") {
    const base = path.join(home(), "Library", "Application Support", APP_FOLDER);
    return { data: path.join(base, "data"), config: path.join(base, "config") };
  }
  const dataBase = process.env.XDG_DATA_HOME || path.join(home(), ".local", "share");
  const configBase = process.env.XDG_CONFIG_HOME || path.join(home(), ".config");
  return { data: path.join(dataBase, "white-lotus"), config: path.join(configBase, "white-lotus") };
}

/** Config folder: WHITE_LOTUS_CONFIG_DIR overrides (tests, portable installs). */
export function configDir(): string {
  return path.resolve(process.env.WHITE_LOTUS_CONFIG_DIR || defaultRoot().config);
}

/** Data folder: WHITE_LOTUS_DATA_DIR → the folder chosen in location.json → the default. */
export function dataDir(): string {
  if (process.env.WHITE_LOTUS_DATA_DIR) return path.resolve(process.env.WHITE_LOTUS_DATA_DIR);
  const chosen = readJson<{ dataDir?: string }>(path.join(configDir(), "location.json"))?.dataDir;
  return path.resolve(chosen || defaultRoot().data);
}

export const dataPaths = (root = dataDir()) => ({
  root,
  db: path.join(root, "db"),
  files: path.join(root, "files"),
  backups: path.join(root, "backups"),
  exports: path.join(root, "exports"),
  logs: path.join(root, "logs"),
  tmp: path.join(root, "tmp"),
  manifest: path.join(root, "white-lotus-data.json"),
});

export const configPaths = (root = configDir()) => ({
  root,
  keysPlain: path.join(root, "keys.json"),
  keysDpapi: path.join(root, "keys.dpapi"),
  location: path.join(root, "location.json"),
  pending: path.join(root, "pending.json"),
  staging: path.join(root, "staging"),
});

export function ensureDataDirs(root = dataDir()) {
  const p = dataPaths(root);
  for (const d of [p.root, p.db, path.join(p.files, "q"), path.join(p.files, "u"), p.backups, p.exports, p.logs, p.tmp]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  }
  if (!fs.existsSync(p.manifest)) {
    fs.writeFileSync(p.manifest, JSON.stringify({ app: "WHITE-LOTUS", format: 1, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  }
  return p;
}

/** Folders that sync to someone else's servers. Choosing one would put your data in the cloud. */
const CLOUD_SYNC = /(^|[\\/])(OneDrive[^\\/]*|Dropbox|Google Drive|GoogleDrive|My Drive|iCloud ?Drive|iCloudDrive|Mobile Documents|Box|Box Sync|pCloud ?Drive|MEGA|Nextcloud|ownCloud)([\\/]|$)/i;
export function looksCloudSynced(dir: string): boolean {
  const abs = path.resolve(dir);
  if (CLOUD_SYNC.test(abs)) return true;
  for (const v of ["OneDrive", "OneDriveCommercial", "OneDriveConsumer"]) {
    const od = process.env[v];
    if (od && abs.toLowerCase().startsWith(path.resolve(od).toLowerCase())) return true;
  }
  return false;
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeJsonPrivate(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Total bytes under a folder (best effort). */
export function folderSize(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          total += fs.statSync(p).size;
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(dir);
  return total;
}
