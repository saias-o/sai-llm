@echo off
rem Starts SAIAS and opens chat in the browser. Clients such as Hermes use http://127.0.0.1:8090/v1.
title SAIAS
call "%~dp0saias.cmd" start --open %*
set "SAIAS_EXIT=%errorlevel%"
if not "%SAIAS_EXIT%"=="0" pause
exit /b %SAIAS_EXIT%
