<#
.SYNOPSIS
  Installs and configures SAIAS-LLM: llama.cpp runtimes, models, web search, Hermes.

.DESCRIPTION
  Safe to run again: complete files are kept and an interrupted download resumes
  where it stopped.

.EXAMPLE
  .\Install-SAIAS.cmd                         # interactive, recommended profiles by default
  .\Install-SAIAS.cmd -Profiles flash,smart -Yes
  .\Install-SAIAS.cmd -Check                  # report the state without installing anything
#>
[CmdletBinding()]
param(
    [string[]]$Profiles, # flash, smart, pro (comma-separated)
    [switch]$Yes,
    [switch]$NoHermes,
    [switch]$NoShortcut,
    [switch]$Check
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$Root = Split-Path $PSScriptRoot -Parent
$InklingHome = Join-Path $env:LOCALAPPDATA 'Inkling2Mini'
$AppData = Join-Path $env:LOCALAPPDATA 'SAIAS-LLM'
$Downloads = Join-Path $AppData 'Downloads'

function Write-Step($text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "  [ok] $text" -ForegroundColor Green }
function Write-Todo($text) { Write-Host "  [..] $text" -ForegroundColor Yellow }
function Write-Bad($text) { Write-Host "  [!!] $text" -ForegroundColor Red }
function Format-Size([double]$bytes) { if ($bytes -ge 1GB) { '{0:N1} GB' -f ($bytes / 1GB) } else { '{0:N0} MB' -f ($bytes / 1MB) } }

function Read-YesNo($question, [bool]$default = $true) {
    if ($Yes) { return $default }
    $hint = if ($default) { '[Y/n]' } else { '[y/N]' }
    $answer = Read-Host "$question $hint"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
    return $answer -match '^(y|yes)$'
}

function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
}

# ---------------------------------------------------------------- hardware

Write-Step 'Hardware'
if (-not [Environment]::Is64BitOperatingSystem) { throw 'SAIAS-LLM requires 64-bit Windows.' }
$ramGB = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
$nvidia = $null
$smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($smi) {
    $line = & $smi.Source '--query-gpu=name,memory.total' '--format=csv,noheader,nounits' 2>$null | Select-Object -First 1
    if ($line) {
        $parts = $line -split ',\s*'
        $nvidia = [pscustomobject]@{ Name = $parts[0]; VramGB = [math]::Round([double]$parts[1] / 1024) }
    }
}
$gpuNames = (Get-CimInstance Win32_VideoController | ForEach-Object Name) -join ', '
Write-Host "  RAM: $ramGB GB"
Write-Host "  GPU: $gpuNames"
if ($nvidia) { Write-Host "  NVIDIA: $($nvidia.Name), $($nvidia.VramGB) GB VRAM" }
$drive = Get-PSDrive -Name ($env:LOCALAPPDATA.Substring(0, 1))
Write-Host "  Free space on $($drive.Name):: $(Format-Size $drive.Free)"

# ---------------------------------------------------------------- Bonsai home (same rules as bonsai\Start-Bonsai.cmd)

$BonsaiHome = $env:SAIAS_BONSAI_HOME
if (-not $BonsaiHome) {
    $BonsaiHome = Join-Path $env:LOCALAPPDATA 'Bonsai2'
    if (-not (Test-Path (Join-Path $BonsaiHome 'bin\llama-server.exe')) -and (Test-Path 'D:\LLM\bonsai2\bin\llama-server.exe')) {
        $BonsaiHome = 'D:\LLM\bonsai2'
    }
}

# ---------------------------------------------------------------- file catalog

$prism = 'https://github.com/PrismML-Eng/llama.cpp/releases/download/prism-b12128-d7b2896'
$bonsaiRuntime = if ($nvidia) {
    @(
        @{ Name = 'PrismML CUDA runtime (Bonsai)'; Url = "$prism/llama-prism-b12128-d7b2896-bin-win-cuda-12.4-x64.zip"; Size = 355011546; Zip = Join-Path $BonsaiHome 'bin'; Marker = 'llama-server.exe' },
        @{ Name = 'CUDA 12.4 runtime (Bonsai)'; Url = "$prism/cudart-llama-bin-win-cuda-12.4-x64.zip"; Size = 391443627; Zip = Join-Path $BonsaiHome 'bin'; Marker = 'cudart64_12.dll' }
    )
} else {
    @(@{ Name = 'PrismML Vulkan runtime (Bonsai)'; Url = "$prism/llama-prism-b12128-d7b2896-bin-win-vulkan-x64.zip"; Size = 28692091; Zip = Join-Path $BonsaiHome 'bin'; Marker = 'llama-server.exe' })
}
$hfInkling = 'https://huggingface.co/unsloth/Inkling-2-Mini-GGUF/resolve/45fd08764f2b0bf16b03a5483a80e5c7aaec8772'
$hfBonsai = 'https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf/resolve/main'

$Catalog = [ordered]@{
    flash = @{
        Title = 'saias-flash'; Desc = 'LFM3 1.7B, fast, any hardware (+ Llama Chat UI)'
        Files = @(
            @{ Name = 'Unsloth Vulkan runtime (router + Llama Chat)'; Url = 'https://github.com/unslothai/llama.cpp/releases/download/b12588-mix-c0c3de8/app-b12588-mix-c0c3de8-windows-x64-vulkan.zip'; Size = 28561269; Zip = Join-Path $InklingHome 'unsloth-vulkan'; Marker = 'llama-server.exe' },
            @{ Name = 'LFM3-1.7B Q4_K_M model'; Url = 'https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF/resolve/cd0c74c575b5c416f3011b5b4c298077f26ca8c2/LFM3-1.7B-Q4_K_M.gguf'; Size = 1099627808; Path = Join-Path $InklingHome 'models\LFM3-1.7B-Q4_K_M.gguf' }
        )
    }
    smart = @{
        Title = 'saias-smart'; Desc = 'Bonsai 2 27B ternary, images, 200k context'
        Files = $bonsaiRuntime + @(
            @{ Name = 'Bonsai 2 27B PTQ1_0 model'; Url = "$hfBonsai/Ternary-Bonsai-2-27B-PTQ1_0.gguf"; Size = 5946648928; Path = Join-Path $BonsaiHome 'models\Ternary-Bonsai-2-27B-PTQ1_0.gguf' },
            @{ Name = 'Bonsai image projector'; Url = "$hfBonsai/Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf"; Size = 629246976; Path = Join-Path $BonsaiHome 'models\Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf' }
        )
    }
    pro = @{
        Title = 'saias-pro'; Desc = 'Inkling 2 Mini Q4_K_XL, most capable, 500k context (NVIDIA)'
        Files = @(
            @{ Name = 'Unsloth CUDA runtime (Inkling)'; Url = 'https://github.com/unslothai/llama.cpp/releases/download/b12631-mix-acc0843/app-b12631-mix-acc0843-windows-x64-cuda12-portable.zip'; Size = 471886549; Zip = Join-Path $InklingHome 'unsloth-cuda'; Marker = 'llama-server.exe' },
            @{ Name = 'Inkling 2 Mini UD-Q4_K_XL model'; Url = "$hfInkling/Inkling-2-Mini-UD-Q4_K_XL.gguf"; Size = 17629759456; Path = Join-Path $InklingHome 'models\Inkling-2-Mini-UD-Q4_K_XL.gguf' },
            @{ Name = 'Inkling image projector'; Url = "$hfInkling/mmproj-F16.gguf"; Size = 639348160; Path = Join-Path $InklingHome 'models\mmproj-F16.gguf' }
        )
    }
}

function Test-Installed($file) {
    if ($file.Zip) { return Test-Path (Join-Path $file.Zip $file.Marker) }
    return (Test-Path $file.Path) -and ((Get-Item $file.Path).Length -eq $file.Size)
}

function Get-MissingBytes($key) {
    $sum = 0
    foreach ($f in $Catalog[$key].Files) { if (-not (Test-Installed $f)) { $sum += $f.Size } }
    return $sum
}

# ---------------------------------------------------------------- profile selection

Write-Step 'Profiles'
$recommended = @('flash')
if ($nvidia -and $nvidia.VramGB -ge 8) { $recommended += 'smart' } elseif (-not $nvidia -and $ramGB -ge 16) { $recommended += 'smart' }
if ($nvidia -and $nvidia.VramGB -ge 8 -and $ramGB -ge 32) { $recommended += 'pro' }

foreach ($key in $Catalog.Keys) {
    $p = $Catalog[$key]
    $missing = Get-MissingBytes $key
    $state = if ($missing -eq 0) { 'installed' } else { "to download: $(Format-Size $missing)" }
    $mark = if ($recommended -contains $key) { '(recommended)' } else { '' }
    $available = $key -ne 'pro' -or $nvidia
    if (-not $available) { $state = 'requires an NVIDIA GPU' }
    Write-Host ('  {0,-10} {1,-62} {2} {3}' -f $p.Title, $p.Desc, $state, $mark)
}

$installed = @($Catalog.Keys | Where-Object { (Get-MissingBytes $_) -eq 0 })
if (-not $Profiles) {
    $default = @($recommended + $installed | Select-Object -Unique)
    if ($Yes -or $Check) {
        $Profiles = $default
    } else {
        $answer = Read-Host "Profiles to install, comma-separated (Enter = $($default -join ','))"
        $Profiles = if ([string]::IsNullOrWhiteSpace($answer)) { $default } else { $answer -split '[,; ]+' | Where-Object { $_ } | ForEach-Object { $_.Trim().ToLower() } }
    }
}
$Profiles = @($Profiles | ForEach-Object { $_ -split '[,; ]+' } | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $Catalog.Contains($_) } | Select-Object -Unique)
if ($Profiles -notcontains 'flash') { $Profiles = @('flash') + $Profiles } # the saias-flash router serves Llama Chat
if ($Profiles -contains 'pro' -and -not $nvidia) { Write-Bad 'Skipping saias-pro: no NVIDIA GPU.'; $Profiles = @($Profiles | Where-Object { $_ -ne 'pro' }) }
Write-Host "  Selected: $($Profiles -join ', ')"

$need = 0
foreach ($p in $Profiles) { $need += Get-MissingBytes $p }
if ($need -gt 0) {
    Write-Host "  Total download: $(Format-Size $need)"
    if ($need * 2 -gt $drive.Free) { Write-Bad "Disk space on $($drive.Name): is probably too low (runtime archives need about twice their size while extracting)." }
}

# ---------------------------------------------------------------- Node.js

Write-Step 'Node.js (SAIAS hub and web search)'
function Get-NodeMajor {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { return 0 }
    $v = & $node.Source --version 2>$null
    if ($v -match '^v(\d+)') { return [int]$Matches[1] }
    return 0
}
$nodeMajor = Get-NodeMajor
if ($nodeMajor -ge 22) {
    Write-Ok "Node.js v$nodeMajor"
} elseif ($Check) {
    Write-Todo 'Node.js 22 or later needs to be installed'
} else {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) { throw 'Node.js 22+ is required and winget is not available. Install Node.js LTS from https://nodejs.org and run the installer again.' }
    Write-Todo 'Installing Node.js LTS with winget'
    & $winget.Source install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
    Update-SessionPath
    $nodeMajor = Get-NodeMajor
    if ($nodeMajor -lt 22) { throw 'Node.js could not be installed. Install Node.js LTS from https://nodejs.org and run the installer again.' }
    Write-Ok "Node.js v$nodeMajor"
}

# ---------------------------------------------------------------- downloads

function Invoke-Download($file, $target) {
    New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
    if ((Test-Path $target) -and (Get-Item $target).Length -eq $file.Size) { return }
    $part = "$target.part"
    if ((Test-Path $target) -and -not (Test-Path $part)) { Move-Item $target $part } # incomplete file: resume it
    Write-Host "  -> $($file.Name) ($(Format-Size $file.Size))"
    for ($try = 1; $try -le 5; $try++) {
        & curl.exe -L --fail --retry 3 --retry-delay 5 -C - -o $part $file.Url
        if ((Test-Path $part) -and (Get-Item $part).Length -eq $file.Size) { break }
        if ((Test-Path $part) -and (Get-Item $part).Length -gt $file.Size) { Remove-Item $part }
        Write-Todo "Retrying ($try/5)..."
        Start-Sleep -Seconds 5
    }
    if (-not (Test-Path $part) -or (Get-Item $part).Length -ne $file.Size) { throw "Incomplete download: $($file.Url)" }
    Move-Item -Force $part $target
}

function Expand-Runtime($zipPath, $dest) {
    $tmp = Join-Path $Downloads ('x-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $tmp, $dest | Out-Null
    & tar.exe -xf $zipPath -C $tmp
    if ($LASTEXITCODE -ne 0) { Expand-Archive -Path $zipPath -DestinationPath $tmp -Force }
    # archives may wrap the binaries in a subfolder: copy the folder that holds the exe/dll files
    $inner = Get-ChildItem $tmp -Recurse -File -Include 'llama-server.exe', '*.dll' | Select-Object -First 1
    $src = if ($inner) { $inner.DirectoryName } else { $tmp }
    Get-ChildItem $src -Force | Copy-Item -Destination $dest -Recurse -Force
    Remove-Item $tmp -Recurse -Force
}

Write-Step 'Runtimes and models'
foreach ($p in $Profiles) {
    foreach ($f in $Catalog[$p].Files) {
        if (Test-Installed $f) { Write-Ok $f.Name; continue }
        if ($Check) { Write-Todo "$($f.Name) ($(Format-Size $f.Size))"; continue }
        if ($f.Zip) {
            $zip = Join-Path $Downloads (Split-Path $f.Url -Leaf)
            Invoke-Download $f $zip
            Expand-Runtime $zip $f.Zip
            if (-not (Test-Installed $f)) { throw "$($f.Name): $($f.Marker) not found after extraction." }
            Remove-Item $zip -Force
        } else {
            Invoke-Download $f $f.Path
        }
        Write-Ok $f.Name
    }
}

# ---------------------------------------------------------------- configuration

Write-Step 'Configuration'
if (-not $Check) {
    New-Item -ItemType Directory -Force -Path $InklingHome | Out-Null
    Copy-Item (Join-Path $Root 'templates\*.jinja') $InklingHome -Force
    Write-Ok "Inkling chat templates copied to $InklingHome"
}

# saias-flash preset for this PC's GPU
$localIni = Join-Path $Root 'Saias-models.local.ini'
if (Test-Path $localIni) {
    Write-Ok 'Kept the existing Saias-models.local.ini'
} elseif (-not $Check) {
    $router = Join-Path $InklingHome 'unsloth-vulkan\llama-server.exe'
    # "  Vulkan0: NVIDIA GeForce RTX 4070 (12010 MiB, 11242 MiB free)" -> pick the device with the most memory
    $devices = @(& $router --list-devices 2>&1 | ForEach-Object { "$_" } | Where-Object { $_ -match '^\s+(Vulkan\d+):.*\((\d+) MiB' } | ForEach-Object {
            [pscustomobject]@{ Id = $Matches[1]; MiB = [int]$Matches[2] }
        } | Sort-Object MiB -Descending)
    $ini = Get-Content (Join-Path $Root 'Saias-models.local.ini.example') -Raw
    if ($devices.Count -eq 0) {
        $ini = $ini -replace '(?m)^device = Vulkan0', 'device = none' -replace '(?m)^n-gpu-layers = 99', 'n-gpu-layers = 0'
        Write-Ok 'saias-flash set to CPU (no Vulkan GPU found)'
    } else {
        $ini = $ini -replace '(?m)^device = Vulkan0', "device = $($devices[0].Id)"
        Write-Ok "saias-flash set to $($devices[0].Id) ($($devices[0].MiB) MiB)"
    }
    [IO.File]::WriteAllText($localIni, $ini, (New-Object Text.UTF8Encoding $false))
}
if ($BonsaiHome -ne (Join-Path $env:LOCALAPPDATA 'Bonsai2') -and -not $env:SAIAS_BONSAI_HOME) {
    Write-Ok "Using the Bonsai installation in $BonsaiHome"
}

# ---------------------------------------------------------------- Hermes

$defaultModel = if ($Profiles -contains 'smart') { 'saias-smart' } elseif ($Profiles -contains 'pro') { 'saias-pro' } else { 'saias-flash' }
if (-not $NoHermes) {
    Write-Step 'Hermes'
    $hermes = Get-Command hermes -ErrorAction SilentlyContinue
    if (-not $hermes -and -not $Check -and (Read-YesNo 'Hermes is not installed. Install it with the official Nous Research installer?')) {
        Invoke-Expression (Invoke-RestMethod 'https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.ps1')
        Update-SessionPath
        $hermes = Get-Command hermes -ErrorAction SilentlyContinue
    }
    if (-not $hermes) {
        Write-Todo 'Hermes not found: skipped its configuration (run this installer again after installing Hermes).'
    } else {
        $configPath = (& $hermes.Source config path 2>$null | Select-Object -Last 1).Trim()
        $python = Join-Path (Split-Path (Split-Path $hermes.Source)) 'hermes-agent\venv\Scripts\python.exe'
        if (-not (Test-Path $python)) { $python = (Get-Command python -ErrorAction SilentlyContinue).Source }
        if ($Check) {
            $hasSaias = (Test-Path $configPath) -and (Select-String -Path $configPath -Pattern '^\s+saias:\s*$' -Quiet)
            if ($hasSaias) { Write-Ok "SAIAS provider present in $configPath" } else { Write-Todo "SAIAS provider to add to $configPath" }
        } elseif (-not $configPath -or -not $python) {
            Write-Bad 'Hermes configuration not found; add the provider manually (see README).'
        } else {
            $setDefault = Read-YesNo "Make $defaultModel the default Hermes model?"
            $mcp = (Join-Path $Root 'mcp\saias-web.js') -replace '\\', '/'
            $merge = Join-Path $AppData 'hermes-merge.py'
            New-Item -ItemType Directory -Force -Path $AppData | Out-Null
            @'
import datetime, os, shutil, sys
import yaml

path, mcp_script, default_model, set_default = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1"
cfg = {}
if os.path.exists(path):
    with open(path, encoding="utf-8") as f:
        cfg = yaml.safe_load(f) or {}
    shutil.copy2(path, path + ".bak-saias-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S"))
providers = cfg.get("providers") or {}
providers["saias"] = {
    "name": "SAIAS (local)",
    "api": "http://127.0.0.1:8090/v1",
    "transport": "chat_completions",
    "discover_models": False,
    "default_model": default_model,
    "models": {
        "saias-flash": {"context_length": 262144},
        "saias-smart": {"context_length": 200000, "supports_vision": True},
        "saias-pro": {"context_length": 500000, "supports_vision": True},
    },
}
cfg["providers"] = providers
servers = cfg.get("mcp_servers") or {}
servers["saias-web"] = {"command": "node", "args": [mcp_script], "timeout": 120}
cfg["mcp_servers"] = servers
if set_default:
    cfg["model"] = {"provider": "custom:saias", "default": default_model}
with open(path, "w", encoding="utf-8") as f:
    yaml.safe_dump(cfg, f, sort_keys=True, allow_unicode=True, default_flow_style=False)
print("ok")
'@ | Set-Content -Path $merge -Encoding UTF8
            $flag = if ($setDefault) { '1' } else { '0' }
            $out = & $python $merge $configPath $mcp $defaultModel $flag 2>&1
            if ($LASTEXITCODE -ne 0) { Write-Bad "Hermes configuration failed: $out" }
            else {
                Write-Ok "Added the SAIAS provider (http://127.0.0.1:8090/v1) and web search to $configPath (backup: .bak-saias-*)"
                if ($setDefault) { Write-Ok "Default Hermes model: custom:saias / $defaultModel" }
            }
        }
    }
}

# ---------------------------------------------------------------- shortcut

if (-not $NoShortcut -and -not $Check) {
    Write-Step 'Shortcut'
    $desktop = [Environment]::GetFolderPath('Desktop')
    $lnk = Join-Path $desktop 'SAIAS.lnk'
    $shell = New-Object -ComObject WScript.Shell
    $s = $shell.CreateShortcut($lnk)
    $s.TargetPath = Join-Path $Root 'Start-SAIAS.cmd'
    $s.WorkingDirectory = $Root
    $s.IconLocation = Join-Path $Root 'SAIAS-LLM\saias-llm.ico'
    $s.Description = 'Start SAIAS-LLM (models, web search, Llama Chat)'
    $s.Save()
    Write-Ok "Created the SAIAS shortcut on the desktop"
}

# ---------------------------------------------------------------- summary

Write-Step 'Done'
if ($Check) {
    Write-Host '  Check mode: nothing was installed.'
} else {
    Write-Host '  Start SAIAS: double-click Start-SAIAS.cmd (or the SAIAS desktop shortcut).'
    Write-Host '  Llama Chat: http://127.0.0.1:8090/  (saias-flash, saias-smart, saias-pro + web search)'
    Write-Host '  Hermes:     provider custom:saias, http://127.0.0.1:8090/v1 (for example /model custom:saias:saias-smart)'
}
