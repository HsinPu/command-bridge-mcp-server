[CmdletBinding()]
param([switch]$Uninstall, [switch]$Yes, [switch]$Purge, [switch]$DryRun, [switch]$PrintCodexSetup, [string]$CodexUrl, [switch]$RefreshNetwork)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$arguments = @{}
foreach ($key in @('Yes', 'Purge', 'DryRun', 'PrintCodexSetup', 'CodexUrl', 'RefreshNetwork')) {
  if ($PSBoundParameters.ContainsKey($key)) { $arguments[$key] = $PSBoundParameters[$key] }
}
$installed = Join-Path $env:ProgramFiles 'CommandBridgeMCP\uninstall.ps1'
if ($Uninstall -and (Test-Path -LiteralPath $installed)) { & $installed @arguments; exit }
$work = Join-Path $env:TEMP ('command-bridge-bootstrap-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $channel = (Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/HsinPu/command-bridge-mcp-server/install-channel/channel.txt').Content
  $fields = @($channel.TrimEnd("`r", "`n") -split '\r?\n')
  if ($fields.Count -ne 2 -or $fields[0] -cnotmatch '^[a-f0-9]{40}$' -or $fields[1] -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid installation channel.' }
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
