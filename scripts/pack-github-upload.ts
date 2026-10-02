/**
 * Packs the project into zip files of fewer than 100 files each (GitHub's browser uploader limit), keeping the
 * folder structure, so the whole project can be put on GitHub with a few drag-and-drops:  npm run pack:github
 * Output: github-upload-<n>-of-<total>.zip next to this project. Unzip each, select everything inside the
 * upload-<n> folder, drag it onto the repository's "Upload files" page and commit.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";

const root = path.resolve(__dirname, "..");
const SKIP = [/^node_modules\//, /^\.next\//, /^\.vercel\//, /^\.git\//, /^github-upload-/, /^\.env(\..*)?$/, /^test-results\//, /^playwright-report\//, /tsconfig\.tsbuildinfo$/];

function listFiles(): string[] {
  try {
    return execSync("git ls-files", { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/).filter(Boolean);
  } catch {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = path.relative(root, path.join(dir, e.name)).split(path.sep).join("/");
        if (SKIP.some((r) => r.test(rel + (e.isDirectory() ? "/" : "")))) continue;
        if (e.isDirectory()) walk(path.join(dir, e.name));
        else out.push(rel);
      }
    };
    walk(root);
    return out.sort();
  }
}

async function main() {
  const files = listFiles().filter((f) => !SKIP.some((r) => r.test(f)));
  const byTop = new Map<string, string[]>();
  for (const f of files) {
    const top = f.includes("/") ? f.split("/")[0] : "(root)";
    byTop.set(top, [...(byTop.get(top) ?? []), f]);
  }
  // Greedy packing of top-level folders into batches of < 95 files; root files go in the last batch.
  const groups = [...byTop.entries()].filter(([k]) => k !== "(root)").sort((a, b) => b[1].length - a[1].length);
  const batches: string[][][] = [];
  for (const [, list] of groups) {
    const b = batches.find((x) => x.flat().length + list.length < 95);
    if (b) b.push(list);
    else batches.push([list]);
  }
  const rootFiles = byTop.get("(root)") ?? [];
  const last = batches.find((x) => x.flat().length + rootFiles.length < 95);
  if (last) last.push(rootFiles);
  else batches.push([rootFiles]);
  for (const old of fs.readdirSync(root).filter((f) => /^github-upload-.*\.zip$/.test(f))) fs.rmSync(path.join(root, old));
  let i = 0;
  for (const batch of batches) {
    i++;
    const zip = new JSZip();
    const list = batch.flat();
    for (const f of list) zip.file(`upload-${i}/${f}`, fs.readFileSync(path.join(root, f)));
    const name = `github-upload-${i}-of-${batches.length}.zip`;
    fs.writeFileSync(path.join(root, name), await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
    console.log(`${name}: ${list.length} files`);
  }
  console.log(`\nUnzip each file, open its upload-N folder, press Ctrl+A, drag everything onto GitHub → "Upload files", then Commit. Repeat for every zip.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
