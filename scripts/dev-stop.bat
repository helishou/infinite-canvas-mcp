@echo off
setlocal
set PORTS=17370 17371 3001
echo [dev-stop] 停止本地三件套（清理端口 %PORTS%）...
for %%P in (%PORTS%) do (
  for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr /R ":%%P ") do (
    if not "%%a"=="0" (
      echo   - 端口 %%P 占用 PID=%%a，结束中...
      taskkill /PID %%a /F >nul 2>&1
    )
  )
)
echo [dev-stop] 完成。
