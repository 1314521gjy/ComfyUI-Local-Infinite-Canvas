@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "%~dp0node\node.exe" (
  "%~dp0node\node.exe" launcher\start.mjs %*
) else (
  node launcher\start.mjs %*
)
