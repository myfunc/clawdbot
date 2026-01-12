# Restart Clawdbot on Windows: build, kill existing daemon, restart.

$ErrorActionPreference = "Stop"

function Log($msg) { Write-Host "==> $msg" }
function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Push-Location $rootDir
try {
    # 1) Install dependencies
    Log "Running pnpm install"
    pnpm install
    if ($LASTEXITCODE -ne 0) { Fail "pnpm install failed" }

    # 2) Build
    Log "Running pnpm build"
    pnpm build
    if ($LASTEXITCODE -ne 0) { Fail "pnpm build failed" }

    # 3) Kill existing daemon if running
    Log "Stopping existing daemon (if any)"
    $daemonProcesses = Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -match "clawdbot.*daemon" -or $_.CommandLine -match "entry\.js.*daemon"
    }
    if ($daemonProcesses) {
        $daemonProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }

    # 4) Restart daemon
    Log "Restarting daemon"
    clawdbot daemon restart
    if ($LASTEXITCODE -ne 0) { Fail "clawdbot daemon restart failed" }

    Log "Done! Daemon restarted successfully."
}
finally {
    Pop-Location
}
