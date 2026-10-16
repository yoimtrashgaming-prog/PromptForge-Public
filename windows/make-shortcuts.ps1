# Make the Windows shortcuts: "PromptForge" (start it, no console window, and
# open the browser) and "Stop PromptForge", on the desktop and in the Start
# menu.
#
#   powershell -ExecutionPolicy Bypass -File windows\make-shortcuts.ps1
#   ... -Startup   also start PromptForge when you sign in to Windows
#   ... -Remove    take every shortcut this made away again
#
# Each shortcut runs PowerShell minimised and hidden, so at most a taskbar
# button blinks for a moment; the server itself never has a window. See
# windows/start.ps1 and windows/stop.ps1.
#
# ASCII only: Windows PowerShell 5.1 reads a file without a BOM as ANSI.

param([switch]$Startup, [switch]$Remove)

$root = Split-Path -Parent $PSScriptRoot
$shell = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'PromptForge'
$startupDir = [Environment]::GetFolderPath('Startup')

$made = @(
  (Join-Path $desktop 'PromptForge.lnk'),
  (Join-Path $desktop 'Stop PromptForge.lnk'),
  (Join-Path $menu 'PromptForge.lnk'),
  (Join-Path $menu 'Stop PromptForge.lnk'),
  (Join-Path $startupDir 'PromptForge.lnk')
)

if ($Remove) {
  foreach ($p in $made) { if (Test-Path $p) { Remove-Item $p -Force; Write-Host "removed $p" } }
  if ((Test-Path $menu) -and -not (Get-ChildItem $menu)) { Remove-Item $menu }
  exit 0
}

$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source

function New-Shortcut($path, $script, $description, $extra = '') {
  New-Item -ItemType Directory -Force -Path (Split-Path $path) | Out-Null
  $lnk = $shell.CreateShortcut($path)
  $lnk.TargetPath = $ps
  $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $root "windows\$script")`" $extra".Trim()
  $lnk.WorkingDirectory = $root
  $lnk.WindowStyle = 7   # minimised
  $lnk.Description = $description
  if ($node) { $lnk.IconLocation = "$node,0" }
  $lnk.Save()
  Write-Host "made $path"
}

New-Shortcut (Join-Path $desktop 'PromptForge.lnk') 'start.ps1' 'Start PromptForge and open it in the browser'
New-Shortcut (Join-Path $desktop 'Stop PromptForge.lnk') 'stop.ps1' 'Stop the PromptForge server'
New-Shortcut (Join-Path $menu 'PromptForge.lnk') 'start.ps1' 'Start PromptForge and open it in the browser'
New-Shortcut (Join-Path $menu 'Stop PromptForge.lnk') 'stop.ps1' 'Stop the PromptForge server'
if ($Startup) {
  # No browser tab at sign-in; the desktop shortcut opens one when wanted.
  New-Shortcut (Join-Path $startupDir 'PromptForge.lnk') 'start.ps1' 'Start PromptForge when you sign in' '-NoBrowser'
}
