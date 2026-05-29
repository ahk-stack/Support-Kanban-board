param(
  [string]$Note = "manual"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupRoot = Join-Path $root "backups"
$target = Join-Path $backupRoot "kanban-backup-$stamp"

New-Item -ItemType Directory -Force -Path $target | Out-Null

$pathsToCopy = @(
  "index.html",
  "server.js",
  "package.json",
  "package-lock.json",
  "README.md",
  "handoff.md",
  ".env.example",
  "public",
  "scripts"
)

foreach($p in $pathsToCopy){
  $src = Join-Path $root $p
  if(Test-Path $src){
    Copy-Item -Path $src -Destination (Join-Path $target $p) -Recurse -Force
  }
}

$meta = [ordered]@{
  created_at = (Get-Date).ToString("o")
  note = $Note
  machine = $env:COMPUTERNAME
  user = $env:USERNAME
}
$meta | ConvertTo-Json | Set-Content -Path (Join-Path $target "meta.json") -Encoding UTF8

# keep last 30 backups
$all = Get-ChildItem -Path $backupRoot -Directory | Sort-Object LastWriteTime -Descending
$toDelete = $all | Select-Object -Skip 30
foreach($d in $toDelete){ Remove-Item -LiteralPath $d.FullName -Recurse -Force }

Write-Host "Backup created: $target"
