# Installs the AgentConnect desktop daemon prototype for the current Windows user (no admin rights needed).
param(
  [string]$Client = 'claude',
  [string]$ListenHost = '0.0.0.0',
  [int]$Port = 7681,
  [switch]$Autostart
)
$ErrorActionPreference = 'Stop'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js >= 24.12 is required: https://nodejs.org/ (or: winget install OpenJS.NodeJS)' }
$version = [version]((& node -p 'process.versions.node').Trim())
if ($version -lt [version]'24.12.0') { throw "Node.js >= 24.12 is required, found $version" }

$installDir = Join-Path $env:LOCALAPPDATA 'AgentConnect\desktop\app'
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Copy-Item -Force (Join-Path $PSScriptRoot 'agentconnect-desktop.mjs') $installDir
Copy-Item -Force (Join-Path $PSScriptRoot 'README.md') $installDir -ErrorAction SilentlyContinue
$script = Join-Path $installDir 'agentconnect-desktop.mjs'

# setup downloads Cua Driver and ffmpeg, adds the firewall rule (one administrator prompt) and runs doctor.
& node $script setup --client $Client --host $ListenHost --port $Port
if ($Autostart) { & node $script autostart enable }

Write-Host ''
Write-Host "Start the daemon in this desktop session:  node `"$script`" run"
if (-not $Autostart) { Write-Host "Start it at every logon:                   node `"$script`" autostart enable" }
