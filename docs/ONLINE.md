# WHITE-LOTUS online edition

The online edition is a website. Nobody's PC has to stay on: a free hosting service runs it.

**Conversations are not stored on that server.** Each device keeps its own copy in its own browser.

```
 Phone / laptop / office PC (browser)                         Host (Vercel)              Hosted Postgres (Neon)
 ┌──────────────────────────────────────┐   HTTPS   ┌──────────────────────────┐   ┌───────────────────────────────┐
 │ WHITE-LOTUS web app (/app)            │ ───────▶ │ stateless AI relay        │──▶│ accounts (email, Argon2 hash)  │
 │  • with account: IndexedDB (kept)     │          │ (/api/web/chat, extract)  │   │ sessions, limits, usage counts │
 │  • without account: this tab only     │          │ stores no chat content    │   │ encrypted sync copies (opaque) │
 └──────────────────────────────────────┘          └────────────┬─────────────┘   └───────────────────────────────┘
                                                                  └──▶ AI provider (answers the question) / web search
```

## The two ways to use it

| | **Use with account** | **Use without account** |
|---|---|---|
| Sign-up | Email + password | None |
| Where chats live | This browser on this device (IndexedDB). On Windows that's inside `%LOCALAPPDATA%\<Browser>\User Data\<Profile>\IndexedDB\` | This browser tab only (`sessionStorage`) |
| After closing the site | Still there next time | **Erased** when the tab/window is closed. "End & erase now" deletes it immediately |
| Other devices | Sign in there and your chats sync down | Never; nothing leaves the tab except the question being answered |
| Server copy | Only an **end-to-end encrypted** copy, made in your browser with a key derived from your password. The server can't read it | None |
| Sync switch | Settings → Account → "Sync across my devices". Off means this device only | — |
| Limits | Per-account limits set by the owner | Lower per-network limits (default 30 messages, 5 searches a day) |
| Turn into an account | — | "Create account" can keep this tab's chats |

**How the encryption works:**

- Your browser turns your password into two keys with PBKDF2 (600,000 rounds) and HKDF: a **login key**, which is all the server ever receives, and a **vault key**, which never leaves the device.
- Each conversation is encrypted with AES-256-GCM using the vault key.
- **Consequence:** a forgotten password **can't be reset**. Encrypted copies on the server become unreadable, though chats already on a device stay there. Use **Settings → Export (JSON)** for your own backups.

**Honest limits:**

- To answer, your message and the text of any attached files are sent through the server to the AI provider. WHITE-LOTUS doesn't store them, but the AI provider's own policy applies.
- Web search sends short queries to the search provider.
- "Erased when you close the tab" is browser behaviour. Browsers that *restore your last session* can bring a tab back with its data, so use **End & erase now** on shared computers.
- Browser data is protected by your device login. Use **Sign out and remove from this device** on computers that aren't yours.

## Deploy (free tiers) — about 20 minutes

You need three free accounts: **GitHub**, **Neon** (database) and **Vercel** (hosting). You also need one AI key.

### 1. Put the code on GitHub

GitHub's browser uploader takes **at most 100 files per upload** and silently refuses bigger drops, so never drag the whole project in at once. Use one of these:

- **From a PC, in the browser (3 uploads):** go to github.com → **New repository** (Private). Then, for each of `github-upload-1-of-3.zip`, `-2-of-3.zip`, `-3-of-3.zip` (ask for them, or make them with `npm run pack:github`): unzip it, open the `upload-N` folder, press **Ctrl+A**, drag everything onto the repository page (**Add file → Upload files**), wait until every file is listed, then **Commit changes**. Each batch is under 100 files; together they are the complete project.
- **From a PC, without GitHub at all:** double-click **`deploy-online.cmd`** in the unzipped project folder (see step 4b).
- **From a phone only:**
  1. On github.com, create an empty private repository, then open it in **GitHub Codespaces** (Code → Codespaces → Create). It's free for limited monthly use.
  2. In the editor, upload `white-lotus-local.zip`, then run this in the terminal:
     ```
     unzip white-lotus-local.zip && cp -r white-lotus/. . && rm -rf white-lotus white-lotus-local.zip
     git add -A && git commit -m "WHITE-LOTUS" && git push
     ```

### 2. Create the database (Neon)

1. At neon.tech, sign up → **Create project** (any name, nearest region).
2. On the dashboard, click **Connect** and copy the connection string. It looks like `postgresql://…neon.tech/neondb?sslmode=require`. Pick the **pooled** one if offered.

### 3. Get an AI key (pick one)

- **Groq** (console.groq.com → API Keys) uses the OpenAI-compatible settings:
  `CUSTOM_OPENAI_BASE_URL=https://api.groq.com/openai/v1`, `CUSTOM_OPENAI_API_KEY=…`, `CUSTOM_OPENAI_NAME=groq`, `DEFAULT_MODEL=groq:<model name from Groq's model list>`.
- **Google Gemini** (aistudio.google.com → Get API key) uses `GOOGLE_AI_API_KEY=…` and `DEFAULT_MODEL=google:<model name from Google's list>`.

Check the provider's current free-tier terms. They change, and visitors using the site without an account spend your quota.

### 4. Deploy on Vercel

**4b. Alternative — deploy straight from your PC (no GitHub):** after creating the project in Vercel once (steps 4.1–4.2 below, any first build may fail — that's fine), double-click **`deploy-online.cmd`**. Sign in to Vercel in the browser window that opens, then answer: *Set up and deploy?* **Y** · *Which scope?* your name · *Link to existing project?* **Y** · *project name:* `white-lotus`. It uploads the whole folder and builds it on Vercel. Run it again whenever you want to publish an update.

1. At vercel.com, sign up with GitHub → **Add New → Project** → import your repository. The included `vercel.json` already sets the build command.
2. Under **Environment Variables**, add:

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | the Neon connection string |
   | `AUTH_SECRET` | a long random string. Open <https://generate-secret.vercel.app/32> and copy it. **Never change it later**: other keys are derived from it |
   | `OWNER_SETUP_CODE` | any private phrase, used once to make you the owner |
   | AI settings | from step 3 |
   | `TAVILY_API_KEY` *(optional)* | web search (tavily.com free tier) |

3. **Deploy.** You get `https://<name>.vercel.app`. The database tables are created by the app itself the first time it starts (nothing happens at build time, so a build can't fail because of the database).

### 5. Become the owner

1. Open `https://<name>.vercel.app` → **Use with account** → **Create account**.
2. Tap **"I'm the owner of this site"** and enter your `OWNER_SETUP_CODE`.
3. **Admin / Creator** then appears in the menu.
4. Back in Vercel → Settings → Environment Variables: **delete `OWNER_SETUP_CODE`** and **Redeploy**.
5. *(Optional)* Set `AUTH_ALLOW_SIGNUP=false` to stop new sign-ups.

### 6. Install it as an app

- **Android (Chrome):** ⋮ → **Install app**.
- **iPhone/iPad (Safari):** Share → **Add to Home Screen**.

It's the same site, so the same account and data apply.

## Admin / Creator (online)

- **What the owner sees:**
  - The creator card ("Created by Kamal Kant — Legal Secretary at Remfry & Sagar").
  - Users: block or unblock them, and make or revoke admins.
  - Models, usage limits, usage counts, health and recent errors.
- **What no one sees:** you can't read anyone's chats, because there is nothing readable on the server.
- **Adding people:** people create their own accounts; the owner can't create them, because each account's encryption depends on its own password.

## Settings reference (online)

| Variable | Default | Meaning |
|---|---|---|
| `WEB_GUEST_DAILY_MESSAGES` | 30 | Messages per network per day without an account |
| `WEB_GUEST_DAILY_SEARCHES` | 5 | Web searches per network per day without an account |
| `WEB_GUEST_PER_MINUTE` | 6 | Burst limit without an account |
| `WEB_VAULT_MAX_MB` | 50 | Encrypted sync storage per account |
| `AUTH_ALLOW_SIGNUP` | true | Allow new accounts |
| `DATABASE_POOL_MAX` | 3 | Database connections per server instance |

**Notes:**

- Don't configure Google sign-in for the online edition. Accounts need a password to derive their encryption key.
- `ENCRYPTION_KEYS` and `BLIND_INDEX_KEY` are derived from `AUTH_SECRET` automatically.

## What can cost money

| Item | Free today | Watch out for |
|---|---|---|
| Vercel Hobby | Yes | Its terms are for **personal, non-commercial** use. Use for your firm's work may need a paid plan or another host (e.g. Render's free tier, which sleeps when idle) |
| Neon | Free tier (limited storage and compute) | Limits can change. Only accounts and encrypted sync copies are stored, so usage stays small |
| AI API | Groq and Gemini have free tiers | Rate limits and terms change. Visitors without an account use your quota, so keep the limits low |
| Web search | Tavily has a free monthly allowance | Optional |
| GitHub, Codespaces | Free for personal use, within monthly hours | — |

## If the build fails

- **"this copy of the project is incomplete. Missing: …"** — GitHub's browser uploader accepts at most **100 files per upload**, so part of the project was left out. Open the unzipped `white-lotus` folder, drag the missing folders (keeping the folder structure) onto the repository page, commit, and deploy again. Check the repository has these top-level entries: `app`, `components`, `config`, `docs`, `drizzle`, `lib`, `public`, `scanner`, `scripts`, `tests`, `types`, `package.json`, `package-lock.json`, `next.config.ts`, `tsconfig.json`, `tailwind.config.ts`, `postcss.config.mjs`, `proxy.ts`, `instrumentation.ts`, `vercel.json`.
- **"Cannot find module …"** without that message — same cause; an older copy. Upload the current `next.config.ts` too.
- **Avoid the uploader altogether:** on a PC with Node.js, double-click **`deploy-online.cmd`** in the unzipped folder. It uploads the whole folder to Vercel directly (sign in once in the browser). Updates: run it again. The environment variables still come from the Vercel dashboard.
- **The log stops right after `> next build` with nothing else:** the build was stopped from outside before Next.js printed a single line — most often because a second deployment started for the same project (each upload to GitHub makes one commit and one deployment, and the import page can start another). Open the project → **Deployments** → **⋯ → Redeploy** on the newest one. The code builds under Vercel's own build tool (`vercel build`), so a retry normally succeeds.
- **Red lines you don't understand:** scroll to the very bottom of **Build Logs**, copy the last three lines, and ask.

## Updating

Upload the new files to the same GitHub repository (or `git push` from Codespaces, or run `deploy-online.cmd`). Vercel redeploys automatically, and the app applies any database changes itself when it starts.

Users' data is in their browsers, so updates never touch it.

## Local edition

The local edition (`WHITE-LOTUS.cmd`, everything on one PC) still works unchanged. The edition is chosen automatically: the online edition runs when `DATABASE_URL` is set on a host, and the local launcher always runs the local edition.
