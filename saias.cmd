@echo off
rem SAIAS command line: saias install | start | update | rollback | adopt | status | clean | help
rem Uses Node.js 22+ from PATH, or a private copy in %LOCALAPPDATA%\SAIAS\node that it installs if needed.
setlocal
set "SAIAS_NODE=%LOCALAPPDATA%\SAIAS\node\node.exe"
if exist "%SAIAS_NODE%" goto :run
set "SAIAS_NODE="
for /f "tokens=1 delims=." %%V in ('node -p process.versions.node 2^>nul') do if %%V GEQ 22 set "SAIAS_NODE=node"
if defined SAIAS_NODE goto :run
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Get-Node.ps1" || exit /b 1
set "SAIAS_NODE=%LOCALAPPDATA%\SAIAS\node\node.exe"
:run
"%SAIAS_NODE%" "%~dp0src\cli.js" %*
exit /b %errorlevel%
