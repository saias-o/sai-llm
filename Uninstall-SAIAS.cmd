@echo off
rem Uninstalls SAIAS in a window: stops it, removes the models, data, shortcuts, the Windows
rem "Installed apps" entry and the SAIAS settings in Hermes, Codex and OpenCode. The program
rem folder stays. Options: --console (terminal), with --check --yes --keep-conversations
call "%~dp0saias.cmd" uninstall %*
set "SAIAS_EXIT=%errorlevel%"
if not "%SAIAS_EXIT%"=="0" (
    echo Uninstall failed ^(exit code %SAIAS_EXIT%^).
    pause
)
exit /b %SAIAS_EXIT%
