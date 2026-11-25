# Installs a private Node.js LTS (22 or later) for SAIAS in %LOCALAPPDATA%\SAIAS\node.
# The archive is verified against the SHASUMS256.txt published by nodejs.org.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$dest = Join-Path $env:LOCALAPPDATA 'SAIAS\node'
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
# Store the list first: Windows PowerShell passes a JSON array down the pipeline as one object.
$releases = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
$release = $releases |
    Where-Object { $_.lts -and [int]($_.version.TrimStart('v').Split('.')[0]) -ge 22 } |
    Select-Object -First 1
if (-not $release) { throw 'Could not find a Node.js LTS release.' }
$version = $release.version
$name = "node-$version-win-$arch"
$base = "https://nodejs.org/dist/$version"
Write-Host "Installing Node.js $version for SAIAS..."

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('saias-node-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    $zip = Join-Path $tmp "$name.zip"
    Invoke-WebRequest "$base/$name.zip" -OutFile $zip -UseBasicParsing
    $sums = [Text.Encoding]::ASCII.GetString((Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing).RawContentStream.ToArray())
    $line = $sums -split "`n" | Where-Object { $_ -match "\s$([regex]::Escape($name)).zip\s*$" } | Select-Object -First 1
    if (-not $line) { throw "No checksum published for $name.zip." }
    $expected = ($line -split '\s+')[0].ToLower()
    $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected) { throw "Node.js download failed verification ($actual, expected $expected)." }
    & tar.exe -xf $zip -C $tmp
    if ($LASTEXITCODE -ne 0) { Expand-Archive $zip -DestinationPath $tmp }
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
    Move-Item (Join-Path $tmp $name) $dest
    Write-Host "Node.js $version installed in $dest"
} finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
