@echo off
rem Starts SAIAS-LLM: the saias-flash router with Llama Chat, saias-smart and saias-pro on demand, web search.
rem Llama Chat: http://127.0.0.1:8090/   Hermes and other clients: http://127.0.0.1:8090/v1
where node >/dev/null 2>/dev/null || (
    echo Node.js was not found. Run Install-SAIAS.cmd first.
    pause
    exit /b 1
)
title SAIAS-LLM
node "%~dp0hub\saias-hub.js" --open %*
set "SAIAS_EXIT=%errorlevel%"
if not "%SAIAS_EXIT%"=="0" pause
exit /b %SAIAS_EXIT%
