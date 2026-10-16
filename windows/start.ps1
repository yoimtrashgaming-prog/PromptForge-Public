# Start PromptForge on Windows with no console window, then open the browser.
#
# The "PromptForge" shortcut runs this (windows/make-shortcuts.ps1 makes it).
# If the server is already running it only opens the browser, so the shortcut
# is safe to click any number of times.
#
# Why this exists: start.bat keeps a console window open for as long as the
# server runs, and closing it stops the server. That suits a dev box, not
# someone who just wants the app. Here node runs hidden, its output goes to
# logs/ (with no window, a crash would otherwise vanish without a trace), and
# its process ID goes to data/promptforge.pid so windows/stop.ps1 stops
# exactly this server and nothing else.
#
# ASCII only: Windows PowerShell 5.1 reads a file without a BOM as ANSI.

# -NoBrowser: start (or confirm it is running) without opening a tab. The
# sign-in shortcut uses it, so logging in to Windows does not open a browser.
param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$port = if ($env:PROMPTFORGE_PORT) { $env:PROMPTFORGE_PORT } else { '8090' }
$pidFile = Join-Path $root 'data\promptforge.pid'
$logDir = Join-Path $root 'logs'

# Any HTTP reply means a server is up: signed out, / is the login page, and
# even an error status proves something is listening. 127.0.0.1 rather than
# localhost for the probe, because localhost tries IPv6 first and the server
# listens on IPv4 (see start.bat).
function Test-Up {
  try {
    Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 2 | Out-Null
    return $true
  } catch [System.Net.WebException] {
    return $null -ne $_.Exception.Response
  } catch {
    return $false
  }
}

function Show-Error($text) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show($text, 'PromptForge') | Out-Null
}

if (-not (Test-Up)) {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    Show-Error "Node.js was not found. Install Node 22 or newer from nodejs.org, then try again."
    exit 1
  }
  New-Item -ItemType Directory -Force -Path $logDir, (Split-Path $pidFile) | Out-Null
  $proc = Start-Process -FilePath $node.Source -ArgumentList 'server.mjs' -WorkingDirectory $root `
    -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $logDir 'server.log') `
    -RedirectStandardError (Join-Path $logDir 'server-error.log')
  Set-Content -Path $pidFile -Value $proc.Id -Encoding ascii

  # The first start is the slow one: the tag database loads. About a minute
  # before giving up, and if the process died, say where to look.
  $up = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    if ($proc.HasExited) { break }
    if (Test-Up) { $up = $true; break }
  }
  if (-not $up) {
    $why = if ($proc.HasExited) { 'PromptForge stopped while starting.' } else { 'PromptForge did not answer within a minute.' }
    Show-Error "$why`n`nThe reason is in logs\server-error.log and logs\server.log in the PromptForge folder."
    exit 1
  }
}

# localhost for the browser: the sign-in cookie belongs to that name.
if (-not $NoBrowser) { Start-Process "http://localhost:$port" }
