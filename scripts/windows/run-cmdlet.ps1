Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$PSModuleAutoLoadingPreference = 'None'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
Import-Module -Name ([IO.Path]::Combine($PSHOME, 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:COMMAND_BRIDGE_CMDLET_REQUEST)) | Microsoft.PowerShell.Utility\ConvertFrom-Json
$allowed = @('Microsoft.PowerShell.Utility\Get-Date', 'Microsoft.PowerShell.Management\Get-ComputerInfo', 'Microsoft.PowerShell.Management\Get-Process', 'Microsoft.PowerShell.Management\Get-Service', 'CimCmdlets\Get-CimInstance')
if ($request.name -notin $allowed) { throw 'Unknown built-in cmdlet.' }
$moduleName = ([string]$request.name).Split('\')[0]
if ($moduleName -ne 'Microsoft.PowerShell.Utility') {
  Import-Module -Name ([IO.Path]::Combine($PSHOME, 'Modules', $moduleName, ($moduleName + '.psd1'))) -ErrorAction Stop
}
$arguments = @($request.args)
if ($request.name -eq 'CimCmdlets\Get-CimInstance') {
  if ($arguments.Count -eq 0) { $arguments = @('-ClassName', 'Win32_OperatingSystem') }
  if ($arguments.Count -ne 2 -or $arguments[0] -cne '-ClassName' -or $arguments[1] -cne 'Win32_OperatingSystem') { throw 'Cmdlet arguments rejected.' }
  CimCmdlets\Get-CimInstance -ClassName Win32_OperatingSystem
} else {
  if ($arguments.Count -ne 0) { throw 'Cmdlet arguments rejected.' }
  & $request.name
}
