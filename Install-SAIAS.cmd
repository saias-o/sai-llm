@echo off
rem Installs and configures SAIAS-LLM: runtimes, models, web search, Hermes.
rem Options: -Profiles flash,smart,pro  -Yes  -Check  -NoHermes  -NoShortcut
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Install-SAIAS.ps1" %*
set "SAIAS_EXIT=%errorlevel%"
if not "%SAIAS_EXIT%"=="0" echo Installation failed (exit code %SAIAS_EXIT%).
pause
exit /b %SAIAS_EXIT%
