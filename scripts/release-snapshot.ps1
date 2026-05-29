param(
  [Parameter(Mandatory=$true)][string]$Version,
  [string]$Message = "release snapshot"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if(-not (Test-Path ".git")){
  throw "Git repository not found."
}

npm run backup:create --silent -- -Note "release:$Version" | Out-Null

git add -A
if(-not [string]::IsNullOrWhiteSpace((git status --porcelain))){
  git commit -m "release($Version): $Message"
}

git tag -a "v$Version" -m "Release $Version"
Write-Host "Release snapshot prepared: commit + tag v$Version"
Write-Host "Next: git push origin main --follow-tags"
