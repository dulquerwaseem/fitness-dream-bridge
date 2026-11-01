@echo off
cd /d "%~dp0"

:loop
node bridge.js >> logs\bridge.log 2>&1
echo Bridge process exited, restarting in 5 seconds... >> logs\bridge.log
timeout /t 5 /nobreak >nul
goto loop
