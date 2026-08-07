<#
.SYNOPSIS
  Runs the SuisuiNavi desktop application from source (no build required).

.DESCRIPTION
  The development equivalent of double-clicking SuisuiNavi.exe: starts the
  same launcher, backend and WebView window straight from the checkout, so a
  frontend or backend change can be tested without a 1-2 minute PyInstaller
  build.

  Starts in Preview mode. Never opens COM10 and never connects to an aircraft.

.PARAMETER Mode
  preview (default) | sitl | real. Real permits the operator to open a serial
  link from the UI; it never opens one automatically.

.PARAMETER Dev
  Development build: DevTools enabled and DEBUG logging.

.PARAMETER Diagnostics
  Print the diagnostics report and exit without opening a window.

.PARAMETER NoWindow
  Start the backend and hold it open without a window (smoke testing).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\run-desktop.ps1 -Dev
#>
[CmdletBinding()]
param(
    [ValidateSet("preview", "sitl", "real")]
    [string]$Mode = "preview",
    [switch]$Dev,
    [switch]$Diagnostics,
    [switch]$NoWindow
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$venvPython = Join-Path $repoRoot ".venv\Scripts\python.exe"

if (-not (Test-Path $venvPython)) {
    Write-Error "Virtual environment not found at $venvPython. Run 'npm run backend:setup' first."
    exit 1
}

if ($Mode -eq "real") {
    Write-Host ""
    Write-Host "  REAL mode requested." -ForegroundColor Yellow
    Write-Host "  The application still starts DISCONNECTED and read-only."
    Write-Host "  Opening COM10 remains an explicit action in the UI."
    Write-Host "  Confirm QGroundControl is closed and the propellers are removed before connecting."
    Write-Host ""
}

$arguments = @("-m", "desktop.launcher", "--mode", $Mode)
if ($Dev)         { $arguments += "--dev" }
if ($Diagnostics) { $arguments += "--diagnostics" }
if ($NoWindow)    { $arguments += "--no-window" }

Push-Location $repoRoot
try {
    # `app.*` lives under backend/, `desktop.*` at the repository root.
    $env:PYTHONPATH = "$repoRoot;$repoRoot\backend"
    & $venvPython @arguments
    $exitCode = $LASTEXITCODE
} finally {
    Pop-Location
    Remove-Item Env:\PYTHONPATH -ErrorAction SilentlyContinue
}

exit $exitCode
