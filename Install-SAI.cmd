@echo off
rem Installs and configures SAI-LLM: runtimes, models, web search, Hermes.
rem Options: -Profiles flash,smart,pro  -Yes  -Check  -NoHermes  -NoShortcut
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Install-SAI.ps1" %*
set "SAI_EXIT=%errorlevel%"
if not "%SAI_EXIT%"=="0" echo Installation failed (exit code %SAI_EXIT%).
pause
exit /b %SAI_EXIT%
