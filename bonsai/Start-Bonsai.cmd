@echo off
setlocal

rem Adapted from D:\LLM\bonsai2\start-bonsai.cmd for Bonsai 2 27B on the RTX 4070.
rem Preserve the 64K context, Q8 KV cache, vision projector, and sampling settings.
if not defined SAI_BONSAI_HOME (
    set "SAI_BONSAI_HOME=%LOCALAPPDATA%\Bonsai2"
    if not exist "%LOCALAPPDATA%\Bonsai2\bin\llama-server.exe" if exist "D:\LLM\bonsai2\bin\llama-server.exe" (
        set "SAI_BONSAI_HOME=D:\LLM\bonsai2"
    )
)
if not defined BONSAI_CTX set "BONSAI_CTX=65536"
if not defined BONSAI_EFFORT set "BONSAI_EFFORT=medium"

set "BONSAI_SERVER=%SAI_BONSAI_HOME%\bin\llama-server.exe"
set "BONSAI_MODEL=%SAI_BONSAI_HOME%\models\Ternary-Bonsai-2-27B-PTQ1_0.gguf"
set "BONSAI_PROJECTOR=%SAI_BONSAI_HOME%\models\Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf"
for %%F in ("%BONSAI_SERVER%" "%BONSAI_MODEL%" "%BONSAI_PROJECTOR%") do if not exist "%%~F" (
    echo sai-smart asset missing: "%%~F"
    echo Set SAI_BONSAI_HOME to your PrismML runtime and model directory.
    exit /b 1
)

echo sai-smart - Bonsai 2 27B - http://127.0.0.1:8080
"%BONSAI_SERVER%" ^
    -m "%BONSAI_MODEL%" ^
    --mmproj "%BONSAI_PROJECTOR%" ^
    --alias sai-smart,bonsai-2-27b ^
    --host 127.0.0.1 --port 8080 ^
    -ngl 99 -fa on -c "%BONSAI_CTX%" -ctk q8_0 -ctv q8_0 ^
    -np 1 --cache-ram 16384 ^
    --jinja --no-reasoning-preserve ^
    --temp 1.0 --top-p 0.95 --top-k 20 --min-p 0.05 ^
    --chat-template-kwargs "{\"reasoning_effort\":\"%BONSAI_EFFORT%\"}"
exit /b %errorlevel%
