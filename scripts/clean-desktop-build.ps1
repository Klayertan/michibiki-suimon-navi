<#
.SYNOPSIS
  Removes SuisuiNavi desktop build artifacts.

.DESCRIPTION
  Deletes only generated output: dist\SuisuiNavi, build\, and PyInstaller's
  __pycache__ leftovers. Source files, the virtual environment, the frontend
  and user data under %LOCALAPPDATA%\SuisuiNavi are never touched.

  Use -IncludeUserData to additionally clear the local application data
  (window geometry, logs, diagnostics, gamepad calibration). That is a
  separate, explicit switch because it discards operator state.

.PARAMETER IncludeUserData
  Also remove %LOCALAPPDATA%\SuisuiNavi. Prompts before deleting.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\clean-desktop-build.ps1
#>
[CmdletBinding()]
param(
    [switch]$IncludeUserData
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

$targets = @(
    (Join-Path $repoRoot "dist\SuisuiNavi"),
    (Join-Path $repoRoot "build")
)

Write-Host "`n=== Removing build artifacts ===" -ForegroundColor Cyan
foreach ($target in $targets) {
    if (Test-Path $target) {
        # Guard against a mis-set repoRoot ever pointing the delete at a
        # source directory.
        $leaf = Split-Path -Leaf $target
        if ($leaf -notin @("SuisuiNavi", "build")) {
            Write-Warning "refusing to delete unexpected path: $target"
            continue
        }
        Remove-Item -Recurse -Force $target
        Write-Host "  removed $target" -ForegroundColor Green
    } else {
        Write-Host "  (absent) $target" -ForegroundColor DarkGray
    }
}

Write-Host "`n=== Removing __pycache__ under desktop/ and backend/ ===" -ForegroundColor Cyan
foreach ($root in @("desktop", "backend")) {
    $base = Join-Path $repoRoot $root
    if (-not (Test-Path $base)) { continue }
    Get-ChildItem -Path $base -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue |
        ForEach-Object {
            Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue
            Write-Host "  removed $($_.FullName)" -ForegroundColor Green
        }
}

if ($IncludeUserData) {
    $dataHome = Join-Path $env:LOCALAPPDATA "SuisuiNavi"
    Write-Host "`n=== User data ===" -ForegroundColor Cyan
    if (Test-Path $dataHome) {
        Write-Host "  This will delete window settings, logs, diagnostics and gamepad calibration:" -ForegroundColor Yellow
        Write-Host "    $dataHome" -ForegroundColor Yellow
        $answer = Read-Host "  Type YES to delete"
        if ($answer -eq "YES") {
            Remove-Item -Recurse -Force $dataHome
            Write-Host "  removed $dataHome" -ForegroundColor Green
        } else {
            Write-Host "  kept" -ForegroundColor Green
        }
    } else {
        Write-Host "  (absent) $dataHome" -ForegroundColor DarkGray
    }
}

Write-Host "`n  Clean complete. Rebuild with:" -ForegroundColor Green
Write-Host "    powershell -ExecutionPolicy Bypass -File .\scripts\build-windows.ps1`n"
