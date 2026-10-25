@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing gateway dependencies...
  call npm install --legacy-peer-deps
)
node src/server.js
