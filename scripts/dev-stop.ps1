$ErrorActionPreference = "Stop"
$ports = @(17370, 17371, 3001)
Write-Host "[dev-stop] Stopping local services on ports $($ports -join ', ')..."
$pids = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $ports -contains $_.LocalPort } |
    Select-Object -ExpandProperty OwningProcess -Unique
foreach ($processId in $pids) {
    Write-Host "  stopping PID=$processId"
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
}
Write-Host "[dev-stop] Done."
