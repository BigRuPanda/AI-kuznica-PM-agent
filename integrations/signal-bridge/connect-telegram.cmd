@echo off
setlocal
cd /d "%~dp0"
call "%~dp0python.cmd" connect_telegram.py
pause
