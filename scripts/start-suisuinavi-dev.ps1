<#
.SYNOPSIS
  Starts the complete, safe SuisuiNavi HTML development environment.

.DESCRIPTION
  Starts or reuses the repository's legacy HTML server and mock MAVLink
  backend, verifies both services, and opens http://localhost:4173/.

  This launcher never starts backend:real. Mock-only safe commands and Pilot
  Control are enabled so the existing command and Bench Pilot UI can be tested
  without physical hardware.

  Server logs stay visible in their own PowerShell windows. Press Ctrl+C in a
  server window to stop that service, then close the window when finished.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$frontendPort = 4173
$backendPort = 8787
$frontendUrl = "http://localhost:$frontendPort/"
$backendHealthUrl = "http://127.0.0.1:$backendPort/api/health"
$backendConfigUrl = "http://127.0.0.1:$backendPort/api/drone/config"
$startupTimeout = [TimeSpan]::FromSeconds(45)
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$indexPath = Join-Path $repoRoot "index.html"
$packagePath = Join-Path $repoRoot "package.json"
$powershellExe = Join-Path $PSHOME "powershell.exe"

function Test-PortListening {
    param([int]$Port)

    return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Get-PortOwnerSummary {
    param([int]$Port)

    $ownerIds = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique

    if (-not $ownerIds) {
        return "listener owner unavailable"
    }

    $descriptions = foreach ($ownerId in $ownerIds) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerId" -ErrorAction SilentlyContinue
        if ($process) {
            "PID $ownerId ($($process.Name)): $($process.CommandLine)"
        } else {
            "PID $ownerId"
        }
    }

    return $descriptions -join "; "
}

function Get-FrontendProbe {
    if (-not (Test-PortListening -Port $frontendPort)) {
        return [PSCustomObject]@{ State = "Missing"; Detail = "port is free" }
    }

    $lastFailure = "identity check failed"
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            # Read before and after the request so an editor saving index.html
            # during this probe is retried instead of misreported as a conflict.
            $htmlBefore = [System.IO.File]::ReadAllText($indexPath)
            $probeUrl = "$frontendUrl`?launcher_probe=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
            $response = Invoke-WebRequest -UseBasicParsing -Uri $probeUrl -Headers @{ "Cache-Control" = "no-cache" } -TimeoutSec 3
            $htmlAfter = [System.IO.File]::ReadAllText($indexPath)
            $cacheControl = [string]$response.Headers["Cache-Control"]

            if ($htmlBefore -cne $htmlAfter) {
                $lastFailure = "index.html changed while the server identity was being checked"
                Start-Sleep -Milliseconds 150
                continue
            }
            if ($response.StatusCode -ne 200) {
                throw "root returned HTTP $($response.StatusCode)"
            }
            if ($response.Content -cne $htmlAfter) {
                throw "the served root is not the repository's current index.html"
            }
            if ($cacheControl -notmatch "no-store") {
                throw "the listener does not provide the expected development no-store header"
            }

            return [PSCustomObject]@{ State = "Ready"; Detail = "current repository HTML with no-store caching" }
        } catch {
            $lastFailure = $_.Exception.Message
            break
        }
    }

    $owner = Get-PortOwnerSummary -Port $frontendPort
    return [PSCustomObject]@{
        State = "Conflict"
        Detail = "Port $frontendPort is occupied but is not the current SuisuiNavi HTML server: $lastFailure. $owner"
    }
}

function Get-BackendProbe {
    if (-not (Test-PortListening -Port $backendPort)) {
        return [PSCustomObject]@{ State = "Missing"; Detail = "port is free" }
    }

    try {
        $health = Invoke-RestMethod -Uri $backendHealthUrl -TimeoutSec 3
        $configResponse = Invoke-RestMethod -Uri $backendConfigUrl -TimeoutSec 3
        $config = $configResponse.config

        if ($health.status -ne "ok") {
            throw "health status is '$($health.status)'"
        }
        if ($health.mode -ne "mock" -or $config.mode -ne "mock") {
            throw "backend mode is '$($health.mode)' instead of 'mock'"
        }
        if (-not [bool]$config.allowSafeCommands) {
            throw "mock safe commands are disabled"
        }
        if (-not [bool]$config.allowPilotControl) {
            throw "mock Pilot/Bench Control is disabled"
        }

        return [PSCustomObject]@{ State = "Ready"; Detail = "mock mode with development command permissions" }
    } catch {
        $owner = Get-PortOwnerSummary -Port $backendPort
        return [PSCustomObject]@{
            State = "Conflict"
            Detail = "Port $backendPort is occupied but is not the required safe mock backend: $($_.Exception.Message). $owner"
        }
    }
}

function Start-ServiceConsole {
    param(
        [string]$Title,
        [string]$Command
    )

    $windowCommand = @"
`$Host.UI.RawUI.WindowTitle = '$Title'
$Command
"@
    $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($windowCommand))

    return Start-Process -FilePath $powershellExe -WorkingDirectory $repoRoot -PassThru -ArgumentList @(
        "-NoLogo",
        "-NoProfile",
        "-NoExit",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        $encodedCommand
    )
}

function Wait-ForServices {
    param(
        [DateTimeOffset]$Deadline
    )

    do {
        $frontend = Get-FrontendProbe
        $backend = Get-BackendProbe

        if ($frontend.State -eq "Conflict") {
            throw $frontend.Detail
        }
        if ($backend.State -eq "Conflict") {
            throw $backend.Detail
        }
        if ($frontend.State -eq "Ready" -and $backend.State -eq "Ready") {
            return
        }

        Start-Sleep -Milliseconds 500
    } while ([DateTimeOffset]::Now -lt $Deadline)

    throw "Timed out after $([int]$startupTimeout.TotalSeconds) seconds waiting for the development services. Check the two server windows for details."
}

$launcherMutex = [Threading.Mutex]::new($false, "Local\SuisuiNaviDevelopmentLauncher")
$mutexAcquired = $false

try {
    Write-Host ""
    Write-Host "SuisuiNavi Development" -ForegroundColor Cyan
    Write-Host "Repository .......... $repoRoot"
    Write-Host ""

    if (-not (Test-Path -LiteralPath $indexPath -PathType Leaf)) {
        throw "Repository index.html was not found at $indexPath"
    }
    if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
        throw "Repository package.json was not found at $packagePath"
    }

    $package = Get-Content -Raw -LiteralPath $packagePath | ConvertFrom-Json
    if (-not $package.scripts.serve) {
        throw "package.json does not define the required 'serve' script."
    }
    if (-not $package.scripts.'backend:mock') {
        throw "package.json does not define the required 'backend:mock' script."
    }

    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) {
        throw "npm.cmd was not found. Install Node.js, then run this launcher again."
    }

    try {
        $mutexAcquired = $launcherMutex.WaitOne($startupTimeout)
    } catch [Threading.AbandonedMutexException] {
        $mutexAcquired = $true
    }
    if (-not $mutexAcquired) {
        throw "Another SuisuiNavi launcher is still starting services. Try again after its status window finishes."
    }

    $frontendProbe = Get-FrontendProbe
    $backendProbe = Get-BackendProbe

    if ($frontendProbe.State -eq "Conflict") {
        throw $frontendProbe.Detail
    }
    if ($backendProbe.State -eq "Conflict") {
        throw $backendProbe.Detail
    }

    $escapedRepoRoot = $repoRoot.Replace("'", "''")
    $escapedNpm = $npm.Source.Replace("'", "''")
    $frontendStarted = $frontendProbe.State -eq "Missing"
    $backendStarted = $backendProbe.State -eq "Missing"

    if ($frontendStarted) {
        Write-Host "HTML server ........ STARTING :$frontendPort" -ForegroundColor Yellow
        $frontendCommand = @"
Set-Location -LiteralPath '$escapedRepoRoot'
Write-Host ''
Write-Host 'SuisuiNavi HTML server :$frontendPort' -ForegroundColor Cyan
Write-Host 'Command: npm.cmd run serve'
Write-Host 'Press Ctrl+C to stop this service.'
Write-Host ''
& '$escapedNpm' run serve
"@
        $null = Start-ServiceConsole -Title "SuisuiNavi HTML Server :$frontendPort" -Command $frontendCommand
    } else {
        Write-Host "HTML server ........ REUSED   :$frontendPort" -ForegroundColor Green
    }

    if ($backendStarted) {
        Write-Host "Mock backend ....... STARTING :$backendPort" -ForegroundColor Yellow
        $backendCommand = @"
Set-Location -LiteralPath '$escapedRepoRoot'
`$env:SUISUI_MAVLINK_MODE = 'mock'
`$env:SUISUI_MAVLINK_HTTP_PORT = '$backendPort'
`$env:SUISUI_MAVLINK_ALLOW_SAFE_COMMANDS = '1'
`$env:SUISUI_MAVLINK_ALLOW_PILOT_CONTROL = '1'
Write-Host ''
Write-Host 'SuisuiNavi mock backend :$backendPort' -ForegroundColor Cyan
Write-Host 'Command: npm.cmd run backend:mock -- --allow-pilot-control'
Write-Host 'MOCK ONLY - no real Pixhawk/COM port is opened.' -ForegroundColor Green
Write-Host 'Press Ctrl+C to stop this service.'
Write-Host ''
& '$escapedNpm' run backend:mock -- --allow-pilot-control
"@
        $null = Start-ServiceConsole -Title "SuisuiNavi Mock Backend :$backendPort" -Command $backendCommand
    } else {
        Write-Host "Mock backend ....... REUSED   :$backendPort" -ForegroundColor Green
    }

    Wait-ForServices -Deadline ([DateTimeOffset]::Now.Add($startupTimeout))

    $frontendResult = if ($frontendStarted) { "READY " } else { "REUSED" }
    $backendResult = if ($backendStarted) { "READY " } else { "REUSED" }
    Write-Host ""
    Write-Host "HTML server ........ $frontendResult :$frontendPort" -ForegroundColor Green
    Write-Host "Mock backend ....... $backendResult :$backendPort" -ForegroundColor Green
    Write-Host "Opening browser .... $frontendUrl" -ForegroundColor Cyan
    Start-Process -FilePath $frontendUrl
    Write-Host ""
    Write-Host "To stop development services, press Ctrl+C in each titled server window."
    Start-Sleep -Seconds 2
} catch {
    Write-Host ""
    Write-Host "SuisuiNavi Development could not start." -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host "No existing listener was killed."
    Write-Host ""
    Read-Host "Press Enter to close"
    exit 1
} finally {
    if ($mutexAcquired) {
        $launcherMutex.ReleaseMutex()
    }
    $launcherMutex.Dispose()
}
