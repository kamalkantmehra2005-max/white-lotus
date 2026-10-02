import "server-only";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataPaths } from "@/lib/local/paths";
import { decryptBytes, encryptBytes } from "@/lib/security/encryption";

/**
 * Local file storage — the ONLY storage backend. Files live in <data folder>/files on this computer:
 *   files/q/<user>/…  quarantine (awaiting the malware scan)
 *   files/u/<user>/…  released uploads and AI-generated files
 * Every file is encrypted with AES-256-GCM (key from the local key file, AAD = its storage key) before it touches
 * the disk, so the files folder on its own is unreadable. No cloud storage, no network.
 */
export interface Storage {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** Move an object (quarantine → private area after a clean scan). Re-encrypted under its new key. */
  move(from: string, to: string): Promise<void>;
}

const SAFE_KEY = /^[a-zA-Z0-9/_.-]+$/;
function assertKey(key: string) {
  if (!SAFE_KEY.test(key) || key.includes("..") || key.startsWith("/")) throw new Error("invalid storage key");
}

class LocalStorage implements Storage {
  private get root() {
    return path.resolve(dataPaths().files);
  }
  private p(key: string) {
    assertKey(key);
    const root = this.root;
    const full = path.resolve(root, key);
    if (!full.startsWith(root + path.sep)) throw new Error("invalid storage path");
    return full;
  }
  async put(key: string, data: Buffer) {
    const f = this.p(key);
    await mkdir(path.dirname(f), { recursive: true, mode: 0o700 });
    const tmp = `${f}.${process.pid}.tmp`;
    await writeFile(tmp, encryptBytes(data, `file:${key}`), { mode: 0o600 });
    await rename(tmp, f);
  }
  async get(key: string) {
    return decryptBytes(await readFile(this.p(key)), `file:${key}`);
  }
  async delete(key: string) {
    await rm(this.p(key), { force: true });
  }
  async move(from: string, to: string) {
    // The AAD is bound to the key, so moving means decrypt → re-encrypt under the new name.
    const data = await this.get(from);
    await this.put(to, data);
    await this.delete(from);
  }
}

let instance: Storage | undefined;
export function storage(): Storage {
  instance ??= new LocalStorage();
  return instance;
}
