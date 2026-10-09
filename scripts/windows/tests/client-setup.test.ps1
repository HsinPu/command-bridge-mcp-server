# Private byte/ACL recovery fixture. Never registers, starts or stops a host service.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '..\install.ps1'), [ref]$null, [ref]$null)
foreach ($statement in $ast.EndBlock.Statements) {
  if ($statement -is [Management.Automation.Language.FunctionDefinitionAst]) { . ([scriptblock]::Create($statement.Extent.Text)) }
}
$private = Join-Path $env:TEMP ('cb-client-recovery-' + [guid]::NewGuid())
[void][IO.Directory]::CreateDirectory($private)
$ClientSetupFile = Join-Path $private 'client.json'
$ClientSetupRecoveryFailed = $false
$ConfigAclBackup = $null
$TempRoot = $private
try {
  foreach ($bom in @($false, $true)) {
    foreach ($newline in @("`n", "`r`n")) {
      [IO.File]::WriteAllText($ClientSetupFile, ('{"schemaVersion":1}' + $newline), [Text.UTF8Encoding]::new($bom))
      $ClientSetupBackup = [IO.File]::ReadAllBytes($ClientSetupFile)
      $ClientSetupAcl = [IO.File]::GetAccessControl($ClientSetupFile)
      $ClientSetupExisted = $true; $ClientSetupChanged = $true
      [IO.File]::WriteAllText($ClientSetupFile, 'candidate')
      Restore-ClientSetup
      if ($ClientSetupChanged -or [Convert]::ToBase64String([IO.File]::ReadAllBytes($ClientSetupFile)) -cne [Convert]::ToBase64String($ClientSetupBackup) -or [IO.File]::GetAccessControl($ClientSetupFile).Sddl -cne $ClientSetupAcl.Sddl) { throw 'Byte or ACL rollback failed.' }
    }
  }
  $ClientSetupExisted = $false; $ClientSetupChanged = $true
  Restore-ClientSetup
  if ([IO.File]::Exists($ClientSetupFile)) { throw 'Failed fresh install retained the new description.' }
  [IO.File]::WriteAllText($ClientSetupFile, 'candidate')
  $ClientSetupExisted = $true; $ClientSetupChanged = $true; $ClientSetupBackup = $null
  try { Restore-ClientSetup; throw 'Missing snapshot was accepted.' } catch {
    if (-not $ClientSetupRecoveryFailed -or [IO.File]::ReadAllText($ClientSetupFile) -cne 'candidate') { throw 'Failed recovery discarded evidence or changed the candidate.' }
  }
  # A failed restore cannot cause a service restart; stop the candidate first.
  $InstallCommitted = $true; $ServiceName = 'private-fixture'; $ConfigBackup = $null
  $script:stopped = 0; $script:started = 0
  function Get-ManagedService { return [pscustomobject]@{ Name='private-fixture' } }
  function Stop-Service { param($Name, [switch]$Force, $ErrorAction) $script:stopped++ }
  function Start-Service { param($Name, $ErrorAction) $script:started++ }
  Rollback-Installation 3>$null
  if ($script:stopped -ne 1 -or $script:started -ne 0 -or -not $ClientSetupRecoveryFailed) { throw 'Incomplete recovery restarted a service.' }
  Write-Output 'Windows private client-description recovery passed.'
} finally {
  $resolved = [IO.Path]::GetFullPath($private)
  if (-not $resolved.StartsWith([IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe private cleanup path.' }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
