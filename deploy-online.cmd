@echo off
title WHITE-LOTUS - deploy the online edition
cd /d "%~dp0"
echo.
echo  WHITE-LOTUS - deploy the ONLINE edition straight from this folder (no GitHub upload needed).
echo  Needs: a free Vercel account (vercel.com) and the project's settings already added there
echo  (DATABASE_URL, AUTH_SECRET, AI keys...). See docs\ONLINE.md.
echo.
echo  First time: a browser window opens so you can sign in to Vercel. Then answer the questions:
echo    Set up and deploy?  Y        Which scope?  (your name)
echo    Link to existing project?  Y if you already created "white-lotus" in Vercel, otherwise N
echo.
pause
call npx --yes vercel@latest --prod
echo.
echo  Done. The address printed above is your live site. Run this file again to publish an update.
pause
