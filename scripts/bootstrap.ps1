[CmdletBinding()]
param([switch]$Update, [switch]$Check, [switch]$Uninstall, [switch]$Yes, [switch]$Purge, [switch]$DryRun, [switch]$PrintCodexSetup, [string]$CodexUrl, [string]$CodexName, [switch]$RefreshNetwork, [switch]$EnableFileTransfer, [switch]$EnableUpload, [switch]$EnableDownload, [ValidateSet('allowlist', 'guarded', 'unrestricted')][string]$ExecutionMode)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
Set-StrictMode -Version Latest
$arguments = @{}
if ($Check -and -not $Update) { throw 'Check applies only to update.' }
if ($Update) {
  foreach ($key in $PSBoundParameters.Keys) { if ($key -notin @('Update', 'Check', 'PrintCodexSetup')) { throw 'Update cannot change settings or uninstall.' } }
  if ($Check -and $PrintCodexSetup) { throw 'Check cannot print Codex setup.' }
  if (-not $Check) {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run update from an elevated administrator terminal.' }
  }
  $installInfo = Join-Path $env:ProgramFiles 'CommandBridgeMCP\install-info.json'
  $localInfo = Get-Content -LiteralPath $installInfo -Raw | ConvertFrom-Json
  if ($localInfo.sourceSha -cnotmatch '^[a-f0-9]{40}$' -or $localInfo.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid installed metadata.' }
  $arguments.Update = $true
  $arguments.ExpectedInstalledSha = $localInfo.sourceSha
}
if ($Uninstall -and $PSBoundParameters.ContainsKey('ExecutionMode')) { throw 'ExecutionMode applies only to installation.' }
if ($Uninstall -and $PSBoundParameters.ContainsKey('CodexName')) { throw 'CodexName applies only to installation.' }
foreach ($key in @('Yes', 'Purge', 'DryRun', 'PrintCodexSetup', 'CodexUrl', 'CodexName', 'RefreshNetwork', 'EnableFileTransfer', 'EnableUpload', 'EnableDownload', 'ExecutionMode')) {
  if ($PSBoundParameters.ContainsKey($key)) { $arguments[$key] = $PSBoundParameters[$key] }
}
$installed = Join-Path $env:ProgramFiles 'CommandBridgeMCP\uninstall.ps1'
if ($Uninstall -and (Test-Path -LiteralPath $installed)) { & $installed @arguments; exit }
$work = Join-Path $env:TEMP ('command-bridge-bootstrap-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $channel = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 'https://raw.githubusercontent.com/HsinPu/command-bridge-mcp-server/install-channel/channel.txt').Content
  $fields = @($channel.TrimEnd("`r", "`n") -split '\r?\n')
  if ($fields.Count -ne 2 -or $fields[0] -cnotmatch '^[a-f0-9]{40}$' -or $fields[1] -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid installation channel.' }
  if ($Update) {
    Write-Output "Installed: $($localInfo.version) $($localInfo.sourceSha)"
    Write-Output "Verified channel: $($fields[1]) $($fields[0])"
    if ($fields[0] -eq $localInfo.sourceSha) { Write-Output 'Already up to date.'; return }
    if ($Check) { Write-Output 'Update available. Run update from an elevated administrator terminal.'; return }
    Write-Output 'Updating CommandBridge; the service will restart briefly. Settings and service identity will be preserved.'
  }
  $archive = Join-Path $work 'source.zip'
  Invoke-WebRequest -UseBasicParsing "https://github.com/HsinPu/command-bridge-mcp-server/archive/$($fields[0]).zip" -OutFile $archive
  $source = Join-Path $work 'source'
  Expand-Archive -LiteralPath $archive -DestinationPath $source
  $roots = @(Get-ChildItem -LiteralPath $source -Directory)
  if ($roots.Count -ne 1) { throw 'Unexpected source layout.' }
  $root = $roots[0].FullName
  [IO.File]::WriteAllText((Join-Path $root '.command-bridge-source-sha'), $fields[0])
  [IO.File]::WriteAllText((Join-Path $root '.command-bridge-source-version'), $fields[1])
  $entry = if ($Uninstall) { 'uninstall.ps1' } else { 'install.ps1' }
  & (Join-Path $root "scripts\windows\$entry") @arguments
} finally {
  $resolved = [IO.Path]::GetFullPath($work)
  $tempBase = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
  if (-not $resolved.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe bootstrap cleanup path.' }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
