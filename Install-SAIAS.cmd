@echo off
rem Installs SAIAS: detects the hardware, downloads the recommended models and runtimes,
rem sets up web search, Hermes and a desktop shortcut. Safe to run again.
rem Options: --profiles flash,smart,pro  --yes  --check  --no-hermes  --no-shortcut
call "%~dp0saias.cmd" install %*
set "SAIAS_EXIT=%errorlevel%"
if not "%SAIAS_EXIT%"=="0" echo Installation failed (exit code %SAIAS_EXIT%).
pause
exit /b %SAIAS_EXIT%
