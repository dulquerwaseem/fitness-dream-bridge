@echo off
REM Registers the bridge as a Scheduled Task that runs at Windows startup,
REM even if no one logs in, and restarts automatically if it stops.
REM Run this file once, as Administrator.

set TASK_NAME=FitnessDreamBiometricBridge
set SCRIPT_DIR=%~dp0

schtasks /create /tn "%TASK_NAME%" ^
  /tr "\"%SCRIPT_DIR%start-bridge.bat\"" ^
  /sc onstart ^
  /ru SYSTEM ^
  /rl HIGHEST ^
  /f

if %ERRORLEVEL% EQU 0 (
  echo.
  echo Task "%TASK_NAME%" created. It will run on every boot.
  echo To remove it later: schtasks /delete /tn "%TASK_NAME%" /f
) else (
  echo.
  echo Failed to create the task. Make sure you ran this as Administrator.
)
pause
