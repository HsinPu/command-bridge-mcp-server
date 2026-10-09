@echo off
if "%~1"=="info" goto manage
if "%~1"=="setup" goto manage
if "%~1"=="update" goto update
if not "%~2"=="" goto usage
if "%~1"=="--version" goto version
if "%~1"=="-V" goto version
:usage
echo Usage: command-bridge --version ^| -V ^| info [--json] ^| setup [--show-token] [--codex-name NAME] [--codex-url URL] ^| update [--check^|--print-codex-setup] 1>&2
exit /b 2
:manage
if not exist "%~dp0runtime\node.exe" goto manage_missing
if not exist "%~dp0__APPLICATION_RELATIVE_PATH__\dist\cli\management.js" goto manage_missing
setlocal
set "NODE_OPTIONS="
set "NODE_PATH="
"%~dp0runtime\node.exe" "%~dp0__APPLICATION_RELATIVE_PATH__\dist\cli\management.js" %*
exit /b %errorlevel%
:manage_missing
echo CommandBridge query: RUNTIME_OR_CLI_MISSING 1>&2
exit /b 1
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
