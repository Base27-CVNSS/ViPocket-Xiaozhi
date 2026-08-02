@echo off
setlocal
cd /d "%~dp0"
title ViPocket-Xiaozhi - Repair
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows-one-click.ps1" -Repair
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%
