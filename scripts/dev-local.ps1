$ErrorActionPreference = "Stop"
$ports = @(17370, 17371, 3001)
Write-Host "[dev-local] Cleaning stale local services on ports $($ports -join ', ')..."
$pids = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $ports -contains $_.LocalPort } |
    Select-Object -ExpandProperty OwningProcess -Unique
foreach ($processId in $pids) {
    Write-Host "  stopping PID=$processId"
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2
Write-Host "[dev-local] Starting backend, agent and web..."
npm run dev:services
