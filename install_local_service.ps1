param(
    [string]$ProjectDir = $PSScriptRoot,
    [int]$Port = 8765
)

$ErrorActionPreference = "Stop"

$taskName = "WeChatStatsLocalService"
$scriptPath = Join-Path $ProjectDir "start_service.ps1"

if (-not (Test-Path $scriptPath)) {
    throw "未找到后台启动脚本：$scriptPath"
}

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`" -ProjectDir `"$ProjectDir`" -Port $Port"

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "WeChat stats local companion service for Edge extension." `
    -Force | Out-Null

& $scriptPath -ProjectDir $ProjectDir -Port $Port

Write-Host "Installed and started local companion service: $taskName"
Write-Host "Service URL: http://127.0.0.1:$Port/"
