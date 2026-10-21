@echo off
title Matilde Sync
set "S=%~dp0matilde-sync.ps1"
if not exist "%S%" set "S=%USERPROFILE%\Desktop\Matilde\matilde-sync.ps1"
if not exist "%S%" ( echo No encuentro matilde-sync.ps1 ni en esta carpeta ni en Escritorio\Matilde & pause & exit /b 1 )
rem Se copia a si mismo a la carpeta de Inicio de Windows para arrancar solo al encender el PC
set "INICIO=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
if exist "%INICIO%" copy /Y "%~f0" "%INICIO%\matilde-sync.bat" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -File "%S%"
pause
