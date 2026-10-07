@echo off
if "%~1"=="update" goto update
if not "%~2"=="" goto usage
if "%~1"=="--version" goto version
if "%~1"=="-V" goto version
:usage
echo Usage: command-bridge --version ^| -V ^| update [--check^|--print-codex-setup] 1>&2
exit /b 2
:version
"%~dp0runtime\node.exe" "%~dp0__APPLICATION_RELATIVE_PATH__\dist\index.js" %1
exit /b %errorlevel%
:update
if not "%~3"=="" goto usage
if "%~2"=="" goto apply
if "%~2"=="--check" goto check
if "%~2"=="--print-codex-setup" goto setup
goto usage
:apply
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1"
exit /b %errorlevel%
:check
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1" -Check
exit /b %errorlevel%
:setup
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1" -PrintCodexSetup
exit /b %errorlevel%
