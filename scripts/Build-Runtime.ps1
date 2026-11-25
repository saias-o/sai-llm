# Builds the SAIAS llama.cpp runtimes described in runtimes\build.json.
#
# The published llama.cpp b12631 builds lack three chat parser fixes that tool calls need
# (runtimes\patches). The fixes only touch the server and common code, so this script:
#   1. downloads the b12631 source, applies the patches and builds the server libraries for the
#      CPU (no CUDA or Vulkan SDK needed);
#   2. downloads each official runtime archive named in "bases" (verified by the catalog sha256)
#      and replaces the files listed in "overlay" with the patched ones;
#   3. writes dist\runtimes\<name>-<backend>-win-x64.zip and catalog-runtimes.json, the catalog
#      entries to use once the archives are published at the "release" URL.
#
# Requirements: Visual Studio 2022 with the C++ workload (cl and Ninja), CMake, Git.
# The build is CPU heavy for several minutes. Nothing is published.
param(
    [string[]]$Backend = @('cuda12', 'vulkan'),
    [string]$Out = 'dist\runtimes'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path $PSScriptRoot -Parent
$spec = Get-Content (Join-Path $root 'runtimes\build.json') -Raw | ConvertFrom-Json
$catalog = Get-Content (Join-Path $root 'catalog\catalog.json') -Raw | ConvertFrom-Json
$out = Join-Path $root $Out
$work = Join-Path $out 'work'
New-Item -ItemType Directory -Force -Path $work | Out-Null

function Get-Verified($url, $file, $sha256) {
    if (-not (Test-Path $file)) { Invoke-WebRequest $url -OutFile $file -UseBasicParsing }
    if ($sha256 -and (Get-FileHash $file -Algorithm SHA256).Hash.ToLower() -ne $sha256) {
        Remove-Item $file
        throw "Checksum mismatch: $url"
    }
}

function Invoke-Checked($exe, [string[]]$arguments) {
    & $exe @arguments
    if ($LASTEXITCODE) { throw "$exe failed ($LASTEXITCODE)" }
}

# ---------------------------------------------------------------- 1. patched server libraries

$source = Join-Path $work $spec.source.dir
if (-not (Test-Path $source)) {
    $tarball = Join-Path $work 'source.tar.gz'
    Get-Verified $spec.source.url $tarball $spec.source.sha256
    Invoke-Checked "$env:SystemRoot\System32\tar.exe" @('-xzf', $tarball, '-C', $work)
    Push-Location $source
    try {
        foreach ($patch in $spec.patches) {
            # The source archives do not ship the docs that some upstream patches also touch.
            Invoke-Checked git @('apply', '--exclude=docs/*', (Join-Path $root "runtimes\patches\$patch"))
            Write-Host "Applied $patch"
        }
    } finally { Pop-Location }
}

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw 'Visual Studio with the C++ workload was not found.' }
$build = Join-Path $work 'build'
$flags = @(
    '-S', $source, '-B', $build, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release',
    '-DCMAKE_C_COMPILER=cl', '-DCMAKE_CXX_COMPILER=cl',
    '-DBUILD_SHARED_LIBS=ON', '-DGGML_BACKEND_DL=ON', '-DGGML_NATIVE=OFF',
    '-DGGML_CUDA=OFF', '-DGGML_VULKAN=OFF', '-DGGML_CPU_ALL_VARIANTS=OFF', '-DGGML_RPC=OFF',
    '-DLLAMA_BUILD_COMMON=ON', '-DLLAMA_BUILD_TOOLS=ON', '-DLLAMA_BUILD_SERVER=ON',
    '-DLLAMA_OPENSSL=OFF', '-DLLAMA_BUILD_TESTS=OFF', '-DLLAMA_BUILD_EXAMPLES=OFF', '-DLLAMA_BUILD_APP=OFF',
    "-DLLAMA_BUILD_NUMBER=$($spec.build)", "-DLLAMA_BUILD_COMMIT=$($spec.commit)"
)
$quoted = ($flags | ForEach-Object { '"' + $_ + '"' }) -join ' '
$cmd = 'call "' + $vs + '\Common7\Tools\VsDevCmd.bat" -no_logo -arch=x64 -host_arch=x64 && cmake ' + $quoted +
    ' && cmake --build "' + $build + '" --target llama-server'
Invoke-Checked cmd.exe @('/d', '/c', $cmd)
$bin = Join-Path $build 'bin'

# ---------------------------------------------------------------- 2. overlay on the official archives

$entries = [ordered]@{}
foreach ($b in $Backend) {
    $baseId = $spec.bases.$b
    $base = $catalog.runtimes.$baseId
    if (-not $base) { throw "Unknown base runtime for ${b}: $baseId" }
    $stage = Join-Path $work "stage-$b"
    if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
    New-Item -ItemType Directory -Path $stage | Out-Null
    foreach ($archive in $base.archives) {
        $file = Join-Path $work (Split-Path $archive.url -Leaf)
        Get-Verified $archive.url $file $archive.sha256
        Invoke-Checked "$env:SystemRoot\System32\tar.exe" @('-xf', $file, '-C', $stage)
    }
    $server = Get-ChildItem $stage -Recurse -Filter $base.binary | Select-Object -First 1
    if (-not $server) { throw "$($base.binary) not found in the $baseId archives." }
    foreach ($name in $spec.overlay) {
        $patched = Join-Path $bin $name
        if (-not (Test-Path $patched)) { throw "The build did not produce $name." }
        Copy-Item $patched (Join-Path $server.DirectoryName $name) -Force
    }
    $zip = Join-Path $out "saias-llama-$($spec.name)-$b-win-x64.zip"
    if (Test-Path $zip) { Remove-Item $zip }
    Compress-Archive -Path (Join-Path $server.DirectoryName '*') -DestinationPath $zip
    $item = Get-Item $zip
    $id = "saias-$($spec.name)-$b-win-x64"
    $entries[$id] = [ordered]@{
        name = "llama.cpp $($spec.build) (SAIAS build with tool-calling fixes), $($base.backend.ToUpper())"
        platform = $base.platform
        backend = $base.backend
        build = $spec.build
        supports = $base.supports
        license = 'MIT'
        binary = $base.binary
        archives = @([ordered]@{ url = "$($spec.release)/$($item.Name)"; size = $item.Length; sha256 = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() })
    }
    Write-Host "Built $zip ($([math]::Round($item.Length / 1MB)) MB)"
}

$snippet = Join-Path $out 'catalog-runtimes.json'
$entries | ConvertTo-Json -Depth 6 | Set-Content -Path $snippet -Encoding UTF8
Write-Host "Catalog entries: $snippet"
Write-Host "Publish the archives at $($spec.release), then add the entries to catalog\catalog.json and point the variants at them."
