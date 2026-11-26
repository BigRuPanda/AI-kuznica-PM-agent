@echo off
setlocal
cd /d "%~dp0"
call "%~dp0python.cmd" service.py
if errorlevel 1 pause
