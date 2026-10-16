# Stop the PromptForge server that windows/start.ps1 started.
#
# By the process ID it recorded in data/promptforge.pid, and only if that
# process is still node: never by name or pattern. Stopping "every node.exe"
# would also take down anything else running on Node, and on the Linux box a
# pattern kill once took the live service down.
#
# A server started some other way (start.bat, npm start) is not touched:
# close its window instead.
#
# ASCII only: Windows PowerShell 5.1 reads a file without a BOM as ANSI.

# -Quiet: no message box afterwards.
param([switch]$Quiet)

$root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $root 'data\promptforge.pid'

function Show-Note($text) {
  if ($Quiet) { Write-Host $text; return }
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show($text, 'PromptForge') | Out-Null
}

if (-not (Test-Path $pidFile)) {
  Show-Note 'PromptForge is not running from its shortcut, so there is nothing to stop.'
  exit 0
}

$id = [int](Get-Content $pidFile -Raw).Trim()
$proc = Get-Process -Id $id -ErrorAction SilentlyContinue
if ($proc -and $proc.ProcessName -eq 'node') {
  Stop-Process -Id $id -Force
  Remove-Item $pidFile -Force
  Show-Note 'PromptForge has stopped.'
} else {
  # The recorded process is gone, or the number now belongs to something
  # else after a restart: either way it is not ours to stop.
  Remove-Item $pidFile -Force
  Show-Note 'PromptForge was not running.'
}
