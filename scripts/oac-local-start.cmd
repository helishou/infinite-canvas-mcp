@echo off
chcp 936 >nul
rem 影策已迁到 E:\影策本地版\ ，这里只做转发，保留旧入口以防习惯性点击。
if exist "E:\影策本地版\yingce-start.cmd" (
  call "E:\影策本地版\yingce-start.cmd" %*
) else (
  echo Cannot find E:\影策本地版\yingce-start.cmd
  echo The local copy may have been moved or deleted.
  pause
)
