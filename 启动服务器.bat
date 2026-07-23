@echo off
cd /d "%~dp0"
echo Starting...
powershell -NoProfile -ExecutionPolicy Bypass -NoExit -File "%~dp0scripts\start-server.ps1"
echo.
echo If the window closed unexpectedly, copy the error above.
pause
