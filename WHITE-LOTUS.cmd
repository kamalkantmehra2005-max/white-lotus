@echo off
rem WHITE-LOTUS - start the local app (Windows). Double-click this file.
rem Everything runs on this computer at http://127.0.0.1:3000 ; your data stays in your WHITE-LOTUS data folder.
setlocal
cd /d "%~dp0"
title WHITE-LOTUS
set NEXT_TELEMETRY_DISABLED=1
set npm_config_update_notifier=false
set npm_config_fund=false
set npm_config_audit=false

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  WHITE-LOTUS needs Node.js 20 or newer ^(one-time install^).
  echo  Opening the download page: choose the "LTS" Windows Installer, install it, then double-click WHITE-LOTUS.cmd again.
  start "" https://nodejs.org/en/download
  pause
  exit /b 1
)
node -e "process.exit(+process.versions.node.split('.')[0] >= 20 ? 0 : 1)"
if errorlevel 1 (
  echo  Your Node.js is too old. Install the current LTS version from https://nodejs.org and try again.
  pause
  exit /b 1
)

if not exist "node_modules\.package-lock.json" (
  echo.
  echo  First run: installing WHITE-LOTUS components ^(a few minutes, one time only^)...
  call npm ci --no-audit --no-fund
  if errorlevel 1 (
    echo  Installation failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

call npm run local -- start
if errorlevel 1 pause
