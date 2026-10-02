/**
 * WHITE-LOTUS local launcher & tools. Runs everything on THIS computer:
 *
 *   npm run local                start WHITE-LOTUS (first run: short setup), open it in your browser
 *   npm run local -- dev         same, with hot reload (for development)
 *   npm run local -- setup       change AI / search settings
 *   npm run local -- where       show where your data and keys are stored
 *   npm run local -- backup <file.wlbackup>   encrypted backup (asks for a password)
 *   npm run local -- restore <file.wlbackup>  restore a backup (current data is kept as a copy)
 *   npm run local -- reset-password <email>   set a new password for a local account
 *   npm run local -- delete-all  permanently delete all local WHITE-LOTUS data and keys
 *   npm run local -- remote on|off|status    private access from your phone through Tailscale (scripts/local/remote.ts)
 *   npm run local -- autostart on|off        start automatically when you sign in to this computer
 *
 * The web app only listens on 127.0.0.1 (this computer), never on the network. Remote access goes through
 * Tailscale, which forwards your own devices' requests to that local port.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline/promises";
import { KeysMissingError, loadOrCreateKeys } from "../../lib/local/keys";
import { acquireDataLock, releaseDataLock } from "../../lib/local/lock";
import { migrateLocal } from "../../lib/local/migrate";
import { applyPending, assertBackupPassword, createBackup, readPending, stageRestore, writePending } from "../../lib/local/ops";
import { autostart, remote } from "./remote";
import { configDir, configPaths, dataDir, dataPaths, defaultRoot, ensureDataDirs, folderSize, looksCloudSynced, readJson, writeJsonPrivate } from "../../lib/local/paths";

const APP_ROOT = path.resolve(__dirname, "..", "..");
const SETTINGS = () => path.join(configDir(), "settings.env");
const tty = process.stdin.isTTY && process.stdout.isTTY;

const say = (s = "") => console.log(s);
const bold = (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
const green = (s: string) => (tty ? `\x1b[32m${s}\x1b[0m` : s);
const yellow = (s: string) => (tty ? `\x1b[33m${s}\x1b[0m` : s);
const red = (s: string) => (tty ? `\x1b[31m${s}\x1b[0m` : s);

// ───────────────────────── settings.env (your choices; no secrets required) ─────────────────────────

function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function writeSettings(values: Record<string, string>) {
  const lines = [
    "# WHITE-LOTUS settings for this computer. Edit in Notepad, then restart WHITE-LOTUS.",
    "# Your data folder and encryption keys are managed automatically (see: npm run local -- where).",
    "",
    ...Object.entries(values).map(([k, v]) => `${k}=${v}`),
    "",
  ];
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(SETTINGS(), lines.join("\n"), { mode: 0o600 });
}

const SETTINGS_TEMPLATE = `# WHITE-LOTUS settings for this computer. Remove the # in front of a line to use it, then restart WHITE-LOTUS.
# Fully private (nothing leaves this computer): install Ollama (ollama.com), run "ollama pull llama3.1", then:
# OLLAMA_BASE_URL=http://127.0.0.1:11434
# DEFAULT_MODEL=ollama:llama3.1
# LOCAL_OFFLINE_MODE=true
#
# Or a cloud AI (your messages are sent to it to generate answers; history stays here):
# CUSTOM_OPENAI_BASE_URL=https://api.groq.com/openai/v1
# CUSTOM_OPENAI_NAME=groq
# CUSTOM_OPENAI_API_KEY=gsk_...
# DEFAULT_MODEL=groq:openai/gpt-oss-120b
#
# Optional web research (search queries are sent to Tavily):
# TAVILY_API_KEY=tvly-...
# SEARCH_PROVIDERS=tavily
#
# NEXT_PUBLIC_CREATOR_NAME=Your Name
`;

const validModelName = (m: string) => /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(m);

/** Models installed in Ollama, or null if Ollama isn't reachable. Talks only to the address you gave (local). */
async function ollamaModels(base: string): Promise<string[] | null> {
  try {
    const r = await fetch(`${base.replace(/\/+$/, "").replace(/\/v1$/, "")}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const j = (await r.json()) as { models?: Array<{ name: string }> };
    return (j.models ?? []).map((m) => m.name);
  } catch {
    return null;
  }
}

/** On each start: say plainly if the configured AI can't work, so problems show up here and not as a chat error. */
async function checkAi(env: NodeJS.ProcessEnv) {
  const id = env.DEFAULT_MODEL ?? "";
  const i = id.indexOf(":");
  const provider = i > 0 ? id.slice(0, i) : "";
  const name = i > 0 ? id.slice(i + 1) : id;
  if (!id) return say(yellow("No AI model is set. Run: npm run local -- setup"));
  if (!validModelName(name)) return say(red(`DEFAULT_MODEL “${id}” isn't a valid model id. Run: npm run local -- setup`));
  if (provider === "ollama") {
    const base = env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
    const models = await ollamaModels(base);
    if (models === null) say(yellow(`Ollama isn't answering at ${base}. Open Ollama before chatting (or run "ollama serve").`));
    else if (!models.includes(name) && !models.includes(`${name}:latest`)) say(yellow(`Ollama doesn't have "${name}". Installed: ${models.join(", ") || "none"}. Run "ollama pull ${name}" or: npm run local -- setup`));
    else say(green(`AI: Ollama model "${name}" is ready (on this computer).`));
  }
}

async function ask(rl: readline.Interface, q: string, def = ""): Promise<string> {
  const a = (await rl.question(`${q}${def ? ` [${def}]` : ""}: `)).trim();
  return a || def;
}

async function setupWizard(force = false) {
  const existing = parseEnvFile(SETTINGS());
  if (!force && fs.existsSync(SETTINGS())) return;
  if (!tty) {
    fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(SETTINGS(), SETTINGS_TEMPLATE, { mode: 0o600 });
    say(yellow(`Created ${SETTINGS()} — open it in a text editor to choose your AI provider, then restart.`));
    return;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    say();
    say(bold("WHITE-LOTUS setup — everything is stored on this computer."));
    say();
    // 1. Data folder
    const current = dataDir();
    say(`Where should WHITE-LOTUS keep your conversations, files and history?`);
    let folder = await ask(rl, "Data folder", current);
    folder = path.resolve(folder);
    while (looksCloudSynced(folder)) {
      say(yellow("That folder syncs to a cloud service (OneDrive/Dropbox/Google Drive/iCloud). Pick a folder that stays on this computer."));
      folder = path.resolve(await ask(rl, "Data folder", defaultRoot().data));
    }
    const hasData = fs.existsSync(dataPaths(current).db) && fs.readdirSync(dataPaths(current).db).length > 0;
    if (folder !== current) {
      if (hasData) say(yellow("You already have data in the current folder — use Settings → Privacy & storage → Move data to change it safely."));
      else writeJsonPrivate(configPaths().location, { dataDir: folder });
    }

    // 2. AI
    say();
    say("Which AI should answer your questions?");
    say("  1) Ollama on this computer  — fully private, nothing leaves your PC (install from ollama.com first)");
    say("  2) Groq                      — free tier, cloud (your messages are sent to Groq)");
    say("  3) OpenAI   4) Anthropic   5) Google Gemini   — paid APIs, cloud");
    say("  6) Another OpenAI-compatible server (LM Studio, vLLM, …)");
    say("  7) Decide later");
    const choice = await ask(rl, "Choose 1-7", existing.DEFAULT_MODEL?.startsWith("ollama:") ? "1" : "1");
    const v: Record<string, string> = { ...existing };
    const model = async (hint: string, def = "") => {
      for (;;) {
        const m = await ask(rl, `Model id (${hint})`, def);
        if (validModelName(m)) return m;
        say(yellow(`“${m}” isn't a valid model id (letters, numbers and . _ : / - only).`));
      }
    };
    if (choice === "1") {
      v.OLLAMA_BASE_URL = await ask(rl, "Ollama address", existing.OLLAMA_BASE_URL || "http://127.0.0.1:11434");
      const installed = await ollamaModels(v.OLLAMA_BASE_URL);
      if (installed === null) say(yellow("Ollama isn't answering at that address. Install/open Ollama (ollama.com) — you can finish setup now and start Ollama later."));
      else if (!installed.length) say(yellow("Ollama is running but has no models yet. In a terminal run:  ollama pull llama3.1"));
      else say(`Installed Ollama models: ${installed.join(", ")}`);
      const def = existing.DEFAULT_MODEL?.startsWith("ollama:") ? existing.DEFAULT_MODEL.slice(7) : (installed?.[0] ?? "llama3.1");
      let name = await model("one of the installed models", def);
      while (!validModelName(name) || (installed?.length && !installed.includes(name) && !installed.includes(`${name}:latest`))) {
        say(yellow(validModelName(name) ? `“${name}” isn't installed in Ollama. Choose one of: ${installed!.join(", ")}` : `“${name}” isn't a valid model name.`));
        name = await model("one of the installed models", def);
      }
      v.DEFAULT_MODEL = `ollama:${name}`;
      const off = await ask(rl, "Offline mode — also switch off web search so NOTHING leaves this computer? (y/n)", "y");
      v.LOCAL_OFFLINE_MODE = off.toLowerCase().startsWith("y") ? "true" : "false";
    } else if (choice === "2") {
      v.CUSTOM_OPENAI_BASE_URL = "https://api.groq.com/openai/v1";
      v.CUSTOM_OPENAI_NAME = "groq";
      v.CUSTOM_OPENAI_API_KEY = await ask(rl, "Groq API key (console.groq.com → API Keys)", existing.CUSTOM_OPENAI_API_KEY);
      v.DEFAULT_MODEL = `groq:${await model("see console.groq.com → Models", "openai/gpt-oss-120b")}`;
      v.MAX_CONTEXT_TOKENS ??= "6000";
      v.MAX_OUTPUT_TOKENS ??= "1500";
      v.LOCAL_OFFLINE_MODE = "false";
    } else if (choice === "3") {
      v.OPENAI_API_KEY = await ask(rl, "OpenAI API key", existing.OPENAI_API_KEY);
      v.DEFAULT_MODEL = `openai:${await model("see platform.openai.com/docs/models")}`;
      v.LOCAL_OFFLINE_MODE = "false";
    } else if (choice === "4") {
      v.ANTHROPIC_API_KEY = await ask(rl, "Anthropic API key", existing.ANTHROPIC_API_KEY);
      v.DEFAULT_MODEL = `anthropic:${await model("see docs.claude.com → Models")}`;
      v.LOCAL_OFFLINE_MODE = "false";
    } else if (choice === "5") {
      v.GOOGLE_AI_API_KEY = await ask(rl, "Google AI Studio API key", existing.GOOGLE_AI_API_KEY);
      v.DEFAULT_MODEL = `google:${await model("see ai.google.dev → Models")}`;
      v.LOCAL_OFFLINE_MODE = "false";
    } else if (choice === "6") {
      v.CUSTOM_OPENAI_BASE_URL = await ask(rl, "Server URL ending in /v1", existing.CUSTOM_OPENAI_BASE_URL || "http://127.0.0.1:1234/v1");
      v.CUSTOM_OPENAI_NAME = "custom";
      v.CUSTOM_OPENAI_API_KEY = await ask(rl, "API key (Enter if none)", existing.CUSTOM_OPENAI_API_KEY);
      v.DEFAULT_MODEL = `custom:${await model("the model name the server uses")}`;
    }

    // 3. Web search (optional)
    if (v.LOCAL_OFFLINE_MODE !== "true") {
      say();
      say("Web research (optional): search queries are sent to the search provider; your history stays here.");
      const tavily = await ask(rl, "Tavily API key (tavily.com, free tier) — Enter to skip", existing.TAVILY_API_KEY);
      if (tavily) {
        v.TAVILY_API_KEY = tavily;
        v.SEARCH_PROVIDERS = "tavily";
      }
    }
    v.NEXT_PUBLIC_CREATOR_NAME = await ask(rl, "Name shown in the footer (\"Made by …\")", existing.NEXT_PUBLIC_CREATOR_NAME || "");
    writeSettings(v);
    say(green(`Saved ${SETTINGS()}`));
  } finally {
    rl.close();
  }
}

// ───────────────────────── keys, migrations, build ─────────────────────────

function databaseExists(root = dataDir()) {
  const db = dataPaths(root).db;
  return fs.existsSync(db) && fs.readdirSync(db).length > 0;
}

function prepareKeys() {
  const { keys, created, protection } = loadOrCreateKeys({ databaseExists: databaseExists() });
  if (created) say(green(`Created new encryption keys (${protection === "dpapi" ? "protected with your Windows account" : "owner-only file"}) in ${configDir()}`));
  return keys;
}

const BUILD_INPUTS = ["app", "components", "lib", "config", "drizzle", "public", "proxy.ts", "next.config.ts", "package.json", "package-lock.json", "tailwind.config.ts", "postcss.config.mjs", "tsconfig.json"];
function sourceHash(extra: string) {
  const h = createHash("sha256").update(extra);
  const walk = (p: string) => {
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) for (const e of fs.readdirSync(p).sort()) walk(path.join(p, e));
    else h.update(`${path.relative(APP_ROOT, p)}:${st.size}:${st.mtimeMs}`);
  };
  for (const i of BUILD_INPUTS) walk(path.join(APP_ROOT, i));
  return h.digest("hex");
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => {
    const c = spawn(cmd, args, { cwd: APP_ROOT, env, stdio: "inherit" });
    c.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(args[0] ?? cmd)} exited with ${code}`))));
  });
}

const nextBin = () => path.join(APP_ROOT, "node_modules", "next", "dist", "bin", "next");

async function ensureBuilt(env: NodeJS.ProcessEnv) {
  const marker = path.join(APP_ROOT, ".next", "white-lotus-build.txt");
  const hash = sourceHash(`${env.NEXT_PUBLIC_CREATOR_NAME ?? ""}|${env.NEXT_PUBLIC_CREATOR_ROLE ?? ""}`);
  if (fs.existsSync(path.join(APP_ROOT, ".next", "BUILD_ID")) && fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === hash) return;
  say(bold("Preparing WHITE-LOTUS for this computer (first run or after an update — a few minutes)…"));
  await run(process.execPath, [nextBin(), "build"], { ...env, NODE_ENV: "production" });
  fs.writeFileSync(marker, hash);
}

function freePort(start: number): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(freePort(start + 1)));
    s.listen(start, "127.0.0.1", () => s.close(() => resolve(start)));
  });
}

function openBrowser(url: string) {
  if (process.env.WHITE_LOTUS_NO_BROWSER === "1") return;
  const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true }).unref();
  } catch {
    /* the URL is printed anyway */
  }
}

async function waitHealthy(url: string, ms = 120_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${url}/api/health`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

function logStream() {
  const logs = dataPaths().logs;
  fs.mkdirSync(logs, { recursive: true });
  // Keep two weeks of logs (they never contain message content, passwords or keys).
  for (const f of fs.readdirSync(logs)) {
    const p = path.join(logs, f);
    if (Date.now() - fs.statSync(p).mtimeMs > 14 * 86_400_000) fs.rmSync(p, { force: true });
  }
  return fs.createWriteStream(path.join(logs, `white-lotus-${new Date().toISOString().slice(0, 10)}.log`), { flags: "a", mode: 0o600 });
}

// ───────────────────────── start / supervise ─────────────────────────

async function start(dev: boolean) {
  const pinned = Boolean(process.env.WHITE_LOTUS_DATA_DIR);
  process.env.NEXT_TELEMETRY_DISABLED = "1"; // Next.js would otherwise send anonymous usage telemetry
  await setupWizard();
  let firstStart = true;
  for (;;) {
    const pendingBefore = readPending();
    if (pendingBefore) say(bold(`Applying: ${pendingBefore.op}…`));
    const summary = await applyPending((s) => say(green(s)));
    if (summary) say(green(summary));

    ensureDataDirs();
    let keys;
    try {
      keys = prepareKeys();
    } catch (e) {
      if (e instanceof KeysMissingError) {
        say(red(e.message));
        process.exit(2);
      }
      throw e;
    }
    await migrateLocal({ appRoot: APP_ROOT });

    const settings = parseEnvFile(SETTINGS());
    const wantedPort = Number(process.env.PORT || settings.PORT || 3000);
    const publicUrl = (process.env.WHITE_LOTUS_PUBLIC_URL || settings.WHITE_LOTUS_PUBLIC_URL || "").trim().replace(/\/+$/, "");
    const port = await freePort(wantedPort);
    if (publicUrl && port !== wantedPort) {
      // Tailscale forwards to a fixed port; silently moving would break your phone's address.
      say(red(`Port ${wantedPort} is busy, so ${publicUrl} can't reach WHITE-LOTUS. Close the program using it, or run: npm run local -- remote on (after changing PORT in settings.env).`));
      process.exit(3);
    }
    const url = `http://127.0.0.1:${port}`;
    // Precedence: real environment variables > settings.env (so automation can override the file).
    const fromFile = Object.fromEntries(Object.entries(settings).filter(([k]) => process.env[k] === undefined));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...fromFile,
      ...keys,
      WHITE_LOTUS_DATA_DIR: dataDir(),
      WHITE_LOTUS_CONFIG_DIR: configDir(),
      WHITE_LOTUS_LAUNCHER: "1",
      // The data folder was fixed by an environment variable, so it can't be moved from the app.
      WHITE_LOTUS_DATA_PINNED: pinned ? "1" : "0",
      // With remote access, links (e-mails, verification) use the private Tailscale address. AUTH_URL is left unset
      // so sign-in works on both http://127.0.0.1 (this computer) and the Tailscale address (trustHost).
      APP_URL: publicUrl || url,
      ...(publicUrl ? { AUTH_URL: undefined } : { AUTH_URL: url }),
      NEXT_TELEMETRY_DISABLED: "1",
      NODE_ENV: dev ? "development" : "production",
    };
    if (!dev) await ensureBuilt(env);
    await checkAi(env);

    const out = logStream();
    const child: ChildProcess = spawn(process.execPath, [nextBin(), dev ? "dev" : "start", "-H", "127.0.0.1", "-p", String(port)], { cwd: APP_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (d) => (out.write(d), dev && process.stdout.write(d)));
    child.stderr?.on("data", (d) => (out.write(d), process.stderr.write(d)));
    const stop = () => child.kill();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    if (await waitHealthy(url)) {
      say();
      say(green(bold(`WHITE-LOTUS is running at ${url}`)));
      if (publicUrl) say(green(`From your phone and other devices (Tailscale): ${publicUrl}`));
      say(`Your data: ${dataDir()}`);
      say("Keep this window open while you use WHITE-LOTUS. Close it (or press Ctrl+C) to stop.");
      if (firstStart) openBrowser(url);
      firstStart = false;
    }
    const code: number | null = await new Promise((r) => child.on("exit", (c) => r(c)));
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    out.end();
    if (readPending()) {
      say(bold("Restarting WHITE-LOTUS…"));
      continue;
    }
    say(code === 0 || code === null ? "WHITE-LOTUS stopped." : red(`WHITE-LOTUS stopped (exit code ${code}). Logs: ${dataPaths().logs}`));
    process.exit(code ?? 0);
  }
}

// ───────────────────────── other commands ─────────────────────────

async function readSecret(prompt: string, envName = "WHITE_LOTUS_BACKUP_PASSWORD"): Promise<string> {
  if (process.env[envName]) return process.env[envName]!;
  if (!tty) throw new Error(`Set ${envName} or run this in a terminal.`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(prompt);
  rl.close();
  return a;
}

function where() {
  const d = dataPaths();
  const c = configPaths();
  say(bold("WHITE-LOTUS on this computer"));
  say(`  Data folder     ${d.root}  (${(folderSize(d.root) / 1024 / 1024).toFixed(1)} MB)`);
  say(`    database      ${d.db}`);
  say(`    files         ${d.files}`);
  say(`    backups       ${d.backups}`);
  say(`    logs          ${d.logs}`);
  say(`  Config & keys   ${c.root}`);
  say(`    keys          ${fs.existsSync(c.keysDpapi) ? `${c.keysDpapi} (Windows DPAPI)` : fs.existsSync(c.keysPlain) ? `${c.keysPlain} (owner-only file)` : "not created yet"}`);
  say(`    settings      ${SETTINGS()}`);
  const loc = readJson<{ dataDir?: string }>(c.location);
  if (loc?.dataDir) say(`  (data folder chosen by you in ${c.location})`);
}

async function backup(file?: string) {
  if (!file) throw new Error("Usage: npm run local -- backup <file.wlbackup>");
  const pw = await readSecret("Backup password (min 10 characters — you'll need it to restore): ");
  assertBackupPassword(pw);
  const { PGlite } = await import("@electric-sql/pglite");
  acquireDataLock();
  const pg = new PGlite(dataPaths().db);
  try {
    const buf = await createBackup(pg, pw);
    fs.writeFileSync(path.resolve(file), buf, { mode: 0o600 });
    say(green(`Encrypted backup written: ${path.resolve(file)} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`));
  } finally {
    await pg.close();
    releaseDataLock();
  }
}

async function restore(file?: string) {
  if (!file) throw new Error("Usage: npm run local -- restore <file.wlbackup>");
  const pw = await readSecret("Backup password: ");
  const staged = await stageRestore(fs.readFileSync(path.resolve(file)), pw);
  writePending({ op: "restore", stagingDir: staged.stagingDir, requestedAt: new Date().toISOString() });
  const summary = await applyPending((s) => say(green(s)));
  say(summary ?? "Nothing restored.");
}

async function resetPassword(email?: string) {
  if (!email) throw new Error("Usage: npm run local -- reset-password <email>");
  const keys = prepareKeys();
  Object.assign(process.env, keys);
  const pw = await readSecret("New password (10+ characters, letters and numbers): ", "WHITE_LOTUS_NEW_PASSWORD");
  const { hashPassword, passwordSchema } = await import("../../lib/security/hashing");
  passwordSchema.parse(pw);
  const { PGlite } = await import("@electric-sql/pglite");
  acquireDataLock();
  const pg = new PGlite(dataPaths().db);
  try {
    const hash = await hashPassword(pw);
    const r = await pg.query<{ id: string }>("update users set password_hash = $1, session_version = session_version + 1 where lower(email) = lower($2) and not is_guest returning id", [hash, email]);
    if (!r.rows.length) throw new Error(`No account with email ${email}`);
    await pg.query("update user_sessions set revoked_at = now(), revoked_reason = 'password_reset' where user_id = $1 and revoked_at is null", [r.rows[0].id]);
    say(green(`Password updated for ${email}. All of its sessions were signed out.`));
  } finally {
    await pg.close();
    releaseDataLock();
  }
}

async function deleteAll() {
  if (!tty) throw new Error("Run this in a terminal (it asks for confirmation).");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(red(`This permanently deletes ALL WHITE-LOTUS data in ${dataDir()} and its keys. Type DELETE to confirm: `));
  rl.close();
  if (a !== "DELETE") return say("Cancelled.");
  acquireDataLock(); // refuses while the app is running
  releaseDataLock();
  writePending({ op: "wipe", requestedAt: new Date().toISOString() });
  say(green((await applyPending()) ?? "Done."));
}

async function main() {
  const [cmd = "start", arg] = process.argv.slice(2);
  switch (cmd) {
    case "start":
      return start(false);
    case "dev":
      return start(true);
    case "setup":
      return setupWizard(true);
    case "where":
      return where();
    case "migrate":
      prepareKeys();
      await migrateLocal({ appRoot: APP_ROOT });
      return say(green("Database up to date."));
    case "backup":
      return backup(arg);
    case "restore":
      return restore(arg);
    case "reset-password":
      return resetPassword(arg);
    case "delete-all":
      return deleteAll();
    case "remote":
      return remote(arg, { settingsFile: SETTINGS(), port: Number(process.env.PORT || parseEnvFile(SETTINGS()).PORT || 3000), say });
    case "autostart":
      return autostart(arg, { appRoot: APP_ROOT, say });
    default:
      say("Commands: start | dev | setup | where | migrate | backup <file> | restore <file> | reset-password <email> | delete-all | remote on|off|status | autostart on|off");
  }
}

main().catch((e) => {
  console.error(red(e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
