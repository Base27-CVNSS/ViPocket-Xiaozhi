@echo off
setlocal
cd /d "%~dp0"
title ViPocket-Xiaozhi - One Click Launcher

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows-one-click.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [ViPocket] Khoi dong khong thanh cong. Hay xem thong bao ben tren.
  echo [ViPocket] Nhat ky: %~dp0logs\vipocket-dev.log
  echo.
  pause
)

exit /b %EXIT_CODE%
