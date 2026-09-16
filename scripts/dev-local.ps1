$ErrorActionPreference = "Stop"
$mutex = [System.Threading.Mutex]::new($false, "Local\InfiniteCanvasMcpDevLocal")
try {
    $hasLock = $mutex.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
    $hasLock = $true
}
if (-not $hasLock) {
    Write-Host "[dev-local] Another local development stack is already running."
    $mutex.Dispose()
    exit 0
}

function Stop-ProcessTree([int]$rootProcessId, [object[]]$processes) {
    $children = @($processes | Where-Object { $_.ParentProcessId -eq $rootProcessId })
    foreach ($child in $children) {
        Stop-ProcessTree -rootProcessId $child.ProcessId -processes $processes
    }
    Stop-Process -Id $rootProcessId -Force -ErrorAction SilentlyContinue
}

$scriptPath = [System.IO.Path]::GetFullPath($PSCommandPath)
$processSnapshot = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
$staleLaunchers = @($processSnapshot | Where-Object {
    $_.ProcessId -ne $PID -and
    $_.CommandLine -and
    $_.CommandLine.IndexOf($scriptPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
})
foreach ($launcher in $staleLaunchers) {
    Write-Host "[dev-local] Stopping stale launcher PID=$($launcher.ProcessId) and its child processes..."
    Stop-ProcessTree -rootProcessId $launcher.ProcessId -processes $processSnapshot
}

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
try {
    npm run dev:services
} finally {
    try { $mutex.ReleaseMutex() } catch { }
    $mutex.Dispose()
}
