$ErrorActionPreference = "Stop"

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$launcherPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "dev-local.ps1"))
$ports = @(17370, 17371, 3001)

function Stop-ProcessTree([int]$RootProcessId) {
    $snapshot = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $children = @($snapshot | Where-Object { $_.ParentProcessId -eq $RootProcessId })
    foreach ($child in $children) {
        Stop-ProcessTree -RootProcessId $child.ProcessId
    }
    Stop-Process -Id $RootProcessId -Force -ErrorAction SilentlyContinue
}

$stopped = [System.Collections.Generic.HashSet[int]]::new()
$snapshot = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
$launchers = @($snapshot | Where-Object {
    $_.Name -eq "powershell.exe" -and
    $_.CommandLine -and
    $_.CommandLine.IndexOf("-File", [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    $_.CommandLine.IndexOf($launcherPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
})

foreach ($launcher in $launchers) {
    Write-Host "[dev-stop] Stopping dev-local launcher PID=$($launcher.ProcessId)..."
    Stop-ProcessTree -RootProcessId $launcher.ProcessId
    [void]$stopped.Add([int]$launcher.ProcessId)
}

Start-Sleep -Milliseconds 500

# A launcher can exit before all descendants do. Only clean listeners whose
# command line still points at this exact project; never kill by process name.
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $ports -contains $_.LocalPort })
foreach ($listener in $listeners) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
    if (-not $process -or -not $process.CommandLine) {
        continue
    }
    if ($process.CommandLine.IndexOf($projectRoot, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
        Write-Warning "Port $($listener.LocalPort) belongs to unrelated PID=$($listener.OwningProcess); leaving it running."
        continue
    }
    Write-Host "[dev-stop] Stopping project listener PID=$($listener.OwningProcess) port=$($listener.LocalPort)..."
    Stop-ProcessTree -RootProcessId $listener.OwningProcess
    [void]$stopped.Add([int]$listener.OwningProcess)
}

Start-Sleep -Milliseconds 500
$remaining = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $ports -contains $_.LocalPort })
if ($remaining.Count -gt 0) {
    $summary = ($remaining | ForEach-Object { "$($_.LocalPort):PID=$($_.OwningProcess)" }) -join ", "
    throw "Development ports are still occupied: $summary"
}

if ($stopped.Count -eq 0) {
    Write-Host "[dev-stop] No running Infinite Canvas development stack found."
} else {
    Write-Host "[dev-stop] Development stack stopped. Ports 17370, 17371 and 3001 are free."
}
