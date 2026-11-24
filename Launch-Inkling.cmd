@echo off
setlocal

if /i "%~1"=="max" goto :quantized_max
if /i "%~1"=="smart" goto :bonsai_smart

set "INKLING_HOME=%LOCALAPPDATA%\Inkling2Mini"
set "INKLING_MODEL=%INKLING_HOME%\models\Inkling-2-Mini-UD-IQ1_S.gguf"
set "INKLING_SIZE=7764291776"
set "INKLING_SERVER=%INKLING_HOME%\unsloth-cpu\llama-server.exe"
set "INKLING_ROUTER_SERVER=%INKLING_HOME%\unsloth-vulkan\llama-server.exe"
set "INKLING_TEMPLATE=%INKLING_HOME%\Inkling-2-Mini-direct.jinja"
set "INKLING_PRESETS=%~dp0Sai-models.ini"
set "INKLING_CONTEXT=10240"
set "INKLING_PORT=8080"
set "INKLING_PROFILE=Unsloth CPU, 5 experts"
set "INKLING_EXPERTS=--override-kv inkling2.expert_used_count=int:5"
set "INKLING_UBATCH=128"
if /i "%~1"=="router-local" (
    set "INKLING_PRESETS=%~dp0Sai-models.local.ini"
    set "INKLING_PORT=8082"
    goto :profiles
)
if not "%~1"=="" set "INKLING_CONTEXT=%~1"
if not "%~2"=="" set "INKLING_PORT=%~2"
if /i "%~3"=="quality" (
    set "INKLING_PROFILE=Unsloth CPU, 8 experts"
    set "INKLING_EXPERTS="
    set "INKLING_UBATCH=48"
)

if "%~1"=="" if "%~2"=="" if "%~3"=="" (
    set "INKLING_PORT=8082"
    if exist "%~dp0Sai-models.local.ini" set "INKLING_PRESETS=%~dp0Sai-models.local.ini"
    goto :profiles
)

if not exist "%INKLING_SERVER%" (
    echo Executable missing: "%INKLING_SERVER%"
    exit /b 1
)
if not exist "%INKLING_MODEL%" (
    echo Model missing: "%INKLING_MODEL%"
    exit /b 1
)
if not exist "%INKLING_TEMPLATE%" (
    echo Chat template missing: "%INKLING_TEMPLATE%"
    exit /b 1
)
for %%F in ("%INKLING_MODEL%") do if not "%%~zF"=="%INKLING_SIZE%" (
    echo The GGUF file size does not match the selected profile.
    exit /b 1
)

echo Inkling 2 Mini - http://127.0.0.1:%INKLING_PORT%
echo Profile: %INKLING_PROFILE%
echo Open this address after the model loads. Press Ctrl+C to stop the server.
"%INKLING_SERVER%" --model "%INKLING_MODEL%" ^
    --host 127.0.0.1 --port "%INKLING_PORT%" --cors-origins localhost ^
    --device none --n-gpu-layers 0 %INKLING_EXPERTS% --load-mode mmap --fit off --no-warmup --repack ^
    --ctx-size "%INKLING_CONTEXT%" --parallel 1 --cache-ram 0 --ctx-checkpoints 2 ^
    --threads 12 --threads-batch 12 --batch-size 128 --ubatch-size "%INKLING_UBATCH%" ^
    --cache-type-k q8_0 --cache-type-v q8_0 --temp 0 ^
    --chat-template-file "%INKLING_TEMPLATE%" ^
    --chat-template-kwargs "{\"reasoning_effort\":0.0}" --no-reasoning-preserve
exit /b %errorlevel%

:profiles
if not exist "%INKLING_ROUTER_SERVER%" (
    echo Vulkan executable missing: "%INKLING_ROUTER_SERVER%"
    exit /b 1
)
if not exist "%INKLING_PRESETS%" (
    echo Model presets missing: "%INKLING_PRESETS%"
    exit /b 1
)
pushd "%INKLING_HOME%" || exit /b 1
echo sai-flash - http://127.0.0.1:%INKLING_PORT%
echo Select a model in Hermes. Press Ctrl+C to stop the server.
"%INKLING_ROUTER_SERVER%" --host 127.0.0.1 --port "%INKLING_PORT%" --cors-origins localhost ^
    --models-preset "%INKLING_PRESETS%" --models-max 1
set "INKLING_EXIT=%errorlevel%"
popd
exit /b %INKLING_EXIT%

:bonsai_smart
call "%~dp0bonsai\Start-Bonsai.cmd"
exit /b %errorlevel%

:quantized_max
set "INKLING_HOME=%LOCALAPPDATA%\Inkling2Mini"
set "INKLING_SERVER=%INKLING_HOME%\unsloth-cuda\llama-server.exe"
set "INKLING_MODEL=%INKLING_HOME%\models\Inkling-2-Mini-UD-Q4_K_XL.gguf"
set "INKLING_PROJECTOR=%INKLING_HOME%\models\mmproj-F16.gguf"
set "INKLING_TEMPLATE=%~dp0templates\Inkling-2-Mini-reasoning.jinja"

for %%F in ("%INKLING_SERVER%" "%INKLING_MODEL%" "%INKLING_PROJECTOR%" "%INKLING_TEMPLATE%") do if not exist "%%~F" (
    echo sai-max asset missing: "%%~F"
    exit /b 1
)

echo sai-max - Inkling 2 Mini UD-Q4_K_XL - http://127.0.0.1:8081/v1
echo Keep this window open while using sai-max. Press Ctrl+C to stop the server.
"%INKLING_SERVER%" --model "%INKLING_MODEL%" --mmproj "%INKLING_PROJECTOR%" --alias sai-max ^
    --host 127.0.0.1 --port 8081 --cors-origins localhost ^
    --ctx-size 500000 --parallel 1 --fit on --fit-target 2048 ^
    --batch-size 512 --ubatch-size 128 --flash-attn on --cache-type-k q8_0 --cache-type-v q8_0 ^
    --jinja --chat-template-file "%INKLING_TEMPLATE%" ^
    --chat-template-kwargs "{\"reasoning_effort\":0.99}" --no-reasoning-preserve ^
    --temp 1 --top-p 1 --top-k 0 --min-p 0
exit /b %errorlevel%
