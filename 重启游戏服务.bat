@echo off
cd /d "%~dp0"
echo Restarting game server only (keep Cloudflare URL)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\restart-game.ps1"
echo.
pause
