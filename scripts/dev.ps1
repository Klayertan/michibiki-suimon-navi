<#
.SYNOPSIS
  Starts the SuisuiNavi frontend and the MAVLink backend in two PowerShell windows.

.DESCRIPTION
  Convenience launcher for Windows. Defaults to mock mode so nothing touches the
  telemetry radio. Real mode is opt-in and prints the safety checklist first.

.PARAMETER Real
  Start the backend against the real serial link instead of the simulator.
  QGroundControl must be closed: it and this backend cannot share the port.

.PARAMETER Port
  Serial port for real mode. Default COM10.

.PARAMETER Baud
  Serial baud rate for real mode. Default 57600 (matches SERIAL2_BAUD).

.PARAMETER AllowSafeCommands
  Enable the safe command set (firmware version, telemetry streams, and a
  disarmed STABILIZE/ALT_HOLD mode change). Off by default: a real link starts
  read-only. Normal ARM/DISARM additionally requires enabled Manual Control,
  a fresh link and explicit UI confirmation. Takeoff remains unsupported.

.PARAMETER AllowPilotControl
  Enable bounded keyboard/calibrated-PS5 manual RC override. Off by default.
  STABILIZE and ALT_HOLD are supported; the switch never auto-arms, changes
  mode, bypasses pre-arm checks, or writes vehicle parameters. Read
  docs/PILOT_CONTROL_GUIDE.md before use.

.EXAMPLE
  .\scripts\dev.ps1
  Frontend plus the simulated aircraft.

.EXAMPLE
  .\scripts\dev.ps1 -Real -AllowSafeCommands
  Frontend plus the real COM10 link with mode changes enabled.

.EXAMPLE
  .\scripts\dev.ps1 -AllowPilotControl
  Simulated aircraft with the pilot panel available, for practising the
  key mapping with no hardware attached.
#>
[CmdletBinding()]
param(
    [switch]$Real,
    [string]$Port = "COM10",
    [int]$Baud = 57600,
    [switch]$AllowSafeCommands,
    [switch]$AllowPilotControl
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$venvPython = Join-Path $repoRoot ".venv\Scripts\python.exe"

if (-not (Test-Path $venvPython)) {
    Write-Error "Virtual environment not found. Run 'npm run backend:setup' first."
    exit 1
}

if ($Real) {
    Write-Host ""
    Write-Host "  REAL MODE — the backend will open $Port at $Baud baud." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Confirm before continuing:" -ForegroundColor Yellow
    Write-Host "    * propellers removed"
    Write-Host "    * aircraft disarmed"
    Write-Host "    * battery connected and above the low-voltage threshold"
    Write-Host "    * telemetry antennas attached to both radios"
    Write-Host "    * QGroundControl closed (it cannot share $Port)"
    Write-Host ""
    Write-Host "  Normal ARM/DISARM is available only through the gated Manual Control UI." -ForegroundColor Yellow
    Write-Host "  Takeoff and force-arm are not implemented." -ForegroundColor Yellow
    Write-Host ""
    $answer = Read-Host "  Type YES to start the real link"
    if ($answer -ne "YES") {
        Write-Host "  Cancelled. Nothing was opened." -ForegroundColor Green
        exit 0
    }
}

if ($Real -and $AllowPilotControl) {
    # Two separate confirmations on purpose. The first is about opening a
    # serial port; this one is about an aircraft that may move.
    Write-Host ""
    Write-Host "  MANUAL CONTROL — the backend will accept bounded RC override input." -ForegroundColor Red
    Write-Host ""
    Write-Host "  Use STABILIZE or ALT_HOLD; the application never switches mode automatically."
    Write-Host "  Bench enable and normal ARM are separate confirmed actions."
    Write-Host "  Dead-man, fresh telemetry, finite RC timeout, RC mapping, and ArduPilot checks remain mandatory."
    Write-Host ""
    Write-Host "  Do the bench test with PROPELLERS REMOVED first." -ForegroundColor Red
    Write-Host "  See docs/PILOT_CONTROL_GUIDE.md." -ForegroundColor Red
    Write-Host ""
    $pilotAnswer = Read-Host "  Type PILOT to enable Manual RC control"
    if ($pilotAnswer -ne "PILOT") {
        Write-Host "  Pilot control stays off. Starting read-only." -ForegroundColor Green
        $AllowPilotControl = $false
    }
}

$backendEnv = @{
    SUISUI_MAVLINK_MODE = if ($Real) { "real" } else { "mock" }
    SUISUI_MAVLINK_PORT = $Port
    SUISUI_MAVLINK_BAUD = "$Baud"
    SUISUI_MAVLINK_ALLOW_SAFE_COMMANDS = if ($AllowSafeCommands) { "1" } else { "0" }
    SUISUI_MAVLINK_ALLOW_PILOT_CONTROL = if ($AllowPilotControl) { "1" } else { "0" }
}

$assignments = ($backendEnv.GetEnumerator() | ForEach-Object { "`$env:$($_.Key)='$($_.Value)'" }) -join "; "
$backendCommand = "$assignments; Set-Location '$repoRoot\backend'; & '$venvPython' -m app.main"
$frontendCommand = "Set-Location '$repoRoot'; npm run serve"

Start-Process powershell -ArgumentList "-NoExit", "-Command", $frontendCommand
Start-Process powershell -ArgumentList "-NoExit", "-Command", $backendCommand

Write-Host ""
Write-Host "  frontend  http://localhost:4173/" -ForegroundColor Green
Write-Host "  backend   http://127.0.0.1:8787/  (mode: $($backendEnv.SUISUI_MAVLINK_MODE))" -ForegroundColor Green
Write-Host ""
Write-Host "  Close each window, or press Ctrl+C in it, to stop that process."
Write-Host "  The backend stops its heartbeat and releases the serial port on shutdown."
Write-Host ""
