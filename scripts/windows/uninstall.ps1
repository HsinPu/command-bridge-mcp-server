[CmdletBinding()]
param(
  [switch]$Purge,
  [switch]$Yes,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ServiceName = "CommandBridgeMCP"
$EventSource = "CommandBridgeMCP"
$InstallRoot = Join-Path $env:ProgramFiles "CommandBridgeMCP"
$ConfigRoot = Join-Path $env:ProgramData "CommandBridgeMCP"
$ServiceExe = Join-Path $InstallRoot "CommandBridgeMCP.exe"

function Write-Log {
  param([string]$Message)
  Write-Host "[CommandBridge] $Message"
}

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this uninstaller from an elevated PowerShell session."
  }
}

function Get-ManagedService {
  return Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
}

function Assert-ManagedServicePath {
  param($Service)
  if ($null -eq $Service) {
    return
  }
  $expectedRoot = [Regex]::Escape($InstallRoot)
  if ([string]$Service.PathName -notmatch "$expectedRoot.*CommandBridgeMCP\.exe") {
    throw "A service named $ServiceName exists outside the managed installation path."
  }
}

function Invoke-Change {
  param([scriptblock]$Action, [string]$Description)
  if ($DryRun) {
    Write-Log "[dry-run] $Description"
    return
  }
  & $Action
}

Assert-Administrator
$service = Get-ManagedService
Assert-ManagedServicePath $service

Write-Log "Planned removal:"
Write-Host "  Service: $ServiceName"
Write-Host "  Application: $InstallRoot"
Write-Host "  Event Log source: $EventSource"
if ($Purge) {
  Write-Host "  Configuration and work data: $ConfigRoot"
  Write-Warning "Purge permanently deletes the bearer token and CommandBridge work data."
} else {
  Write-Host "  Preserved configuration and work data: $ConfigRoot"
}

if (-not $Yes -and -not $DryRun) {
  throw "Interactive confirmation is unavailable. Re-run with -Yes after reviewing the plan."
}

if ($service) {
  Invoke-Change { Stop-Service -Name $ServiceName -Force -ErrorAction Stop } "stop $ServiceName"
  if (Test-Path -LiteralPath $ServiceExe) {
    Invoke-Change { & $ServiceExe uninstall | Out-Null; if ($LASTEXITCODE -ne 0) { throw "WinSW service uninstall failed." } } "unregister WinSW service"
  } else {
    throw "Managed service exists but its expected WinSW executable is missing."
  }
}

if (Test-Path -LiteralPath $InstallRoot) {
  Invoke-Change { Remove-Item -LiteralPath $InstallRoot -Recurse -Force } "remove application files"
}

if ([Diagnostics.EventLog]::SourceExists($EventSource)) {
  Invoke-Change { Remove-EventLog -Source $EventSource } "unregister Application Event Log source"
}

if ($Purge -and (Test-Path -LiteralPath $ConfigRoot)) {
  Invoke-Change { Remove-Item -LiteralPath $ConfigRoot -Recurse -Force } "purge configuration and work data"
}

if ($DryRun) {
  Write-Log "Dry run complete; no changes were made."
} elseif ($Purge) {
  Write-Log "Uninstallation complete and configuration was purged."
} else {
  Write-Log "Uninstallation complete. Configuration remains for a future reinstall."
}
