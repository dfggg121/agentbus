@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo [agentbus] Node.js not found. Please install Node.js 22.13 or newer.
  pause
  exit /b 1
)
set "BUS_ROOT=%AGENTBUS_ROOT%"
if "%BUS_ROOT%"=="" if exist "%~dp0..\var\main" set "BUS_ROOT=%~dp0..\var\main"
if "%BUS_ROOT%"=="" set "BUS_ROOT=%USERPROFILE%\.agentbus"
echo [agentbus] Starting local companion client on 127.0.0.1...
echo [agentbus] Root: %BUS_ROOT%
echo [agentbus] Close this window or press Ctrl+C to stop.
node "%~dp0bus.js" ui --host 127.0.0.1 --port 0 --root "%BUS_ROOT%" %*
if errorlevel 1 pause
endlocal
