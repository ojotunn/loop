@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund
)
if not exist .env (
  echo No .env found. Copy .env.example to .env and fill AGENT_PRIVATE_KEY.
  pause
  exit /b 1
)
echo Starting Loop on http://localhost:8437
node --env-file=.env src\server.js
pause
