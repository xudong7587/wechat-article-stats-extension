param(
    [string]$ProjectDir = $PSScriptRoot,
    [int]$Port = 8765
)

$ErrorActionPreference = "Stop"
Set-Location $ProjectDir

$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existing) {
    exit 0
}

$logDir = Join-Path $ProjectDir "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

Start-Process `
    -FilePath "py" `
    -ArgumentList @("-3", "gui.py", "--port", "$Port", "--no-open") `
    -WorkingDirectory $ProjectDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir "service.out.log") `
    -RedirectStandardError (Join-Path $logDir "service.err.log")
