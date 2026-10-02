# WHITE-LOTUS local-first architecture

**Goal:** WHITE-LOTUS behaves like a personal assistant whose memory and files belong to the user and live on the user's own computer.

```
Before (hosted):  Browser → hosted app (Vercel) → Neon Postgres (cloud) + Cloudflare R2 (cloud) + cron (cloud)
Now (local):      Browser → WHITE-LOTUS on 127.0.0.1 (this computer) → local data folder (PGlite + encrypted files)
                                         └─ processing only, never storage: a cloud AI / search API, if you choose one
```

## 1. Folder structure

```
<config folder>                      Windows: %LOCALAPPDATA%\WHITE-LOTUS\config
  keys.dpapi | keys.json             encryption & session keys (DPAPI-protected on Windows when available)
  location.json                      the data folder you chose
  settings.env                       your AI / search / privacy choices
  pending.json                       an operation for the launcher (move / restore / delete-all), transient
  staging\                           a decrypted backup being restored, transient

<data folder>                        Windows default: %LOCALAPPDATA%\WHITE-LOTUS\data (choose any local folder)
  white-lotus-data.json              marker: format version, creation date
  db\                                PGlite database (everything structured)
  files\q\<user>\…                   uploads waiting for the malware scan (quarantine)
  files\u\<user>\…                   your files + AI answers saved as files (encrypted)
  backups\*.wlbackup                 encrypted backups created in the app
  exports\                           reserved for exports
  logs\white-lotus-YYYY-MM-DD.log    redacted server logs (14 days)
  tmp\                               scratch
  .white-lotus.lock                  which process has the database open
```

- **Why `%LOCALAPPDATA%`:** it isn't synced by OneDrive and isn't part of roaming profiles.
- **Why keys live apart from the data:** a copied data folder can't be decrypted without the config folder.
- **Cloud-synced folders are refused** (OneDrive, Dropbox, Google Drive, iCloud, Box, pCloud, MEGA, Nextcloud) when you choose or move the data folder. See `looksCloudSynced`.

## 2. Local database: PGlite

- **What it is:** [PGlite](https://pglite.dev) is PostgreSQL compiled to WebAssembly. It runs *inside* the WHITE-LOTUS process and stores its files in `data/db`.
- **No server:** no database service, no network port and nothing to install.
- **Why PGlite instead of SQLite:** the existing schema, SQL migrations (`drizzle/`), array/GIN indexes and transactions work unchanged. Every existing query — authorization checks included — keeps its exact semantics.
- **One process at a time:** PGlite allows a single process, so `lib/local/lock.ts` enforces that. The command-line tools refuse to run while the app is open.
- **Migrations:** the launcher runs `drizzle/*.sql` before each start (`lib/local/migrate.ts`).
- **Tests:** they use the same engine in memory (`WHITE_LOTUS_DB=memory`).

**Tables:** users, sessions, conversations, messages, **search_history**, attachments (with `origin`: upload | generated), documents, document_chunks, projects, memories, user_settings, usage_records, rate limits, tool audit and error logs.

## 3. Local file storage

- **Where:** `lib/files/storage.ts` is the only storage backend. The S3/R2 driver and presigned URLs were removed.
- **Encryption:** every file is encrypted before it is written, with AES-256-GCM, a fresh IV and the storage key as AAD. The format is `WLF1 | keyId | iv | tag | ciphertext`.
- **Upload pipeline:** validate (size, type, magic bytes) → quarantine `files/q` → scan (local ClamAV if configured) → release to `files/u` → extract text → chunk → encrypt → index.
- **Downloads:** short-lived signed links, which are checked against the signed-in owner and streamed as attachments.
- **AI-generated files:** "Save as file" on any answer creates an encrypted Markdown file in Files (`origin = generated`). It is searchable in later chats like any upload.

## 4. Local search and indexing

- **Blind index:** conversations and documents are searched through keyword tokens. Each token is `HMAC-SHA256(BLIND_INDEX_KEY, normalised word)`, stored in `text[]` columns with GIN indexes. Retrieval ranks by token overlap. All of this happens on this computer.
- **Titles:** conversation titles are decrypted in memory and filtered there.
- **Embeddings:** none are needed. A local embedding model (e.g. via Ollama) would be an optional upgrade; nothing is sent to an embedding API.

## 5. Conversation history

- **Where:** conversations and messages are in the local database. Content and metadata (sources, activity, search queries) are AES-GCM encrypted and bound to the conversation (AAD).
- **Search history:** every web search run for you is recorded in `search_history`, with the query encrypted. You can view it, delete single entries or clear all of it in Settings → Privacy & storage.
- **Survives restarts:** PGlite writes to disk, and the app closes the database cleanly on shutdown.

## 6. Import / export / backup

| Action | How | Result |
|---|---|---|
| Readable export | Settings → Data → **Download ZIP** / **JSON** | `export.json` + one Markdown file per conversation + your files, decrypted, plus search history |
| Encrypted backup | Settings → Privacy & storage → **Create backup**, or `npm run local -- backup <file>` | `.wlbackup`: `WLBK1` header, then AES-256-GCM over a ZIP of the PGlite dump (`db.tar.gz`), all files and the keys. The backup key is scrypt(password), N=2¹⁵ |
| Restore | **Restore from a backup…**, or `npm run local -- restore <file>` | Decrypted into `config/staging`, validated, then swapped in by the launcher while the app is stopped. The previous data is kept as `<data>.before-restore-<time>` |
| Move | **Move data…** | Copy → verify → update `location.json` → restart. The old folder is kept or deleted, as you choose |

**Safety:**

- Operations that need the database closed (move, restore, delete-all) are written to `pending.json`. The app then exits, and the launcher applies the operation before starting again.
- Zip entries are path-checked, so a backup can't write outside its folder.

## 7. Deletion and cleanup

| What | How |
|---|---|
| Single items | Delete conversations, files, memories and search entries in the app |
| Account | Settings → Data → Delete account (removes its rows and stored files) |
| **Everything** | Settings → Privacy & storage → **Delete all local data** (type DELETE + password), or `npm run local -- delete-all`. Removes the whole data folder and the keys |
| Automatic | Every 6 hours, inside the app (`instrumentation.ts`): stale quarantine files, expired guests, old sessions, error logs older than 90 days, optional `FILE_RETENTION_DAYS`. Logs older than 14 days are removed by the launcher |

## 8. Security of the stored data

| Measure | Details |
|---|---|
| Encryption at rest | AES-256-GCM for message content and metadata, titles, file names, document text, project fields, memories, custom instructions, search history, and every stored file |
| Key storage | Generated locally on first run and kept in the config folder, not the data folder. Windows: DPAPI tied to your Windows account (verified by a round trip before use; otherwise an owner-only file with a restricted ACL). macOS/Linux: a `0600` file |
| Key safety | New keys are never generated when a database exists, since that would make your data unreadable. The launcher stops with instructions instead |
| Passwords | Argon2id. Resetting a password signs out all of that account's sessions |
| Sessions | Server-side registry with idle and absolute timeouts, sign out everywhere, and per-device revoke |
| Network exposure | The app binds to `127.0.0.1` only. Strict nonce-based CSP with `connect-src 'self'`, so the page can't talk to other servers. Next.js telemetry is disabled |
| Isolation | Every query is scoped to the signed-in owner. It's a single-owner install by default |
| Egress | Offline mode blocks everything non-local. `scripts/dev/egress-guard.cjs` proves it by recording and blocking any non-local connection |
| Folders | Private permissions (`0700` folders, `0600` files). Cloud-synced locations are refused |

**Limits (be aware):**

- Anyone logged in to your computer account while WHITE-LOTUS is unlocked can use it, and malware running as you could read what you can read. Use a strong account password and full-disk encryption (BitLocker or FileVault).
- DPAPI protects the keys against other Windows users and against copying the disk to another machine. It doesn't protect against malware running as you.

## 9. What was replaced

| Before (remote) | Now (local) |
|---|---|
| Neon / hosted PostgreSQL (`DATABASE_URL`, `postgres` driver) | PGlite in `data/db` (`@electric-sql/pglite`, `drizzle-orm/pglite`) |
| Cloudflare R2 / S3 (`@aws-sdk/*`, presigned URLs) | Encrypted files in `data/files` |
| Vercel hosting, `vercel.json`, Vercel Cron | The launcher on this computer; in-app housekeeping timer |
| Keys in the host's environment variables | Keys generated locally, DPAPI / owner-only file |
| Email-based password reset (Resend/Postmark) | `reset-password.cmd` locally (email is optional) |
| `DEPLOYMENT.md`, Dockerfile, docker-compose, `render.yaml`, deploy workflow | `INSTALL.md`, `WHITE-LOTUS.cmd`, `white-lotus.sh` |
| Search queries only in message metadata | A dedicated local `search_history` table |
