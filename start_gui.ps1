param(
    [string]$ProjectDir = $PSScriptRoot,
    [int]$Port = 8765
)

$ErrorActionPreference = "Stop"
Set-Location $ProjectDir

py -3 "gui.py" --port $Port
