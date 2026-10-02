# WHITE-LOTUS on your phone and from anywhere

**In short:** WHITE-LOTUS runs on **your computer**, and your data stays there. Your phone reaches it through **Tailscale**, a free private network that links only your own devices. You install it on the phone as an **app** from the browser (a PWA). No hosting, no database service, no domain name and nothing to pay.

```
 Phone (WHITE-LOTUS app / browser) ─┐
 Laptop at work (browser)  ─────────┼── Tailscale (private, encrypted, your devices only) ──▶ your PC
 Tablet (browser) ──────────────────┘                                                         │
                                                         tailscale serve → http://127.0.0.1:3000 (WHITE-LOTUS)
                                                                                              └─ data folder (encrypted)
```

## Can it be done with only a phone?

| Task | From a phone? | How |
|---|---|---|
| Use WHITE-LOTUS (chat, files, research) | **Yes** | The installed app, or any browser |
| Admin: users, models, limits, backups, export, delete all | **Yes** | Admin / Creator page |
| Download a backup to the phone | **Yes** | Settings → Privacy & storage → Create backup |
| **First install** (Node.js, unzip, first start, owner account) | **No.** Needs the computer once, about 20 minutes | Below. Afterwards you can do PC tasks from the phone with Chrome Remote Desktop |
| Change the AI model or settings.env, update the app | Through the computer | In person, or with Chrome Remote Desktop from the phone (free) |

The server can't run on the phone. Your data has to live on a computer that you own. It also needs Node.js and enough memory for a local AI. Android's Termux can run Node, but Android stops background apps, so it isn't reliable and it isn't supported.

## One-time setup on the computer (Windows)

1. Install **Node.js LTS**: <https://nodejs.org>.
2. Unzip WHITE-LOTUS to a normal folder, e.g. `C:\Users\you\WHITE-LOTUS-app`. Don't use OneDrive.
3. *(For a fully local, free AI)* Install **Ollama** from <https://ollama.com>, then in Command Prompt:
   ```
   ollama pull llama3.1
   ```
4. Double-click **`WHITE-LOTUS.cmd`**. Answer the questions, and choose `ollama` with the model `llama3.1`.
5. In the browser that opens (`http://127.0.0.1:3000`), **create your account**. The first account is the **owner/admin**. For safety, this account can only be created on the computer itself.
6. Install **Tailscale** from <https://tailscale.com/download> and sign in. Use Google or Microsoft, with the same account you'll use on the phone.
7. In the Tailscale admin console (<https://login.tailscale.com/admin/dns>), turn on **MagicDNS** and **HTTPS Certificates**.
8. Close the WHITE-LOTUS window. Then open Command Prompt **in the WHITE-LOTUS folder** and run:
   ```
   npm run local -- remote on
   npm run local -- autostart on
   ```
   - The first command prints your private address, e.g. `https://my-pc.tail1234.ts.net`.
   - The second makes WHITE-LOTUS start every time you sign in to Windows.
9. Start WHITE-LOTUS again (double-click `WHITE-LOTUS.cmd`).
10. Keep the PC reachable:
    - Windows Settings → System → Power → **Sleep: Never** (when plugged in).
    - Optional: install **Chrome Remote Desktop** (<https://remotedesktop.google.com/access>) so you can do PC tasks from your phone later.

macOS / Linux: the same steps, but use `./white-lotus.sh` and run the commands in Terminal.

## Phone setup

1. Install the **Tailscale** app (Play Store / App Store) and sign in with the **same** account. Switch it on.
2. **Android (Chrome):** open your address (`https://my-pc.…ts.net`) and sign in. Then tap ⋮ → **Install app** (or **Add to Home screen**). WHITE-LOTUS appears in your app drawer like a normal app.
3. **iPhone/iPad (Safari):** open the address and sign in. Then tap Share → **Add to Home Screen**.

The browser version and the app are the same program using the same data, so a chat started on the PC shows up on the phone.

## Why this design (and not Vercel, a cloud database or a native app)

- **Data stays on your computer:** the server is your PC and the database is a folder on it. Nothing is stored on anyone else's server.
- **Not exposed to the internet:**
  - WHITE-LOTUS still listens only on `127.0.0.1`.
  - Tailscale's `serve` forwards requests that arrive over your tailnet to it, and only devices signed in to your Tailscale account can connect.
  - There's no port forwarding, no public IP and no open router port.
- **One codebase for web and mobile:** a PWA is the same web app, installable on Android and iOS, with nothing extra to build.
  - Capacitor, React Native or Flutter would only wrap a web view pointing at the same address.
  - They would add Android Studio/Xcode builds and, for stores, paid developer accounts.
- **Private HTTPS for free:** Tailscale issues a real certificate for the `ts.net` name, so the app can be installed and no domain is needed.

## What can cost money — honest list

| Item | Today | Could change? | Free fallback |
|---|---|---|---|
| WHITE-LOTUS, Node.js, PGlite, Ollama, local models | Free, open source | No (you keep your copy) | — |
| Tailscale Personal plan | Free (personal use, up to a set number of users and devices) | Yes, a company decides | Self-host **Headscale** (open source), or a plain **WireGuard** VPN on your router |
| Cloud AI (Groq, OpenAI, Gemini…) | Optional; free tiers vary | Yes | Ollama (local, free) |
| Web search (Tavily or Brave) | Optional; free tiers vary | Yes | Self-hosted **SearXNG**, or switch web search off |
| Chrome Remote Desktop | Free | Yes | RustDesk (open source) |
| Google Play / Apple App Store listing | Not needed (PWA) | — | Play: one-time fee; Apple: yearly fee, only if you ever want store listings |
| Electricity and internet for an always-on PC | Your normal bills | — | — |

Nothing here is promised "free forever". The design just has **no mandatory recurring fee**, and every third-party piece has a free self-hosted replacement.

## Where the data is

| What | Where (Windows) |
|---|---|
| Database (chats, settings, users, search history) | `%LOCALAPPDATA%\WHITE-LOTUS\data\db\` (PGlite, sensitive fields AES-256-GCM encrypted) |
| Your files | `…\data\files\` (each file encrypted) |
| Backups made in the app | `…\data\backups\*.wlbackup`, and downloaded to the device you clicked from |
| Keys | `%LOCALAPPDATA%\WHITE-LOTUS\config\keys.dpapi` (Windows DPAPI, kept apart from the data) |
| Settings, incl. remote address | `…\config\settings.env` (`WHITE_LOTUS_PUBLIC_URL=…`) |
| Phone | Nothing except Tailscale and the browser's sign-in cookie. The service worker caches only icons, app code and an offline page — **never your chats or files** |

`npm run local -- where` prints the exact paths.

## Backup and restore

- **From the phone or the PC:**
  - Admin / Creator → **Open Privacy & storage** → **Create backup**. Pick a strong password; it can't be recovered.
  - The `.wlbackup` file downloads to the device you're using. Keep one copy off the PC (phone storage, a USB drive or an external disk).
- **From the PC command line:**
  ```
  npm run local -- backup D:\wl-2026-10.wlbackup
  ```
- **Restore:**
  - In the app: Privacy & storage → **Restore from a backup…**
  - Or on the PC: `npm run local -- restore D:\wl-2026-10.wlbackup`. Your current data is kept as a copy.
- **Readable export:** Settings → Data → **Download ZIP** gives you Markdown, JSON and your files.

## Admin / Creator

- **Opening it:** sign in as the owner, then open the sidebar → **Admin / Creator**. Ordinary users get no link, and both the page and every admin API refuse them.
- **The page shows:**
  - The creator card: *Created by Kamal Kant — Legal Secretary at Remfry & Sagar*. Change it with `NEXT_PUBLIC_CREATOR_NAME` / `NEXT_PUBLIC_CREATOR_ROLE` in settings.env.
  - Remote-access status.
  - Data & backups.
  - Users: add, make admin, block.
  - Models, usage limits, health and errors.
- **Adding people:** public sign-up stays closed; add people yourself on this page. They share your PC's data folder, but each person sees only their own chats and files.
- **Forgot the owner password:** on the PC, close WHITE-LOTUS and run `reset-password.cmd`.
- **No passwords or API keys in the source code:**
  - Encryption keys are generated on first run and protected by DPAPI.
  - Cloud API keys, if you use any, live only in `settings.env` on your PC.

## Security checklist

- [ ] Use a strong owner password (12+ characters).
- [ ] Turn on 2-step sign-in on the Google/Microsoft account you use for Tailscale. That account is now the key to your network.
- [ ] Use a strong Windows password and turn on **BitLocker** (FileVault on Mac).
- [ ] In Tailscale, review **Machines** regularly. Remove phones you no longer use, and turn on device approval if offered.
- [ ] **Never** run `tailscale funnel`; it publishes the app to the whole internet.
- [ ] Keep a recent `.wlbackup` off the PC.
- [ ] Keep Windows, Node.js, Tailscale and Ollama updated.
- [ ] Use Ollama with `LOCAL_OFFLINE_MODE=true` for confidential client matters, so nothing leaves the PC.

**Risks of remote access:**

- Anyone holding your unlocked phone, or controlling your Tailscale login, can reach the app. Lock your phone, and the app still asks for your WHITE-LOTUS password.
- A compromised device on your tailnet could try to guess passwords. Sign-in is rate-limited and passwords are Argon2id-hashed, but use a strong one.
- Malware on the PC itself can read what you can read, whatever WHITE-LOTUS does.
- If the PC is off or asleep, the phone shows *"Can't reach WHITE-LOTUS"*. That is the cost of keeping data at home.

### If you ever want a public link (not recommended for client data)

**Cloudflare Tunnel** (free) can give a public `https://` address without opening ports. But Cloudflare then terminates TLS and could see your traffic, and the login page becomes reachable by anyone. If you do this:

- Put **Cloudflare Access** (free tier) in front, so only your e-mail can reach the page.
- Set `WHITE_LOTUS_PUBLIC_URL` to that address.

The owner account can still only be created on the PC.

## Updating later

1. Download the new WHITE-LOTUS zip and unzip it **over** the app folder. Your data and keys are elsewhere, so they aren't touched.
2. Close WHITE-LOTUS, and before a big update create a backup.
3. Start `WHITE-LOTUS.cmd`. It rebuilds and applies database updates automatically.
4. Installed phone apps pick up the new version on next launch.

You can do all of this from the phone through Chrome Remote Desktop.

## Commands

```
npm run local -- remote on       private access from your devices (Tailscale)
npm run local -- remote status   show your address
npm run local -- remote off      this computer only
npm run local -- autostart on    start at sign-in (off: autostart off)
npm run local -- where           where everything is stored
```
