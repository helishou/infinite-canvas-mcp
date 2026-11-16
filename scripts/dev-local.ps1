$ErrorActionPreference = "Stop"
$mutex = [System.Threading.Mutex]::new($false, "Local\InfiniteCanvasMcpDevLocal")
try {
    $hasLock = $mutex.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
    $hasLock = $true
}
if (-not $hasLock) {
    Write-Host "[dev-local] Another local development stack is already running."
    Write-Host "[dev-local] If its terminal is unavailable, run: npm run dev:stop"
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

$ports = @(8300, 17370, 17371, 3001)
Write-Host "[dev-local] Cleaning stale local services on ports $($ports -join ', ')..."
$pids = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $ports -contains $_.LocalPort } |
    Select-Object -ExpandProperty OwningProcess -Unique
foreach ($processId in $pids) {
    Write-Host "  stopping PID=$processId"
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2
Write-Host "[dev-local] Starting engine (8300), backend, agent and web..."
try {
    # 用仓库自带的 pnpm 包装器：本机 corepack 的 sh shim 在 git-bash/PS 下会直接报 Node 错误，
    # 之前这里写 corepack pnpm 导致整个 dev:local 起不来（引擎面板也就永远不启动）。
    node "$PSScriptRoot\pnpm.mjs" run dev:services
} finally {
    try { $mutex.ReleaseMutex() } catch { }
    $mutex.Dispose()
}
