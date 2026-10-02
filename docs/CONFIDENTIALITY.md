# Using WHITE-LOTUS with confidential and legal material

This document describes what WHITE-LOTUS does technically to protect your information, and what it does **not** do. It is meant to help you and your firm decide whether a given deployment fits the material you intend to handle. It is not legal advice, and it is not a certification.

> **WHITE-LOTUS does not, by itself, establish attorney–client privilege, satisfy any particular regulation or professional-conduct rule, or guarantee confidentiality.** Those depend on your infrastructure, your AI and storage providers' contracts, your firm's policies, and how the system is configured and used. Before you upload highly sensitive documents, review [INSTALL.md](../INSTALL.md) and, if you use a cloud AI, that provider's terms.

## What WHITE-LOTUS protects

| Area | What is implemented |
|---|---|
| **Account isolation** | Every read and write is filtered by the signed-in user's ID on the server. IDs sent by the browser are only lookup keys, and ownership is re-checked on every request. Another user's resources return "not found", which doesn't even confirm they exist. Tested with a cross-user attack matrix covering conversations, projects, memories, files, download links and sessions. |
| **Encryption at rest (application level)** | AES-256-GCM with a random IV per value, bound to its owner (associated data), under a versioned, rotatable key ring. Encrypted: conversation titles, **message text and metadata** (sources, search queries, activity), document text extracted from uploads, file names, document titles, project names, descriptions and instructions, memories, and custom instructions. |
| **Search without plaintext** | Conversation and document search uses a *blind index*: keyed HMAC-SHA256 hashes of normalised words. The database never holds searchable plaintext. |
| **Passwords** | Hashed with Argon2id (never encrypted, never logged). |
| **Sessions** | Server-side session registry. Sign out, *sign out everywhere*, per-device revoke, a 12-hour inactivity timeout and a 7-day absolute limit (both configurable). Sessions are revoked on password change or reset. HttpOnly, SameSite cookies. |
| **Files** | Validated by size, extension and content signature, with a random storage name. Held in **quarantine** until a malware scan passes (when a local ClamAV is configured; can fail closed), then stored **encrypted** in your data folder. Downloads use one-minute signed links that only work for you. |
| **Where data lives** | Only on this computer, in your data folder (embedded database + encrypted files). No cloud database, no cloud storage. The app listens on 127.0.0.1 only; nobody on your network can reach it. Settings → Privacy & storage shows exactly what (if anything) is sent to an AI or search provider. |
| **Minimised logging** | Logs never contain passwords, keys, tokens or message content (content is reduced to character counts). The tool audit log records only the tool name, argument names, outcome and timing. The admin console shows metadata only, never conversations. |
| **Your control** | Readable export (ZIP/JSON), encrypted backup and restore, move the data folder, delete search history, delete the account, or delete all local data and keys. Memory can be switched off. |

## Guest mode and confidential material

Guest (no-signup) mode is **off by default** (`ALLOW_GUEST_CHAT=false`). If you turn it on:

- Guests can only chat and run web research, with lower limits. They **cannot upload files or reach private storage**, and have no projects, memory, settings or export.
- Each guest's chats are isolated server-side and deleted after `GUEST_RETENTION_HOURS` (default 24), or immediately on "End guest session".
- Guest messages are still sent to the configured AI provider (and searches to the search provider), exactly like account messages. **Tell users not to paste confidential client information into a guest chat.** Better still, keep guest mode off on a firm deployment.

## What WHITE-LOTUS does **not** protect against, and what you must decide

1. **The AI provider sees what you send it.** To answer, the relevant text of your question, conversation history and file excerpts is sent to the AI model provider configured on the server (OpenAI, Anthropic, Google, or your own model). Web research sends *search queries* to the search provider. Choose providers whose terms fit your obligations. Look for zero-data-retention or no-training commitments, business or enterprise agreements, and data-residency options. For the most sensitive material, run a **self-hosted model** (Ollama or vLLM on infrastructure you control). WHITE-LOTUS supports this out of the box.
2. **Your computer.** Anyone who can use your computer account (or malware running as you) can use WHITE-LOTUS and read what you can read. The encryption protects a copied data folder, a lost backup drive (without the backup password) and other Windows users (DPAPI keys). Use a strong account password, lock your screen, and turn on BitLocker / FileVault.
3. **The blind index leaks patterns, not content.** An attacker who has the database but not `BLIND_INDEX_KEY` can see that two records share a word, but not what the word is.
4. **Metadata isn't encrypted.** Email addresses, display names, timestamps, file sizes, MIME types and usage counts stay readable, because they're needed for sign-in, ordering and limits.
5. **Malware scanning is only as good as the scanner.** If `MALWARE_SCANNER=none`, files are **not** scanned, and the app says "Not scanned" rather than pretending. Scanners detect known malware; they don't guarantee a file is safe. Documents are never executed or rendered in the app's origin, which limits the impact.
6. **Your devices.** A compromised laptop or browser extension can see what you see. Signing out on shared computers and using *sign out everywhere* after losing a device are your responsibility.
7. **Backups and retention.** `.wlbackup` files contain everything, including the keys, protected only by the backup password — choose a strong one and store backups safely. A forgotten backup password can't be recovered. Set `FILE_RETENTION_DAYS` if your policy requires files to be deleted automatically.
8. **Output quality.** AI answers can be wrong. Verify anything you rely on, especially citations and legal conclusions.

## Recommended configuration for confidential work

```env
OLLAMA_BASE_URL=http://127.0.0.1:11434   # a local model: nothing leaves the computer
LOCAL_OFFLINE_MODE=true           # enforce it (no web search / page reading)
MALWARE_SCANNER=clamav            # local ClamAV
MALWARE_SCAN_REQUIRED=true        # reject uploads when scanning isn't possible
AUTH_FIRST_USER_ADMIN=false       # after your admin account exists
SESSION_IDLE_TIMEOUT_MINUTES=240  # tighter inactivity timeout
FILE_RETENTION_DAYS=...           # per your retention policy
ENABLE_CODE_EXECUTION=false
```

If you use a cloud AI instead, choose one under an agreement appropriate for client data. Keep your `.wlbackup` files and their password safe; the encryption keys are managed on this computer automatically.
