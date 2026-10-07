@echo off
if not "%~2"=="" goto usage
if "%~1"=="--version" goto version
if "%~1"=="-V" goto version
:usage
echo Usage: command-bridge --version ^| -V 1>&2
exit /b 2
:version
"%~dp0runtime\node.exe" "%~dp0__APPLICATION_RELATIVE_PATH__\dist\index.js" %1
exit /b %errorlevel%
