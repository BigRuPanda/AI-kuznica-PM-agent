@echo off
setlocal
cd /d "%~dp0"
call "%~dp0python.cmd" configure.py
pause
