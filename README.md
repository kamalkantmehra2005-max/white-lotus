# WHITE-LOTUS

**Your private AI workspace, local-first.** WHITE-LOTUS runs on your own PC or laptop. Everything it keeps — conversations, files, search history, settings, memories and search indexes — is stored **only in a folder on your computer**, encrypted. There is no cloud database and no cloud storage.

```
User → WHITE-LOTUS (runs on this computer, http://127.0.0.1:3000) → your local data folder
                         └── only if you choose a cloud AI / web search: the question is sent to get an answer
```

- **Features:** chat with streaming answers, web research with citations, document analysis, coding help, and projects to organise work.
- **Local AI:** with Ollama, LM Studio or vLLM, nothing leaves your computer. Offline mode enforces this.
- **Cloud AI:** you can use Groq, OpenAI, Anthropic or Gemini instead. WHITE-LOTUS then tells you exactly what it sends; your history and files still stay only on your PC.

### Two editions

| | **Online edition** — a website, no PC needs to stay on | **Local edition** — runs on your own PC |
|---|---|---|
| Where chats live | In each device's browser. **With account:** kept, with end-to-end encrypted sync between your devices. **Without account:** this tab only, erased on close | A folder on your PC |
| Set up | Free GitHub + Neon + Vercel accounts: **[docs/ONLINE.md](docs/ONLINE.md)** | `WHITE-LOTUS.cmd` (below) |

---

## Quick start (Windows)

1. Install **Node.js LTS** once from <https://nodejs.org> (the standard Windows installer).
2. Unzip WHITE-LOTUS to an ordinary folder, e.g. `C:\Users\you\WHITE-LOTUS-app`. Don't use a OneDrive folder.
3. Double-click **`WHITE-LOTUS.cmd`**.
   - **First run only:** it installs its components and prepares the app (a few minutes), then asks where to keep your data and which AI to use.
   - It then creates your encryption keys, starts WHITE-LOTUS at `http://127.0.0.1:3000` and opens your browser.
4. Create your account. It is stored only on this computer, and this first account becomes the owner (admin).

Keep the WHITE-LOTUS window open while you use it, and close it to stop. Next time, double-click `WHITE-LOTUS.cmd` again.

On **macOS / Linux**, run `./white-lotus.sh`. The full guide is **[INSTALL.md](INSTALL.md)**.

### Do I need to set everything up again on another computer?

WHITE-LOTUS is local-first, so each computer has its own WHITE-LOTUS and its own data folder.

- **Same computer:** nothing to redo. Your data stays in the data folder and is there every time you start, including after restarts and updates.
- **A new computer:** install WHITE-LOTUS there, then **restore an encrypted backup** (Settings → Privacy & storage → Backup & restore). Your conversations, files, search history, settings and keys come with it.
- **Your phone, from anywhere:** run `npm run local -- remote on` once. Your phone then reaches WHITE-LOTUS on your computer through **Tailscale**, a free private network of your own devices; nothing is exposed to the internet. Install it on the phone with **Add to Home screen**. The full guide is **[docs/MOBILE-AND-REMOTE.md](docs/MOBILE-AND-REMOTE.md)**.

---

## Where your data lives

The paths below are the Windows defaults.

| What | Where | Format |
|---|---|---|
| Conversations, messages, search history, settings, memories, projects, file metadata, search indexes | `%LOCALAPPDATA%\WHITE-LOTUS\data\db\` | Embedded PostgreSQL (**PGlite**). Sensitive fields are encrypted with AES-256-GCM |
| Uploaded files, and AI answers you save as files | `…\data\files\u\` (files awaiting a scan: `…\files\q\`) | One encrypted file each (AES-256-GCM) |
| Encrypted backups | `…\data\backups\*.wlbackup` | scrypt + AES-256-GCM |
| Readable exports | Downloaded ZIP or JSON | Markdown, JSON and your original files |
| Logs (never message content, passwords or keys) | `…\data\logs\` | Text, kept 14 days |
| Encryption keys | `%LOCALAPPDATA%\WHITE-LOTUS\config\keys.dpapi` | Protected by Windows DPAPI (tied to your Windows account). Kept **apart** from the data |
| Your settings (AI choice, plus cloud API keys if you use any) | `…\config\settings.env` | Text |

On macOS the defaults are under `~/Library/Application Support/WHITE-LOTUS/`. On Linux they are `~/.local/share/white-lotus` (data) and `~/.config/white-lotus` (config).

You can **choose another folder**, e.g. `D:\WHITE-LOTUS-data`, during setup or later in **Settings → Privacy & storage → Move data**. WHITE-LOTUS refuses folders that sync to OneDrive, Dropbox, Google Drive or iCloud.

The full architecture is in **[docs/LOCAL-FIRST.md](docs/LOCAL-FIRST.md)**.

## What leaves your computer?

Nothing is **stored** anywhere else. Data is only **sent**, at the moment you use a feature, if you have set up one of these:

| Feature | Sent | Not sent |
|---|---|---|
| A **cloud AI** (Groq, OpenAI, Anthropic, Gemini…) | Your new message, recent messages from that conversation, relevant excerpts of files used in it, memories and project instructions that apply, and web results used | Other conversations, whole files, your data folder, keys, password |
| **Web search** (Tavily or Brave) | Short search queries | Conversation, files |
| Reading a web page | An ordinary request to that website | Conversation, files |
| Weather | The place name, sent to Open-Meteo | Conversation, files |
| Optional: Google sign-in, emailed password resets, a remote malware scanner | Only if you set them up | — |

To see exactly what applies to you:

- **Settings → Privacy & storage** lists every flow for your current configuration.
- A line under the chat box states where each message goes.
- With **Ollama** and `LOCAL_OFFLINE_MODE=true`, that list is empty and nothing leaves the computer. Next.js telemetry is also switched off.

**One-time exception:** installing downloads the software itself, Node.js from nodejs.org and packages from npm. None of your data is involved.

## Features

| Area | What you get |
|---|---|
| **Chat** | Streaming, Stop, Regenerate, Edit & resend, Copy, **Save answer as file**. Markdown with tables and code. Light and dark themes |
| **Modes** | Quick · Think · Research (web + citations) · Code · Creative · Analyze |
| **Models** | Local: Ollama, LM Studio, vLLM. Cloud: OpenAI, Anthropic, Gemini, Groq, OpenRouter. Automatic fallback to a second model |
| **Research** | Plans queries, searches, reads pages and answers with `[n]` citations. Every search is saved in the **local search history** |
| **Files** | PDF, DOCX, PPTX, XLSX, CSV, JSON, Markdown, code, images. Stored encrypted in your data folder, indexed locally, and optionally scanned by a local ClamAV |
| **Search & retrieval** | A local keyword index over encrypted text (a "blind index") for conversations and documents. No separate embedding service needed |
| **Memory & projects** | Memory saves only what you ask it to. Projects group chats, files and instructions |
| **Your data** | Encrypted backup and restore, moving the data folder, readable export (ZIP or JSON), clearing search history, deleting everything |
| **Security** | AES-256-GCM at rest, keys kept separate from data (DPAPI on Windows), Argon2id passwords, server-side sessions, strict content security policy, and the app listens only on 127.0.0.1. See [SECURITY.md](SECURITY.md) |

## Architecture (code)

```
Browser ──http://127.0.0.1──▶ Next.js app (this computer) ──▶ lib/database (PGlite, embedded)  → data/db
                                   │                        └▶ lib/files/storage (encrypted)     → data/files
   scripts/local/cli.ts (launcher) ┘  keys (lib/local/keys) → config/     housekeeping every 6 h (instrumentation.ts)
```

| Code | Purpose |
|---|---|
| `lib/local/paths.ts` | Folder layout and defaults; detects cloud-synced folders |
| `lib/local/keys.ts` | Creates and stores keys (DPAPI, or a file only your account can read); never replaces the keys of existing data |
| `lib/local/ops.ts` | Encrypted backup, restore, move, delete-all |
| `lib/local/lock.ts` | Lets only one process open the data at a time |
| `lib/local/privacy.ts` | Works out what can leave the computer |
| `lib/local/search-history.ts`, `lib/local/export.ts` | Search history; readable export |
| `lib/database/client.ts` | PGlite (PostgreSQL compiled to WebAssembly) at `data/db` |
| `lib/files/storage.ts` | Encrypted local file store |
| `scripts/local/cli.ts` | The launcher: setup, keys, migrations, build, start on 127.0.0.1, restarts when needed, and the backup / restore / reset-password / delete-all commands |
| `WHITE-LOTUS.cmd`, `white-lotus.sh`, `reset-password.cmd` | Double-click launchers |

## Commands

```bash
npm run local                               # start (same as WHITE-LOTUS.cmd)
npm run local -- setup                      # change AI / search choices
npm run local -- where                      # show data, key and settings locations
npm run local -- backup D:\wl.wlbackup      # encrypted backup (asks for a password)
npm run local -- restore D:\wl.wlbackup     # restore (current data kept as a copy)
npm run local -- reset-password you@x.com   # forgotten password (close the app first)
npm run local -- delete-all                 # delete all local data and keys
npm run local -- remote on|off|status       # private access from your phone (Tailscale)
npm run local -- autostart on|off           # start WHITE-LOTUS when you sign in to this computer
npm run local -- dev                        # development with hot reload
```

## Testing

```bash
npm run typecheck && npm run lint
npm test                        # unit tests
npm run test:integration        # embedded database: isolation, encryption on disk, backups, export, keys, guests
node scripts/mock-ai-server.mjs &   # fake AI + search on 127.0.0.1:4010 for the tests below
npm run local                   # with settings.env pointing at the mock (see .github/workflows/ci.yml)
npx playwright test             # UI tests
./scripts/smoke-security.sh http://127.0.0.1:3000 --full
NODE_OPTIONS="--require ./scripts/dev/egress-guard.cjs" npm run local   # logs and blocks any non-local connection
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| "WHITE-LOTUS data is already open in another process" | It's already running, so close the other window. If it crashed, just start again: a stale lock is cleared automatically |
| "keys are missing" | Put `keys.dpapi` or `keys.json` back in the config folder, or restore a `.wlbackup`. New keys are never created over existing data |
| Forgot your password | Close WHITE-LOTUS, then run `reset-password.cmd` |
| No answers with Ollama | Check Ollama is running (`ollama list`) and that `DEFAULT_MODEL=ollama:<name>` matches a model you have pulled |
| Port 3000 is busy | The launcher picks the next free port and prints the address |

## License

MIT. The WHITE-LOTUS mark in `components/brand/logo.tsx` is an original design.
