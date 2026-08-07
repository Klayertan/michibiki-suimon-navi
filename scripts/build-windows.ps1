<#
.SYNOPSIS
  Builds SuisuiNavi.exe (one-directory PyInstaller bundle).

.DESCRIPTION
  Verifies the virtual environment and dependencies, optionally runs the test
  suites, removes stale build output, runs PyInstaller, and confirms the
  executable exists.

  This script never opens COM10 and never connects to an aircraft. The built
  application starts in Preview mode.

.PARAMETER SkipTests
  Skip the unit/backend test run. Use only for a quick iteration build.

.PARAMETER KeepBuild
  Keep the intermediate build\ directory (useful when diagnosing a bundle
  that misses a module).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\build-windows.ps1
#>
[CmdletBinding()]
param(
    [switch]$SkipTests,
    [switch]$KeepBuild
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$venvPython = Join-Path $repoRoot ".venv\Scripts\python.exe"
$specFile = Join-Path $repoRoot "packaging\SuisuiNavi.spec"
$distDir = Join-Path $repoRoot "dist\SuisuiNavi"
$exePath = Join-Path $distDir "SuisuiNavi.exe"
$buildDir = Join-Path $repoRoot "build"

function Write-Step($message) { Write-Host "`n=== $message ===" -ForegroundColor Cyan }
function Write-Ok($message)   { Write-Host "  OK  $message" -ForegroundColor Green }
function Write-Warn($message) { Write-Host "  !   $message" -ForegroundColor Yellow }

Write-Step "1/7 Verifying the virtual environment"
if (-not (Test-Path $venvPython)) {
    Write-Error "Virtual environment not found at $venvPython. Run 'npm run backend:setup' first."
    exit 1
}
$pyVersion = & $venvPython --version
Write-Ok "$pyVersion at $venvPython"

Write-Step "2/7 Verifying build dependencies"
$required = @("PyInstaller", "webview", "fastapi", "uvicorn", "pymavlink", "serial")
$missing = @()
foreach ($module in $required) {
    & $venvPython -c "import $module" 2>$null
    if ($LASTEXITCODE -ne 0) { $missing += $module } else { Write-Ok "import $module" }
}
if ($missing.Count -gt 0) {
    Write-Error @"
Missing Python dependencies: $($missing -join ', ')

Install them into the project virtual environment:
  .venv\Scripts\python.exe -m pip install -r backend\requirements.txt
  .venv\Scripts\python.exe -m pip install pywebview pyinstaller
"@
    exit 1
}

Write-Step "3/7 Verifying frontend assets"
foreach ($asset in @("index.html", "css", "js")) {
    $path = Join-Path $repoRoot $asset
    if (-not (Test-Path $path)) {
        Write-Error "Required frontend asset '$asset' not found at $path — the bundle would be unusable."
        exit 1
    }
    Write-Ok $asset
}

Write-Step "4/7 Running tests"
if ($SkipTests) {
    Write-Warn "Skipped (-SkipTests). Do not ship a build whose tests were not run."
} else {
    Push-Location $repoRoot
    try {
        & $venvPython -m pytest backend desktop_tests -q
        if ($LASTEXITCODE -ne 0) { Write-Error "Python tests failed; build aborted."; exit 1 }
        Write-Ok "Python tests passed"

        $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
        if ($npm) {
            & npm.cmd test 2>&1 | Select-Object -Last 6
            if ($LASTEXITCODE -ne 0) { Write-Error "JavaScript unit tests failed; build aborted."; exit 1 }
            Write-Ok "JavaScript unit tests passed"
        } else {
            Write-Warn "npm not found on PATH; skipped the JavaScript unit tests"
        }
    } finally { Pop-Location }
}

Write-Step "5/7 Removing stale build output"
# Only ever the two generated directories. Source is never touched.
foreach ($stale in @($distDir, $buildDir)) {
    if (Test-Path $stale) {
        Remove-Item -Recurse -Force $stale
        Write-Ok "removed $stale"
    }
}

Write-Step "6/7 Running PyInstaller"
Push-Location $repoRoot
try {
    # backend/ must be importable as `app.*`; desktop/ as `desktop.*`.
    $env:PYTHONPATH = "$repoRoot;$repoRoot\backend"
    & $venvPython -m PyInstaller --noconfirm --clean --distpath (Join-Path $repoRoot "dist") --workpath $buildDir $specFile
    if ($LASTEXITCODE -ne 0) { Write-Error "PyInstaller failed with exit code $LASTEXITCODE"; exit 1 }
} finally {
    Pop-Location
    Remove-Item Env:\PYTHONPATH -ErrorAction SilentlyContinue
}

Write-Step "7/7 Verifying the executable"
if (-not (Test-Path $exePath)) {
    Write-Error "Build reported success but $exePath does not exist."
    exit 1
}
$exe = Get-Item $exePath
$bundleBytes = (Get-ChildItem $distDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Ok ("SuisuiNavi.exe  {0:N0} bytes ({1:N2} MB)" -f $exe.Length, ($exe.Length / 1MB))
Write-Ok ("bundle total    {0:N0} bytes ({1:N2} MB)" -f $bundleBytes, ($bundleBytes / 1MB))

if (-not $KeepBuild -and (Test-Path $buildDir)) {
    Remove-Item -Recurse -Force $buildDir -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "  Build complete." -ForegroundColor Green
Write-Host "  Executable: $exePath" -ForegroundColor Green
Write-Host ""
Write-Host "  Launch it with:  Start-Process '$exePath'"
Write-Host "  It starts in Preview mode. It does not open COM10 and does not connect to an aircraft."
Write-Host "  This build is NOT code signed; Windows SmartScreen may warn on first run."
Write-Host ""
