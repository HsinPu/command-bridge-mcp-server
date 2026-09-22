Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:COMMAND_BRIDGE_CMDLET_REQUEST)) | ConvertFrom-Json
$allowed = @('Microsoft.PowerShell.Utility\Get-Date', 'Microsoft.PowerShell.Management\Get-ComputerInfo', 'Microsoft.PowerShell.Management\Get-Process', 'Microsoft.PowerShell.Management\Get-Service', 'CimCmdlets\Get-CimInstance')
if ($request.name -notin $allowed) { throw 'Unknown built-in cmdlet.' }
$arguments = @($request.args)
if ($request.name -eq 'CimCmdlets\Get-CimInstance') {
  if ($arguments.Count -eq 0) { $arguments = @('-ClassName', 'Win32_OperatingSystem') }
  if ($arguments.Count -ne 2 -or $arguments[0] -cne '-ClassName' -or $arguments[1] -cne 'Win32_OperatingSystem') { throw 'Cmdlet arguments rejected.' }
  CimCmdlets\Get-CimInstance -ClassName Win32_OperatingSystem
} else {
  if ($arguments.Count -ne 0) { throw 'Cmdlet arguments rejected.' }
  & $request.name
}
