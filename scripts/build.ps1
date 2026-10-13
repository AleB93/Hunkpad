# Builds the standalone Diffpane executable, without installers (--no-bundle).
# The interface is built into the .exe, so it runs on its own (needs Git and
# WebView2, which Windows 11 includes).
#
# Usage (from anywhere):  powershell -ExecutionPolicy Bypass -File scripts\build.ps1
# Output:                 src-tauri\target\release\diffpane.exe

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    if (-not (Test-Path 'node_modules')) {
        Write-Host 'Installing npm dependencies...'
        & npm.cmd install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)" }
    }

    # npx.cmd, not npx: the .ps1 shim can be blocked by the execution policy.
    & npx.cmd tauri build --no-bundle
    if ($LASTEXITCODE -ne 0) { throw "Build failed (exit $LASTEXITCODE)" }

    $exe = Join-Path $root 'src-tauri\target\release\diffpane.exe'
    $size = [math]::Round((Get-Item $exe).Length / 1MB, 1)
    Write-Host "Built: $exe ($size MB)" -ForegroundColor Green
}
finally {
    Pop-Location
}
