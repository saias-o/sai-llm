@echo off
rem Starts SAI-LLM: the sai-flash router with Llama Chat, sai-smart and sai-pro on demand, web search.
rem Llama Chat: http://127.0.0.1:8090/   Hermes and other clients: http://127.0.0.1:8090/v1
where node >/dev/null 2>/dev/null || (
    echo Node.js was not found. Run Install-SAI.cmd first.
    pause
    exit /b 1
)
title SAI-LLM
node "%~dp0hub\sai-hub.js" --open %*
set "SAI_EXIT=%errorlevel%"
if not "%SAI_EXIT%"=="0" pause
exit /b %SAI_EXIT%
