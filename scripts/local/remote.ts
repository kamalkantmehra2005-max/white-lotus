/**
 * Remote access and auto-start for the local launcher.
 *
 *   npm run local -- remote on       share WHITE-LOTUS privately with YOUR devices through Tailscale (HTTPS)
 *   npm run local -- remote off      stop sharing
 *   npm run local -- remote status   show the address your phone uses
 *   npm run local -- autostart on    start WHITE-LOTUS automatically when you sign in to this computer
 *   npm run local -- autostart off
 *
 * The app itself keeps listening on 127.0.0.1 only. Tailscale's "serve" forwards requests that arrive over your
 * private, end-to-end encrypted tailnet to that local port. Nothing is opened on your router and the computer is
 * not reachable from the public internet.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Say = (s?: string) => void;

export function setSetting(file: string, key: string, value: string | null) {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/) : [];
  const re = new RegExp(`^\\s*#?\\s*${key}\\s*=`);
  const i = lines.findIndex((l) => re.test(l));
  const line = value === null ? `# ${key}=` : `${key}=${value}`;
  if (i >= 0) lines[i] = line;
  else lines.push(line);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, lines.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
}

function tailscaleBin(): string | null {
  const candidates =
    process.platform === "win32"
      ? ["tailscale", "C:\\Program Files\\Tailscale\\tailscale.exe"]
      : process.platform === "darwin"
        ? ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]
        : ["tailscale"];
  for (const c of candidates) {
    const r = spawnSync(c, ["version"], { encoding: "utf8", windowsHide: true });
    if (r.status === 0) return c;
  }
  return null;
}

/** The HTTPS name of this computer on your tailnet, e.g. https://my-pc.tail1234.ts.net */
function tailnetUrl(bin: string): string | null {
  const r = spawnSync(bin, ["status", "--json"], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return null;
  try {
    const dns = String(JSON.parse(r.stdout)?.Self?.DNSName ?? "").replace(/\.$/, "");
    return dns ? `https://${dns}` : null;
  } catch {
    return null;
  }
}

const INSTALL_HINT = [
  "Tailscale isn't installed (or isn't signed in) on this computer.",
  "  1. Install it (free Personal plan): https://tailscale.com/download",
  "  2. Sign in with the same account you will use on your phone.",
  "  3. In the Tailscale admin console → DNS, turn on MagicDNS and HTTPS Certificates.",
  "  4. Run again:  npm run local -- remote on",
];

export function remote(sub: string | undefined, opts: { settingsFile: string; port: number; say: Say }) {
  const { say, settingsFile, port } = opts;
  const bin = tailscaleBin();
  if (sub === "off") {
    if (bin) spawnSync(bin, ["serve", "--https=443", "off"], { stdio: "inherit", windowsHide: true });
    setSetting(settingsFile, "WHITE_LOTUS_PUBLIC_URL", null);
    say("Remote access is off. WHITE-LOTUS is reachable only from this computer. Restart WHITE-LOTUS to apply.");
    return;
  }
  if (!bin) return INSTALL_HINT.forEach((l) => say(l));
  const url = tailnetUrl(bin);
  if (!url) return INSTALL_HINT.forEach((l) => say(l));
  if (sub === "status" || sub === undefined) {
    const r = spawnSync(bin, ["serve", "status"], { encoding: "utf8", windowsHide: true });
    say(`This computer on your tailnet: ${url}`);
    say(r.stdout?.trim() || "Tailscale serve is not active. Run: npm run local -- remote on");
    return;
  }
  if (sub !== "on") return say("Usage: npm run local -- remote on | off | status");
  // --bg keeps serving after this command exits and across reboots. Only devices signed in to YOUR tailnet can connect.
  const r = spawnSync(bin, ["serve", "--bg", "--https=443", `http://127.0.0.1:${port}`], { stdio: "inherit", windowsHide: true });
  if (r.status !== 0) {
    say("Tailscale couldn't start serving. Check that HTTPS Certificates are enabled in the Tailscale admin console (DNS page), then try again.");
    return;
  }
  setSetting(settingsFile, "WHITE_LOTUS_PUBLIC_URL", url);
  setSetting(settingsFile, "PORT", String(port));
  say("");
  say(`Remote access is on: ${url}`);
  say("Open that address on your phone (Tailscale app signed in), sign in, then 'Add to Home screen'.");
  say("Do NOT use 'tailscale funnel' — that would publish WHITE-LOTUS to the whole internet.");
  say("Restart WHITE-LOTUS to apply.");
}

// ───────────────────────── auto-start at sign-in ─────────────────────────

export function autostart(sub: string | undefined, opts: { appRoot: string; say: Say }) {
  const { appRoot, say } = opts;
  const home = os.homedir();
  let file: string;
  let content: string;
  if (process.platform === "win32") {
    file = path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "WHITE-LOTUS.cmd");
    content = `@echo off\r\nset WHITE_LOTUS_NO_BROWSER=1\r\nstart "WHITE-LOTUS" /min cmd /c "cd /d "${appRoot}" && npm run local"\r\n`;
  } else if (process.platform === "darwin") {
    file = path.join(home, "Library", "LaunchAgents", "com.whitelotus.local.plist");
    content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.whitelotus.local</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>-lc</string><string>cd "${appRoot}" &amp;&amp; WHITE_LOTUS_NO_BROWSER=1 npm run local</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
`;
  } else {
    file = path.join(home, ".config", "autostart", "white-lotus.desktop");
    content = `[Desktop Entry]\nType=Application\nName=WHITE-LOTUS\nExec=sh -c 'cd "${appRoot}" && WHITE_LOTUS_NO_BROWSER=1 npm run local'\nX-GNOME-Autostart-enabled=true\n`;
  }
  if (sub === "off") {
    fs.rmSync(file, { force: true });
    return say("Auto-start removed.");
  }
  if (sub !== "on") return say(fs.existsSync(file) ? `Auto-start is on (${file}).` : "Auto-start is off. Turn on: npm run local -- autostart on");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  say(`Auto-start is on. WHITE-LOTUS will start (minimised) each time you sign in to this computer.\n  ${file}`);
  if (process.platform === "win32") say("Tip: in Windows Settings → System → Power, set 'When plugged in, put my device to sleep' to Never, so your phone can reach it.");
}
