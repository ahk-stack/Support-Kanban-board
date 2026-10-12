<#
  Project runner: does the project runs people queue from QT-Tools -> Projects.

  The board never calls a model and needs no Anthropic API key. Pressing Run
  queues the job; this script, left running on an always-on PC, notices it and
  hands it to Claude Code, which claims it over the support board connector,
  does the work with its own tools, and posts the answer back to the board.

  Runs count against the Claude account signed in to Claude Code on this PC.

  One-time setup on the runner PC:
    1. Install Claude Code and sign in:            claude   (then /login)
    2. Add the board connector for every folder:
         claude mcp add --scope user --transport http support-kanban https://support-preprod.gotogo.im/mcp --header "Authorization: Bearer <token>"
       (token: Kanban -> Profile -> Claude connector -> Generate token)
       It has to be the board's own /mcp, as above: the separate mcp-server
       only carries the ticket tools, not the project ones.
    3. Optional: add any other MCP server a project needs (e.g. the Quinta
       tools) the same way, and list it in -AllowedTools.

  Start it:
    $env:KANBAN_MCP_TOKEN = "<the same token>"
    .\scripts\project-runner.ps1 -BoardUrl https://support-preprod.gotogo.im

  Checking the queue is a plain HTTP call, so an empty queue costs nothing:
  Claude is only started when a run is actually waiting.
#>
param(
  [string]$BoardUrl = "https://support-preprod.gotogo.im",
  [string]$Token = $env:KANBAN_MCP_TOKEN,
  # The name the board connector was added under in step 2.
  [string]$McpName = "support-kanban",
  # What Claude may use without asking. Nobody is there to approve a prompt,
  # so anything not listed is refused. Add e.g. "mcp__quinta" for the Quinta tools.
  [string[]]$AllowedTools = @("WebSearch", "WebFetch"),
  [int]$IntervalSeconds = 20
)

$ErrorActionPreference = "Stop"

if (-not $Token) {
  Write-Host "Set KANBAN_MCP_TOKEN (or pass -Token) to your board connector token." -ForegroundColor Red
  exit 1
}
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Host "Claude Code is not installed on this PC (no 'claude' command)." -ForegroundColor Red
  exit 1
}

$queueUrl = "$($BoardUrl.TrimEnd('/'))/api/mcp/project-runs/queued"
$headers = @{ Authorization = "Bearer $Token" }
$tools = @("mcp__$McpName") + $AllowedTools

Write-Host "Watching $queueUrl every $IntervalSeconds s. Ctrl+C to stop."

while ($true) {
  try {
    $queue = Invoke-RestMethod -Uri $queueUrl -Headers $headers -Method Get
    foreach ($run in @($queue.runs)) {
      if (-not $run) { continue }
      Write-Host ("[{0}] Run {1} - {2} (asked by {3})" -f (Get-Date -Format "HH:mm:ss"), $run.runId, $run.project, $run.requestedBy) -ForegroundColor Cyan
      # One run at a time. The claim on the board is atomic, so a second runner
      # (or a person in claude.ai) taking the same run just makes this one
      # report that it is already taken.
      & claude -p $run.prompt --allowedTools ($tools -join ",")
      Write-Host ("[{0}] Run {1} finished (exit {2})." -f (Get-Date -Format "HH:mm:ss"), $run.runId, $LASTEXITCODE)
    }
  } catch {
    Write-Host ("[{0}] Queue check failed: {1}" -f (Get-Date -Format "HH:mm:ss"), $_.Exception.Message) -ForegroundColor Yellow
  }
  Start-Sleep -Seconds $IntervalSeconds
}
