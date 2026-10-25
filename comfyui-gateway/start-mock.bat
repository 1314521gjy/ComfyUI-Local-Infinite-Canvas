@echo off
cd /d "%~dp0mock"
node comfyui-mock.mjs --port 18188 --delay 300
