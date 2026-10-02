# Installing and running WHITE-LOTUS on your computer

WHITE-LOTUS is a local application. It runs on your PC/laptop and keeps all of its data in a folder on that computer. You install it once. After that, you just start it.

## What you need

- Windows 10/11, macOS 12+ or a recent Linux
- **Node.js 20 or newer** (the "LTS" installer from <https://nodejs.org>). One-time install.
- About 1.5 GB of disk space for the app, plus room for your data
- An AI model. Pick one:
  - **Fully private:** [Ollama](https://ollama.com) on the same computer. Install it, then run `ollama pull llama3.1` (or another model).
  - **Cloud AI:** an API key from Groq (has a free tier), OpenAI, Anthropic or Google. Your messages are sent to that provider to generate answers.
- *(Optional)* A Tavily API key for web research. Search queries are sent to Tavily.
- *(Optional)* ClamAV for scanning uploads.

## Windows, step by step

1. **Install Node.js.** Download the LTS "Windows Installer (.msi)" from nodejs.org and click through it with the defaults.
2. **Put WHITE-LOTUS in a local folder.** Right-click `white-lotus.zip` → Extract All, into e.g. `C:\Users\<you>\WHITE-LOTUS-app`.
   - Avoid OneDrive/Desktop folders that sync to the cloud: the app folder is large and changes often.
3. **Double-click `WHITE-LOTUS.cmd`.** On the first run it will:
   1. Install its components with `npm ci`. This takes a few minutes and downloads software only.
   2. Ask **where to keep your data**. Press Enter for the default `%LOCALAPPDATA%\WHITE-LOTUS\data`, or type another folder such as `D:\WHITE-LOTUS-data`. Cloud-synced folders are refused.
   3. Ask **which AI to use**:
      - For **Ollama**: accept the address `http://127.0.0.1:11434`, type the model name, and answer `y` to offline mode if you want nothing ever to leave the computer.
      - For **Groq**: paste your key (`gsk_…`) and keep the suggested model or type another from console.groq.com → Models.
   4. Ask for an optional Tavily key and your name for the footer.
   5. Create the encryption keys. On Windows they're protected with your Windows account (DPAPI).
   6. Prepare the app (a few minutes, first run only), then start it and open **http://127.0.0.1:3000** in your browser.
4. **Create your account** (name, email, password). It's the owner account, stored only on this computer. Only one account can be created unless you set `LOCAL_SINGLE_USER=false`.
5. **Use WHITE-LOTUS.** Keep the black WHITE-LOTUS window open. To stop, close it or press Ctrl+C.

**Every other time:** double-click `WHITE-LOTUS.cmd`. It starts in seconds and opens the browser.

## macOS / Linux

```bash
cd ~/WHITE-LOTUS-app
./white-lotus.sh            # first run installs, asks the setup questions, then starts
```

## Changing settings later

- **AI / search:** run `npm run local -- setup`, or edit `settings.env` in the config folder (`npm run local -- where` shows it), then restart.
- **Data folder:** Settings → Privacy & storage → **Move data…**. WHITE-LOTUS copies everything, checks the copy and restarts.
- **Offline mode:** set `LOCAL_OFFLINE_MODE=true` in `settings.env`. Only local AI is allowed; web search, page reading and weather are switched off.

## Backups and moving to a new computer

1. Settings → Privacy & storage → **Backup & restore**. Choose a backup password (10+ characters) and click **Create backup**. Save the `.wlbackup` file on a USB drive or another disk.
   - The command-line alternative is `npm run local -- backup E:\white-lotus.wlbackup`.
2. On the new computer: install WHITE-LOTUS, then either
   - start it and use **Restore from a backup…**, or
   - run `npm run local -- restore E:\white-lotus.wlbackup`.

The backup contains everything, including the keys, encrypted with your backup password. **A forgotten backup password can't be recovered.**

## Forgotten password

Close WHITE-LOTUS, double-click `reset-password.cmd` (or run `npm run local -- reset-password you@example.com`), type a new password and start WHITE-LOTUS again. There's no email involved.

## Updating

Replace the app folder with the new version. Your data and keys live elsewhere and are untouched. Then delete `node_modules` (so it reinstalls) and start `WHITE-LOTUS.cmd`. The launcher applies database migrations and rebuilds automatically.

## Uninstalling

1. *(Optional)* In Settings → Privacy & storage, run **Delete all local data**, or delete the data folder and the config folder yourself (`npm run local -- where` shows both).
2. Delete the app folder.

## Optional: malware scanning with ClamAV

Install ClamAV (on Windows via the official installer, or run `clamd` in Docker), make sure `clamd` listens on `127.0.0.1:3310`, then add to `settings.env`:

```
MALWARE_SCANNER=clamav
MALWARE_SCAN_REQUIRED=true
```

Without a scanner, files are labelled **"Not scanned"**. The app never claims a scan it didn't do.

## Security notes for this computer

- WHITE-LOTUS listens only on `127.0.0.1`. Other computers on your network can't reach it.
- Anyone who can log in to your computer account, or who has your data folder *and* your keys, can read the data. Use a strong Windows password and **turn on BitLocker** (Windows) / FileVault (macOS) disk encryption.
- Keep backups somewhere safe. They contain everything, protected by the backup password.
