@echo off
rem Set a new password for your local WHITE-LOTUS account. Close WHITE-LOTUS first.
setlocal
cd /d "%~dp0"
set /p EMAIL=Email of your WHITE-LOTUS account: 
call npm run local -- reset-password %EMAIL%
pause
