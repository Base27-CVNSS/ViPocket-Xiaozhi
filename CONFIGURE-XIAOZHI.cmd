@echo off
setlocal
cd /d "%~dp0"
title ViPocket-Xiaozhi - Configure Xiaozhi

if not exist ".env" (
  if not exist ".env.example" (
    echo [LOI] Khong tim thay .env.example
    pause
    exit /b 1
  )
  copy /y ".env.example" ".env" >nul
)

start "" notepad.exe "%~dp0.env"
echo.
echo [ViPocket] Da mo tep .env.
echo [ViPocket] Dien XIAOZHI_OTA_URL hoac XIAOZHI_WS_URL + XIAOZHI_ACCESS_TOKEN.
echo [ViPocket] Luu tep, chay STOP-VIPOCKET.cmd, sau do START-VIPOCKET.cmd.
timeout /t 5 /nobreak >nul
