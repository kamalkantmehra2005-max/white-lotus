/**
 * The embedded database must only be opened by ONE process at a time (PGlite is single-process).
 * A small lock file in the data folder records which process has it open; a stale lock (process gone) is taken over.
 */
import fs from "node:fs";
import path from "node:path";
import { dataPaths } from "./paths";

export class DataInUseError extends Error {}

const lockFile = (root?: string) => path.join(dataPaths(root).root, ".white-lotus.lock");

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function acquireDataLock(root?: string) {
  const f = lockFile(root);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  try {
    const held = JSON.parse(fs.readFileSync(f, "utf8")) as { pid: number };
    if (held.pid !== process.pid && alive(held.pid)) {
      throw new DataInUseError(`WHITE-LOTUS data is already open in another process (pid ${held.pid}). Close WHITE-LOTUS first.`);
    }
  } catch (e) {
    if (e instanceof DataInUseError) throw e;
  }
  fs.writeFileSync(f, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { mode: 0o600 });
  const release = () => releaseDataLock(root);
  process.once("exit", release);
}

export function releaseDataLock(root?: string) {
  const f = lockFile(root);
  try {
    const held = JSON.parse(fs.readFileSync(f, "utf8")) as { pid: number };
    if (held.pid === process.pid) fs.rmSync(f, { force: true });
  } catch {
    /* nothing to release */
  }
}
