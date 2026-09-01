<#
  install.ps1 -- install the Tab Share shortener on Windows / Windows Server.

  Registers a Scheduled Task that runs the service at startup (and now), with
  automatic restart on failure. Run from an elevated PowerShell.

  Parameters (prompted if omitted):
    -Base    Public base URL, e.g. https://s.example.com  (default http://localhost:<Port>)
    -Hosts   Allowed target host(s), comma-separated       (default kaikayy.github.io)
    -Port    default 8779
    -Backend file | sqlite   (default sqlite if Node >= 24)
    -InstallDir  default C:\Program Files\tab-share-shortener
    -RunAsUser   account for the task (default SYSTEM)

  Re-run to update: copies current source over the install dir and restarts.

  For a "real" Windows service instead of a scheduled task, use nssm:
    nssm install TabShareShortener "C:\Program Files\nodejs\node.exe" "src\server.mjs"
    nssm set TabShareShortener AppDirectory "<InstallDir>"
    nssm set TabShareShortener AppEnvironmentExtra SHORTENER_BASE=... SHORTENER_HOSTS=...
#>
[CmdletBinding()]
param(
  [string]$Base,
  [string]$Hosts = "kaikayy.github.io",
  [int]$Port = 8779,
  [ValidateSet("file", "sqlite", "")] [string]$Backend = "",
  [string]$InstallDir = "C:\Program Files\tab-share-shortener",
  [string]$RunAsUser = "SYSTEM"
)

$ErrorActionPreference = "Stop"
$SrcDir = Split-Path -Parent $PSScriptRoot

function Need($cond, $msg) { if (-not $cond) { Write-Error $msg; exit 1 } }

# --- prerequisites ---------------------------------------------------------
$node = (Get-Command node -ErrorAction SilentlyContinue)
Need $node "Node.js not found. Install Node 20+ (24+ for the sqlite backend) and re-run."
$nodeMajor = [int]((& node -p "process.versions.node.split('.')[0]"))
Need ($nodeMajor -ge 20) "Node $(& node -v) is too old; need 20+."
Need ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
       [Security.Principal.WindowsBuiltInRole]::Administrator)) "Run this from an elevated PowerShell."

if (-not $Base)    { $Base = Read-Host "Public base URL (no trailing slash) [http://localhost:$Port]"; if (-not $Base) { $Base = "http://localhost:$Port" } }
if (-not $Backend) { $Backend = if ($nodeMajor -ge 24) { "sqlite" } else { "file" } }
Need (-not ($Backend -eq "sqlite" -and $nodeMajor -lt 24)) "sqlite backend needs Node 24+ (have $(& node -v))."

$DataDir   = Join-Path $env:ProgramData "tab-share-shortener"
$StoreExt  = if ($Backend -eq "sqlite") { "sqlite" } else { "json" }
$StorePath = Join-Path $DataDir "links.$StoreExt"
$NodeExe   = $node.Source

Write-Host ""
Write-Host "  install dir : $InstallDir"
Write-Host "  data dir    : $DataDir"
Write-Host "  base / hosts: $Base  /  $Hosts"
Write-Host "  backend     : $Backend ($StorePath)"
Write-Host "  task runs as: $RunAsUser"
Write-Host ""
if ((Read-Host "Proceed? [y/N]") -ne "y") { exit 1 }

# --- lay down files ------------------------------------------------------
New-Item -ItemType Directory -Force -Path $InstallDir, $DataDir | Out-Null
Copy-Item -Recurse -Force (Join-Path $SrcDir "src") $InstallDir
Copy-Item -Force (Join-Path $SrcDir "package.json") $InstallDir
Copy-Item -Force (Join-Path $SrcDir "LICENSE") $InstallDir

# --- wrapper cmd that carries the environment -------------------------
$cmd = @"
@echo off
set SHORTENER_HOST=127.0.0.1
set SHORTENER_PORT=$Port
set SHORTENER_BASE=$Base
set SHORTENER_HOSTS=$Hosts
set SHORTENER_STORE=$StorePath
set SHORTENER_STORE_BACKEND=$Backend
set SHORTENER_TRUST_PROXY=1
cd /d "$InstallDir"
"$NodeExe" src\server.mjs
"@
$wrapper = Join-Path $InstallDir "run-service.cmd"
Set-Content -Path $wrapper -Value $cmd -Encoding ASCII

# --- scheduled task ----------------------------------------------------
$taskName = "TabShareShortener"
Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue

$action    = New-ScheduledTaskAction -Execute $wrapper
$trigger   = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId $RunAsUser -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
             -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Description "Tab Share link shortener" | Out-Null

Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 2

try {
  Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 4 | Out-Null
  Write-Host "`n  OK -- health check passed on 127.0.0.1:$Port"
} catch {
  Write-Host "`n  started, but health check failed -- check: Get-ScheduledTask $taskName | Get-ScheduledTaskInfo"
}
Write-Host "`n  Put a TLS reverse proxy (IIS / Caddy) in front for $Base."
Write-Host "  Extension endpoint: $Base/new?url=   (or ?mode=words&url=)"
Write-Host "  Manage: Start-ScheduledTask / Stop-ScheduledTask / Unregister-ScheduledTask -TaskName $taskName"
