@echo off
setlocal
cd /d "%~dp0"
title ViPocket-Xiaozhi 2.3.0 - One Click

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows-one-click.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [ViPocket] Khoi dong khong thanh cong. Hay xem thong bao ben tren.
  echo [ViPocket] Nhat ky thuong: %~dp0logs\vipocket.log
  echo [ViPocket] Nhat ky loi:    %~dp0logs\vipocket-error.log
  echo.
  pause
)

exit /b %EXIT_CODE%
