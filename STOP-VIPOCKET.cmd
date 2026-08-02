@echo off
setlocal
cd /d "%~dp0"
title ViPocket-Xiaozhi - Stop
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows-stop.ps1"
if not "%ERRORLEVEL%"=="0" pause
