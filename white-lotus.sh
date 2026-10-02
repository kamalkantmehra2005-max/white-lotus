#!/usr/bin/env bash
# WHITE-LOTUS - start the local app (macOS / Linux):  ./white-lotus.sh
# Runs at http://127.0.0.1:3000 on this computer only; your data stays in your WHITE-LOTUS data folder.
set -euo pipefail
cd "$(dirname "$0")"
export NEXT_TELEMETRY_DISABLED=1 npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
if ! command -v node >/dev/null 2>&1; then
  echo "WHITE-LOTUS needs Node.js 20 or newer (one-time install): https://nodejs.org"; exit 1
fi
node -e "process.exit(+process.versions.node.split('.')[0] >= 20 ? 0 : 1)" || { echo "Please install Node.js 20 or newer."; exit 1; }
[ -f node_modules/.package-lock.json ] || { echo "First run: installing WHITE-LOTUS components (one time only)…"; npm ci --no-audit --no-fund; }
exec npm run local -- "${@:-start}"
