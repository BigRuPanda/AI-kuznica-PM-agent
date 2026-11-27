@echo off
setlocal
if exist "%~dp0runtime\python.exe" (
  "%~dp0runtime\python.exe" -B -X utf8 %*
) else if exist "%~dp0..\Signal\runtime\python\python.exe" (
  "%~dp0..\Signal\runtime\python\python.exe" -B -X utf8 -c "import sys,runpy;sys.path.insert(0,'.');sys.argv=sys.argv[1:];runpy.run_path(sys.argv[0],run_name='__main__')" %*
) else (
  py -3 -B -X utf8 %*
)
exit /b %errorlevel%
