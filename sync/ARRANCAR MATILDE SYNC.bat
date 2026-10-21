@echo off
rem Lanzador de Matilde Sync. Busca el programa en su carpeta, en Escritorio\Matilde\no tocar o en Escritorio\Matilde.
set "S=%~dp0matilde-sync.ps1"
if not exist "%S%" set "S=%USERPROFILE%\Desktop\Matilde\no tocar\matilde-sync.ps1"
if not exist "%S%" set "S=%USERPROFILE%\Desktop\Matilde\matilde-sync.ps1"
if not exist "%S%" ( echo No encuentro matilde-sync.ps1 & pause & exit /b 1 )
start "Matilde Sync" powershell -NoProfile -ExecutionPolicy Bypass -NoExit -File "%S%"
exit
