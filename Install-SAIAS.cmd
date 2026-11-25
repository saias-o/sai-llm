@echo off
rem Installs SAIAS in a setup window: the advisor detects the hardware and preselects only the
rem models this PC can run, then downloads them with their runtimes and sets up your tools.
rem Safe to run again. Options: --console (terminal installer)  --profiles flash,smart,pro
rem   --no-tools --no-path --no-shortcut --no-bench; with --console also --yes and --check
call "%~dp0saias.cmd" setup %*
set "SAIAS_EXIT=%errorlevel%"
if not "%SAIAS_EXIT%"=="0" (
    echo Installation failed ^(exit code %SAIAS_EXIT%^).
    pause
)
exit /b %SAIAS_EXIT%
