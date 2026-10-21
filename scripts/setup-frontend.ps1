param([int]$Port = 8081)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$frontendPath = Join-Path $projectRoot '.local/frontend'
if (-not (Test-Path -LiteralPath $frontendPath)) {
    New-Item -ItemType Directory -Force -Path (Join-Path $projectRoot '.local') | Out-Null
    git clone --depth 1 --branch feat/control-page https://github.com/Soongsil-RoomaIT/frontend.git $frontendPath
    if ($LASTEXITCODE -ne 0) { throw 'Frontend clone failed' }
}
Push-Location $frontendPath
try {
    # Preserve existing checkout changes. Re-running only rebuilds this checkout.
    # The team's control-page lockfile currently misses transitive MSW entries.
    # Repair only this ignored local checkout, never the team's remote repository.
    npm.cmd install
    if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency install failed' }
    $env:VITE_ENABLE_MOCKS = 'false'
    $env:VITE_API_BASE_URL = ''
    $env:VITE_WS_URL = "ws://localhost:$Port/ws"
    npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed' }
    Write-Output "Frontend is ready. Run npm start in CloudAIoT, then visit http://localhost:$Port."
    git rev-parse HEAD
} finally {
    Remove-Item Env:VITE_ENABLE_MOCKS -ErrorAction SilentlyContinue
    Remove-Item Env:VITE_API_BASE_URL -ErrorAction SilentlyContinue
    Remove-Item Env:VITE_WS_URL -ErrorAction SilentlyContinue
    Pop-Location
}
