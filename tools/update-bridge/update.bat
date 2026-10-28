@echo off
chcp 65001 >nul
setlocal
title 无界工作台 一键更新

echo ============================================
echo   无界工作台 一键更新
echo   保留你的作品、模型和设置
echo ============================================
echo.

if "%~1"=="" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0apply-update.ps1"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0apply-update.ps1" -Root "%~1"
)

if errorlevel 1 (
  echo.
  echo 更新没有完成。请检查网络后重试，或把上面的提示截图反馈。
)
echo.
pause
