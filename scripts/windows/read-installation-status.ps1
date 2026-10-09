# Fixed, read-only local administration probe. No arguments, modules or raw errors.
$ErrorActionPreference = 'Stop'
$PSModuleAutoloadingPreference = 'None'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($args.Count -ne 0) { exit 2 }
Import-Module ([IO.Path]::Combine($PSHOME, 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop
Add-Type -AssemblyName System.ServiceProcess
. ([IO.Path]::Combine($PSScriptRoot, 'installation-paths.ps1'))
$release = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..\..'))
$installRoot = [IO.Path]::GetFullPath([IO.Path]::Combine($release, '..\..'))
$configRoot = [IO.Path]::Combine([Environment]::GetFolderPath('CommonApplicationData'), 'CommandBridgeMCP')
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$administrator = [Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$state = 'unknown'; $autoStart = $null; $account = $null
try {
  $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Services\CommandBridgeMCP')
  if ($null -eq $key) { $state = 'absent' }
  else {
    try {
      $autoStart = [int]$key.GetValue('Start') -eq 2
      $account = [string]$key.GetValue('ObjectName')
      $controller = [ServiceProcess.ServiceController]::new('CommandBridgeMCP')
      try {
        $state = switch ([string]$controller.Status) { Running { 'running' } Stopped { 'stopped' } StartPending { 'starting' } StopPending { 'stopping' } default { 'unknown' } }
      } finally { $controller.Dispose() }
    } finally { $key.Dispose() }
  }
} catch { $state = 'unknown'; $account = $null }
$result = [ordered]@{ state=$state; autoStart=$autoStart; account=$account; administrator=$administrator;
  programTrusted=([bool](Test-ProtectedPath ([IO.Path]::Combine($release, 'install-info.json')) $installRoot));
  configurationTrusted=(Test-ProtectedPath ([IO.Path]::Combine($configRoot, 'command-bridge.env')) $configRoot);
  descriptionTrusted=(Test-ProtectedPath ([IO.Path]::Combine($configRoot, 'client-setup.json')) $configRoot) }
# ConvertTo-Json is loaded only from the fixed built-in utility module.
$result | ConvertTo-Json -Compress
