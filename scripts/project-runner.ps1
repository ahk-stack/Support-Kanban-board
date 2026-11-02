<#
  Project runner: does the project runs people queue from QT-Tools -> Projects,
  on the prod and preprod boards, with nobody pasting anything.

  The board never calls a model and needs no Anthropic API key. Pressing Run
  queues the job; this script, left running on an always-on PC, notices it and
  hands it to Claude Code, which claims it over that board's connector, does
  the work with its own tools and skills, and posts the answer back.

  Runs count against the Claude account signed in to Claude Code on this PC.
  Skills (e.g. q-data-audit) are that account's: keep them up to date there.

  Data a project needs collected first (the Q-data audit corpus) is collected
  by the board itself, server-side, before the run is queued. Claude is handed
  the data, never the gateway key - so Bash is deliberately not allowed here.

  One-time setup on the runner PC:
    1. Install Claude Code and sign in with the team account:   claude   (then /login)
       The claude.ai connectors of that account ("Support Dashboard Prod",
       "Support Dashboard Preprod", "Quinta MCP Servers PROD") are picked up
       automatically. Check with:   claude mcp list
    2. Generate a connector token on each board (Kanban -> Profile -> Claude
       connector -> Generate token) and install the runner:
         .\scripts\project-runner.ps1 -Install -ProdToken <prod token> -PreprodToken <preprod token>
       That stores the tokens in your user environment and registers a
       scheduled task that starts the runner hidden at every logon. It starts
       right away too. Logs: %LOCALAPPDATA%\kanban-runner\runner.log
    Remove it with:  .\scripts\project-runner.ps1 -Uninstall

  On your own PC instead (runs on YOUR Claude account, only the runs you queue):
    Same setup, with your own connector tokens, plus -Mine:
         .\scripts\project-runner.ps1 -Install -Mine -ProdToken <your prod token> -PreprodToken <your preprod token>
    Run on the board then goes straight to your PC - no tab, nothing to paste.
    If your PC is off or busy, the shared runner (if there is one) takes the
    run after a few minutes, and the board says who is picking it up.

  Run it in a window instead (Ctrl+C to stop):
    .\scripts\project-runner.ps1

  Checking the queue is a plain HTTP call, so an empty queue costs nothing:
  Claude is only started when a run is actually waiting.
#>
param(
  [string]$ProdUrl = $(if ($env:KANBAN_PROD_URL) { $env:KANBAN_PROD_URL } else { "https://support.gotogo.im" }),
  [string]$PreprodUrl = $(if ($env:KANBAN_PREPROD_URL) { $env:KANBAN_PREPROD_URL } else { "https://support-preprod.gotogo.im" }),
  [string]$ProdToken = $env:KANBAN_PROD_TOKEN,
  [string]$PreprodToken = $env:KANBAN_PREPROD_TOKEN,
  # The MCP server name each board's connector has in Claude Code. These are the
  # claude.ai connector names; use e.g. "support-kanban" for one added by hand
  # with `claude mcp add`.
  [string]$ProdMcp = "claude_ai_Support_Dashboard_Prod",
  [string]$PreprodMcp = "claude_ai_Support_Dashboard_Preprod",
  # What Claude may use without asking. Nobody is there to approve a prompt, so
  # anything not listed is refused. No Bash on purpose (see above).
  [string[]]$AllowedTools = @("Skill", "Read", "Write", "Glob", "Grep", "WebSearch", "WebFetch", "mcp__claude_ai_Quinta_MCP_Servers_PROD"),
  [int]$IntervalSeconds = 20,
  # A runner on someone's own PC: take only the runs this token's owner queued.
  [switch]$Mine = $($env:KANBAN_RUNNER_MINE -eq "1"),
  # Old single-board form, still accepted: -BoardUrl <url> -Token <token> -McpName <name>
  [string]$BoardUrl,
  [string]$Token = $env:KANBAN_MCP_TOKEN,
  [string]$McpName = "support-kanban",
  [switch]$Install,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$TaskName = "Kanban project runner"
$Home_ = Join-Path $env:LOCALAPPDATA "kanban-runner"
$WorkDir = Join-Path $Home_ "work"
$LogFile = Join-Path $Home_ "runner.log"

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed the '$TaskName' scheduled task. Tokens stay in your user environment (KANBAN_PROD_TOKEN, KANBAN_PREPROD_TOKEN)."
  exit 0
}

if ($Install) {
  if ($ProdToken) { [Environment]::SetEnvironmentVariable("KANBAN_PROD_TOKEN", $ProdToken, "User") }
  if ($PreprodToken) { [Environment]::SetEnvironmentVariable("KANBAN_PREPROD_TOKEN", $PreprodToken, "User") }
  if ($PSBoundParameters.ContainsKey("ProdUrl")) { [Environment]::SetEnvironmentVariable("KANBAN_PROD_URL", $ProdUrl, "User") }
  if ($PSBoundParameters.ContainsKey("PreprodUrl")) { [Environment]::SetEnvironmentVariable("KANBAN_PREPROD_URL", $PreprodUrl, "User") }
  [Environment]::SetEnvironmentVariable("KANBAN_RUNNER_MINE", $(if ($Mine) { "1" } else { $null }), "User")
  if (-not ($ProdToken -or $PreprodToken)) {
    Write-Host "Pass -ProdToken and/or -PreprodToken (Kanban -> Profile -> Claude connector -> Generate token)." -ForegroundColor Red
    exit 1
  }
  $script = $MyInvocation.MyCommand.Path
  $action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  # Restart if it dies; never stop it for running long; keep it going on battery.
  $settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "Installed and started '$TaskName'. It starts hidden at every logon. Log: $LogFile" -ForegroundColor Green
  exit 0
}

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
function Log([string]$msg, [string]$color = "Gray") {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
  Write-Host $line -ForegroundColor $color
  Add-Content -Path $LogFile -Value $line -Encoding utf8
}

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Log "Claude Code is not installed on this PC (no 'claude' command)." "Red"
  exit 1
}

$boards = @()
if ($BoardUrl) {
  $boards += @{ Name = "board"; Url = $BoardUrl; Token = $Token; Mcp = $McpName }
} else {
  if ($ProdToken) { $boards += @{ Name = "prod"; Url = $ProdUrl; Token = $ProdToken; Mcp = $ProdMcp } }
  if ($PreprodToken) { $boards += @{ Name = "preprod"; Url = $PreprodUrl; Token = $PreprodToken; Mcp = $PreprodMcp } }
}
if (-not $boards.Count -or ($boards | Where-Object { -not $_.Token })) {
  Log "No board token. Set KANBAN_PROD_TOKEN / KANBAN_PREPROD_TOKEN, or run with -Install -ProdToken ... -PreprodToken ..." "Red"
  exit 1
}
$allMcp = @($ProdMcp, $PreprodMcp, $McpName) | Select-Object -Unique

$queuePath = if ($Mine) { "/api/mcp/project-runs/queued?mine=1" } else { "/api/mcp/project-runs/queued" }
$whose = if ($Mine) { "your own runs" } else { "the shared queue" }
foreach ($b in $boards) { Log "Watching $whose on the $($b.Name) board at $($b.Url) every $IntervalSeconds s (connector mcp__$($b.Mcp))." "Green" }

while ($true) {
  foreach ($b in $boards) {
    try {
      $queue = Invoke-RestMethod -Uri "$($b.Url.TrimEnd('/'))$queuePath" -Headers @{ Authorization = "Bearer $($b.Token)" } -Method Get
      foreach ($run in @($queue.runs)) {
        if (-not $run) { continue }
        Log ("{0}: run {1} - {2} (asked by {3})" -f $b.Name, $run.runId, $run.project, $run.requestedBy) "Cyan"
        # Run ids are per board, so this run may only touch its own board's
        # connector: the other one is switched off for it.
        $allowed = @("mcp__$($b.Mcp)") + $AllowedTools
        $blocked = @($allMcp | Where-Object { $_ -ne $b.Mcp } | ForEach-Object { "mcp__$_" })
        $system = "You are running unattended for the $($b.Name) support board: nobody can answer questions or approve anything. " +
                  "Use only the mcp__$($b.Mcp) tools for the board. Always end with post_project_run (output, or error)."
        $claudeArgs = @("-p", $run.prompt, "--allowedTools", ($allowed -join ","), "--append-system-prompt", $system)
        if ($blocked.Count) { $claudeArgs += @("--disallowedTools", ($blocked -join ",")) }
        # One run at a time. The claim on the board is atomic, so a second
        # runner (or a person in claude.ai) taking the same run just makes this
        # one report that it is already taken.
        Push-Location $WorkDir
        try { & claude @claudeArgs 2>&1 | ForEach-Object { Add-Content -Path $LogFile -Value "    $_" -Encoding utf8 } }
        finally { Pop-Location }
        Log ("{0}: run {1} finished (exit {2})." -f $b.Name, $run.runId, $LASTEXITCODE)
      }
    } catch {
      Log ("{0}: queue check failed: {1}" -f $b.Name, $_.Exception.Message) "Yellow"
    }
  }
  Start-Sleep -Seconds $IntervalSeconds
}
