$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$backupRoot = Join-Path $root "backups"

if(!(Test-Path $backupRoot)){
  Write-Host "No backups yet."
  exit 0
}

Get-ChildItem -Path $backupRoot -Directory |
  Sort-Object LastWriteTime -Descending |
  Select-Object Name, LastWriteTime |
  Format-Table -AutoSize
