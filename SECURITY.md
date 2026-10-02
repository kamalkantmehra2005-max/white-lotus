# WHITE-LOTUS security model

**Status labels:**
- **VERIFIED**: covered by automated tests that were run for this release.
- **REQUIRES CREDENTIALS**: implemented, but needs your provider accounts to exercise.
- **REQUIRES PRODUCTION**: can only be fully confirmed on the deployed site.
- **DESIGN**: a documented limitation or residual risk.

For what this means for confidential and legal material, see [docs/CONFIDENTIALITY.md](docs/CONFIDENTIALITY.md). Local storage architecture: [docs/LOCAL-FIRST.md](docs/LOCAL-FIRST.md).

## Request pipeline

```
browser ─http://127.0.0.1─▶ proxy.ts: CSRF (Origin + Sec-Fetch-Site), strict nonce CSP, request id, route guard
          ─▶ route handler: zod input validation → requireUser() → rate limit → owner-scoped data access → operation
                              │ authenticated (JWT cookie) → session valid server-side (registry) → not blocked
```

Ownership is enforced **in the data layer**: every query filters by the session's user ID (`lib/chat/conversations.ts`, `lib/projects`, `lib/files/documents.ts`, `lib/memory`, `lib/security/sessions.ts`). IDs from the browser are only lookup keys. Other users' resources return 404, which doesn't confirm they exist.

## Controls

| Area | Control | Status |
|---|---|---|
| **Authorization / IDOR** | Owner-scoped queries everywhere. The route guard in `proxy.ts` applies the `authorized` rules explicitly (unauthenticated → login/401, guests → 403 on account-only APIs, non-admins → no admin), **and** each handler re-checks against the database. Cross-user matrix (B tries to read, modify or delete A's conversations, projects, memories and files; mint A's download links; post into A's chats; revoke A's sessions) | VERIFIED (integration tests + `smoke-security.sh --full`) |
| **Guest mode** (`ALLOW_GUEST_CHAT`) | A guest is a server-side identity (its own `users` row with `is_guest`, plus a server-side session). There's no browser-supplied ID, and guests are isolated like accounts. Account-only APIs (files, projects, memories, settings, admin) are refused in `proxy.ts` **and** in each handler (`requireAccount`). No uploads, not even attaching someone's file ID. Stricter daily limits, plus per-network caps on guest creation and messages. Data is deleted at `GUEST_RETENTION_HOURS` (enforced per request, purged on new guests and daily) or immediately on "End guest session". Keeping chats on sign-up uses a 15-minute HMAC token bound to the guest ID, redeemable only by a real account | VERIFIED (integration tests, `smoke-security.sh --full`, browser tests) |
| **Passwords** | Argon2id (m=19 MiB, t=2, p=1). Legacy bcrypt upgraded on login. Constant-time path for unknown users. Policy: ≥ 10 characters with letters and digits | VERIFIED |
| **Brute force** | 10 attempts per account and 40 per IP per 15 min (configurable) | VERIFIED |
| **Sessions** | Server-side registry (`user_sessions`). The JWT only carries a session ID. Every request checks the session exists, belongs to the user, isn't revoked, isn't past its absolute lifetime (7 days) and isn't idle (12 hours). Each sign-in creates a new session (no fixation). Sign out revokes server-side. **Sign out everywhere** revokes all sessions and bumps `session_version`. Password change or reset and admin block revoke everything. Users can list and revoke devices | VERIFIED (unit, integration, HTTP and two-browser UI tests) |
| **Cookies** | HttpOnly, SameSite=Lax. (Secure is only possible over HTTPS; the local app uses http://127.0.0.1) | VERIFIED |
| **Password reset** | Local: `reset-password.cmd` / `npm run local -- reset-password` (needs access to this computer; revokes all sessions). Email-based reset only if a mail provider is configured | VERIFIED (local command) |
| **Google OAuth** | Verified Google emails only, no dangerous account linking, sign-up switch respected, provider tokens never stored | REQUIRES CREDENTIALS |
| **Encryption at rest** | AES-256-GCM, random 96-bit IV, owner-bound AAD (`lib/security/fields.ts`), versioned key ring. Encrypted: conversation titles, message content and metadata, document chunks, document titles, file names, project fields, memories, custom instructions, **search history**, and **every stored file** (`WLF1` format, AAD = storage key). Key rotation tooling isn't included in the local release | VERIFIED (ciphertext in DB rows and on disk: integration tests) |
| **Search on encrypted data** | Blind index: HMAC-SHA256 (HKDF-derived key) over normalised words, in `text[]` columns with GIN indexes | VERIFIED |
| **Keys** | Generated on this computer on first run (`lib/local/keys.ts`) and kept in the config folder, apart from the data. Windows: DPAPI (round trip verified before use), else an owner-only file with a restricted ACL. macOS/Linux: `0600`. Never regenerated over existing data. Never logged, never in Git, never in browser bundles | VERIFIED on Linux (file mode, no-overwrite rule, bundle scan). **Windows DPAPI path: NOT VERIFIED** (no Windows machine in the test environment) |
| **Uploads** | Size cap (checked before buffering), extension allow-list, magic-byte sniffing, sanitised names, random object keys, path-traversal-safe storage keys | VERIFIED |
| **Quarantine + malware scan** | `q/` quarantine → scan → release to `u/` or delete. Engines: `clamav` (INSTREAM), `http` (external service; adapter in `scanner/`), `none` (labelled "Not scanned"). `MALWARE_SCAN_REQUIRED` fails closed | VERIFIED with a real ClamAV 1.5.4 engine and the EICAR test signature (clean passes, EICAR rejected, scanner down → rejected). Official signature updates (freshclam) = REQUIRES PRODUCTION |
| **Downloads** | Only via signed links minted **after** an ownership check. The HMAC covers file + user + expiry (60 s). The download route re-authenticates and re-checks ownership. Always `attachment` with a sandbox CSP. Streamed from the local encrypted store | VERIFIED |
| **Local storage** | Everything lives in the data folder (PGlite `db/`, encrypted `files/`). No cloud database or object storage in the code. Cloud-synced folders are refused. One process at a time (lock file) | VERIFIED (integration + HTTP tests; egress guard: 0 non-local connections) |
| **SSRF** | http(s) and ports 80/443 only, no credentials in URLs, internal hostnames blocked, every resolved IP checked (private, reserved, metadata, IPv4-mapped IPv6), **connection pinned to the validated IP**, redirects re-validated per hop, size and time caps | VERIFIED |
| **Prompt injection** | Trust layers in the system prompt. Web, file, tool and past-conversation content wrapped as `trust="untrusted-data"`. `read_url` only fetches URLs the user gave or that came from search. Remote images in answers aren't loaded. `save_memory` requires an explicit request in the user's own message | VERIFIED (unit); residual risk = DESIGN |
| **Tools** | Server-only. Each has a zod schema, a permission rule, a per-user rate limit and a timeout. No shell. JavaScript sandbox off by default. Audit log stores metadata only (no inputs or outputs) | VERIFIED |
| **XSS** | Markdown with no raw HTML. URL allow-list. **Nonce-based CSP with `'strict-dynamic'`, no `'unsafe-inline'`/`'unsafe-eval'` for scripts.** `frame-ancestors 'none'`, `object-src 'none'`, images from this origin only | VERIFIED (browser tests fail on any CSP violation) |
| **CSRF** | `Sec-Fetch-Site: cross-site` and Origin mismatch rejected on API mutations. SameSite cookies. Auth.js CSRF token | VERIFIED |
| **Network exposure** | The app listens on `127.0.0.1` only (not the LAN). Browser: CSP `connect-src 'self'`. Next.js telemetry disabled. Offline mode (`LOCAL_OFFLINE_MODE`) removes every non-local AI, search, URL-reader and weather call. Traffic on loopback is plain HTTP, so Secure cookies/HSTS don't apply | VERIFIED (bound address checked; egress guard in offline and normal runs) |
| **Rate limits** | Login, sign-up, forgot and reset password, chat, search, uploads, download links, tools, settings, export, backup/restore/wipe (stored in the embedded database) | VERIFIED |
| **Errors** | Friendly messages only. Details in redacted server logs and `error_logs` (no content) | VERIFIED |
| **Privacy** | Readable export (ZIP with Markdown + files, or JSON). Encrypted backup/restore (scrypt + AES-256-GCM, includes keys). Delete conversations, files, memories, search history, account, or **all local data + keys**. "What leaves this computer" is computed from the configuration and shown in Settings and under the chat box | VERIFIED (integration + browser tests) |
| **Dependencies** | Next 16.3.6 (patched). `npm audit` has 0 critical advisories. The remaining high advisory is `nodemailer`, an optional peer of next-auth that is never imported | VERIFIED |

## Known limitations (DESIGN)

- Application-level encryption protects against database, backup and storage exposure. It doesn't protect against a compromised application server or someone who holds **both** the database and the keys.
- The blind index reveals when two records share a word (not which word).
- Metadata (emails, names, timestamps, sizes) isn't encrypted.
- `style-src` allows inline styles (needed by React and Next.js). Styles can't execute script.
- A smoke test isn't a penetration test. Commission an independent assessment before handling client data at scale.

Report vulnerabilities privately to the maintainer.
