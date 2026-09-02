@echo off
setlocal
set PORTS=17370 17371 3001
title Infinite-Canvas-MCP 本地三件套
echo [dev-local] 清理端口 %PORTS% 上的残留进程（避免旧实例占端口导致 401/启动失败）...
for %%P in (%PORTS%) do (
  for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr /R ":%%P ") do (
    if not "%%a"=="0" (
      echo   - 端口 %%P 占用 PID=%%a，结束中...
      taskkill /PID %%a /F >nul 2>&1
    )
  )
)
timeout /t 2 >nul
echo [dev-local] 启动 npm run dev:local（backend+agent+web）...
echo [dev-local] 按 Ctrl+C 停止全部；或在别的窗口运行 scripts\dev-stop.bat
npm run dev:local
