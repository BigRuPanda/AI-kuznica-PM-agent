@echo off
setlocal
cd /d "%~dp0"
call "%~dp0python.cmd" setup_demo.py --show-login
pause
