# Builds dist\SAIAS-Setup-<version>.exe: compiles the SAIAS app, then packages it with Inno Setup 6.
# Requirements: CMake and a C++20 compiler, Inno Setup 6 (https://jrsoftware.org/isinfo.php).
# Optional signing: set SAIAS_SIGN_CERT to a certificate thumbprint in the user store; signtool
# (Windows SDK) then signs SAIAS.exe and the installer.
param(
    [string]$BuildDir = 'build-release'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
Write-Host "SAIAS $version"

# 1. The Windows app (SAIAS.exe and pdfium.dll).
cmake -S SAIAS-LLM -B $BuildDir -DCMAKE_BUILD_TYPE=Release
if ($LASTEXITCODE) { throw 'CMake configuration failed.' }
cmake --build $BuildDir --config Release
if ($LASTEXITCODE) { throw 'The SAIAS app did not build.' }
$exe = @("$BuildDir\SAIAS.exe", "$BuildDir\Release\SAIAS.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) { throw "SAIAS.exe not found in $BuildDir." }
$appBuild = (Resolve-Path (Split-Path $exe)).Path

function Invoke-Sign($file) {
    if (-not $env:SAIAS_SIGN_CERT) { return }
    $signtool = Get-Command signtool -ErrorAction SilentlyContinue
    if (-not $signtool) { throw 'SAIAS_SIGN_CERT is set but signtool was not found (install the Windows SDK).' }
    & $signtool.Source sign /sha1 $env:SAIAS_SIGN_CERT /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 $file
    if ($LASTEXITCODE) { throw "Signing failed: $file" }
}
Invoke-Sign "$appBuild\SAIAS.exe"

# 2. The installer.
$iscc = @($env:ISCC, (Get-Command iscc -ErrorAction SilentlyContinue).Source,
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe") | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $iscc) { throw 'Inno Setup 6 was not found. Install it (winget install JRSoftware.InnoSetup) or set ISCC to ISCC.exe.' }
& $iscc "/DAppVersion=$version" "/DAppBuild=$appBuild" installer\saias.iss
if ($LASTEXITCODE) { throw 'Inno Setup failed.' }
$setup = "dist\SAIAS-Setup-$version.exe"
Invoke-Sign $setup
if (-not $env:SAIAS_SIGN_CERT) { Write-Warning 'The installer is not signed: Windows SmartScreen will warn users.' }
Write-Host "Installer: $(Resolve-Path $setup)"
