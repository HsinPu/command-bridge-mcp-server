[CmdletBinding()]
param([switch]$Check, [switch]$PrintCodexSetup)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($Check -and $PrintCodexSetup) { throw 'Check cannot print Codex setup.' }
# Execute a copy outside the deployment tree so activation can move/remove it.
$work = Join-Path ([IO.Path]::GetTempPath()) ('command-bridge-update-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $bootstrap = Join-Path $work 'bootstrap.ps1'
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'bootstrap.ps1') -Destination $bootstrap
  & $bootstrap -Update -Check:$Check -PrintCodexSetup:$PrintCodexSetup
} finally {
  $resolved = [IO.Path]::GetFullPath($work)
  $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  if (-not $resolved.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe update cleanup path.' }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
