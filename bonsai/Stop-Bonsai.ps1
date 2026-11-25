[CmdletBinding(SupportsShouldProcess = $true)]
param([ValidateRange(0, 86400)][int]$DelaySeconds = 0)

$ErrorActionPreference = 'Stop'
$bonsaiRoot = $env:SAIAS_BONSAI_HOME
if (-not $bonsaiRoot) {
    $bonsaiRoot = Join-Path $env:LOCALAPPDATA 'Bonsai2'
    if (-not (Test-Path -LiteralPath (Join-Path $bonsaiRoot 'bin\llama-server.exe')) -and
        (Test-Path -LiteralPath 'D:\LLM\bonsai2\bin\llama-server.exe')) {
        $bonsaiRoot = 'D:\LLM\bonsai2'
    }
}
$serverPath = [IO.Path]::GetFullPath((Join-Path $bonsaiRoot 'bin\llama-server.exe'))
$logPath = Join-Path $PSScriptRoot 'stop-bonsai.log'
$timerMutex = $null
$locked = $false

function Write-StopLog([string]$Message) {
    $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $Message
    if (-not $WhatIfPreference) {
        Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
    }
    Write-Output $line
}

try {
    if ($DelaySeconds -gt 0 -and -not $WhatIfPreference) {
        # Share the countdown lock with the original D:\LLM launcher.
        $timerMutex = [Threading.Mutex]::new($false, 'Local\MotionUpBonsaiAutoStop')
        try { $locked = $timerMutex.WaitOne(0) }
        catch [Threading.AbandonedMutexException] { $locked = $true }
        if (-not $locked) { return }
        $deadline = [DateTime]::UtcNow.AddSeconds($DelaySeconds)
        Write-StopLog ('Bonsai will stop at ' + $deadline.ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss'))
        while ([DateTime]::UtcNow -lt $deadline) {
            $remaining = ($deadline - [DateTime]::UtcNow).TotalMilliseconds
            if ($remaining -gt 0) { Start-Sleep -Milliseconds ([int][Math]::Min(30000, [Math]::Ceiling($remaining))) }
        }
    }

    $servers = @(Get-Process -Name 'llama-server' -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -eq $serverPath })
    if ($servers.Count -eq 0) {
        Write-StopLog 'Bonsai is already stopped.'
    }
    foreach ($server in $servers) {
        if ($PSCmdlet.ShouldProcess(('PID ' + $server.Id + ' (' + $server.Path + ')'), 'Stop Bonsai 2')) {
            Stop-Process -InputObject $server
            Write-StopLog ('Bonsai stopped, PID ' + $server.Id + '.')
        }
    }
} catch {
    Write-StopLog ('ERROR: ' + $_.Exception.Message)
    exit 1
} finally {
    if ($locked) { $timerMutex.ReleaseMutex() }
    if ($null -ne $timerMutex) { $timerMutex.Dispose() }
}
