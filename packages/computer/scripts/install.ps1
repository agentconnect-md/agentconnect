# Installs the AgentConnect desktop daemon prototype; setup asks for administrator approval once to install the service.
param(
  [string]$Client = 'claude',
  [string]$ListenHost = '127.0.0.1',
  [int]$Port = 7681,
  # No service: the daemon runs in a console; -Autostart opens that console at logon. It cannot answer UAC prompts.
  [switch]$NoService,
  [switch]$Autostart
)
$ErrorActionPreference = 'Stop'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js >= 24.12 is required: https://nodejs.org/ (or: winget install OpenJS.NodeJS)' }
$version = [version]((& node -p 'process.versions.node').Trim())
if ($version -lt [version]'24.12.0') { throw "Node.js >= 24.12 is required, found $version" }

$installDir = Join-Path $env:LOCALAPPDATA 'AgentConnect\computer\app'
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Copy-Item -Force (Join-Path $PSScriptRoot 'agentconnect-computer.mjs') $installDir
Copy-Item -Force (Join-Path $PSScriptRoot 'README.md') $installDir -ErrorAction SilentlyContinue
$script = Join-Path $installDir 'agentconnect-computer.mjs'

# setup downloads Cua Driver and ffmpeg, installs the service (one administrator prompt) unless -NoService, then runs doctor.
$setup = @('setup', '--client', $Client, '--host', $ListenHost, '--port', $Port)
if ($NoService) { $setup += '--no-service' }
& node $script @setup
if ($NoService -and $Autostart) { & node $script autostart enable }

Write-Host ''
if (-not $NoService) {
  Write-Host "The service runs the daemon whenever you are signed in:  node `"$script`" service status | restart | stop"
} else {
  Write-Host "Start the daemon in this desktop session:  node `"$script`" run"
  if (-not $Autostart) { Write-Host "Start it at every logon:                   node `"$script`" autostart enable" }
}
