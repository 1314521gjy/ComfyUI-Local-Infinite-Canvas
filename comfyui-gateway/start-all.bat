@echo off
rem 启动 ComfyUI，等 8188 可用后再启动网关。需要 GPU 空闲时使用。
if not defined COMFY_DIR set COMFY_DIR=C:\ComfyUI
start "ComfyUI" cmd /c "%COMFY_DIR%\run_nvidia_gpu.bat"

echo Waiting for ComfyUI on 8188...
:wait
curl -s -o nul http://127.0.0.1:8188/system_stats
if errorlevel 1 (
  timeout /t 3 /nobreak >nul
  goto wait
)
echo ComfyUI is up.
start "ComfyUI Gateway" cmd /c "%~dp0start-gateway.bat"
