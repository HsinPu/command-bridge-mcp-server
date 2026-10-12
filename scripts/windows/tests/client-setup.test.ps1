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
$ConfigRoot = $private
$phase = 'candidate-acl'
try {
  # Exercise the production publisher with private files and the current user's
  # ACL. The production caller still supplies its fixed administrator/LocalService ACL.
  $candidate = Join-Path $private 'candidate.json'
  $newBytes = [Text.Encoding]::UTF8.GetBytes('{"schemaVersion":1,"connectionName":"cb_new","urlMode":"explicit","explicitUrl":"https://new.example/mcp","advertisedHost":null}')
  [IO.File]::WriteAllBytes($candidate, $newBytes)
  $candidateAcl = [IO.File]::GetAccessControl($candidate)
  $phase = 'fresh-publication'
  $candidateAcl.SetAccessRuleProtection($true, $false)
  $candidateAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.WindowsIdentity]::GetCurrent().User, 'FullControl', 'Allow'))
  $candidateAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-19'), 'Read', 'Allow'))
  [IO.File]::SetAccessControl($candidate, $candidateAcl)
  # Compare the OS-canonical descriptor, including its inherited-control flags.
  $candidateAcl = [IO.File]::GetAccessControl($candidate)
  Publish-ClientSetupCandidate $candidate $candidateAcl
  if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($ClientSetupFile)) -cne [Convert]::ToBase64String($newBytes)) { throw 'Fresh publication failed.' }
  foreach ($bom in @($false, $true)) {
    foreach ($newline in @("`n", "`r`n")) {
      [IO.File]::WriteAllText($ClientSetupFile, ('{"schemaVersion":1,"connectionName":"cb_old","urlMode":"explicit","explicitUrl":"https://old.example/mcp","advertisedHost":null}' + $newline), [Text.UTF8Encoding]::new($bom))
      $ClientSetupBackup = [IO.File]::ReadAllBytes($ClientSetupFile)
      $ClientSetupAcl = [IO.File]::GetAccessControl($ClientSetupFile)
      $ClientSetupExisted = $true; $ClientSetupChanged = $true
      $phase = 'replace'
      Publish-ClientSetupCandidate $candidate $candidateAcl
      if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($ClientSetupFile)) -cne [Convert]::ToBase64String($newBytes) -or [IO.File]::GetAccessControl($ClientSetupFile).Sddl -cne $candidateAcl.Sddl) { throw 'Replacement bytes or ACL mismatch.' }
      $phase = 'restore-client'
      Restore-ClientSetup
      if ($ClientSetupChanged -or [Convert]::ToBase64String([IO.File]::ReadAllBytes($ClientSetupFile)) -cne [Convert]::ToBase64String($ClientSetupBackup) -or [IO.File]::GetAccessControl($ClientSetupFile).Sddl -cne $ClientSetupAcl.Sddl) { throw 'Byte or ACL rollback failed.' }
    }
  }
  $ConfigFile = Join-Path $private 'config.env'
  [IO.File]::WriteAllText($ConfigFile, 'preserved-configuration')
  $ConfigBackup = [IO.File]::ReadAllBytes($ConfigFile)
  $ConfigAclBackup = [IO.File]::GetAccessControl($ConfigFile)
  Set-FileAclSnapshot $ConfigFile $candidateAcl
  [IO.File]::WriteAllText($ConfigFile, 'changed-configuration')
  $phase = 'restore-config'
  Restore-ConfigurationBytes
  if ([IO.File]::GetAccessControl($ConfigFile).Sddl -cne $ConfigAclBackup.Sddl -or [Convert]::ToBase64String([IO.File]::ReadAllBytes($ConfigFile)) -cne [Convert]::ToBase64String($ConfigBackup)) { throw 'Configuration ACL or bytes were not restored.' }
  $ConfigBackup = $null; $ConfigAclBackup = $null
  # A real sharing violation must fail and clean the unpublished stage; it must
  # not silently overwrite a locked description or discard rollback snapshots.
  $original = [IO.File]::ReadAllBytes($ClientSetupFile)
  $ClientSetupBackup = $original; $ClientSetupAcl = [IO.File]::GetAccessControl($ClientSetupFile)
  $ClientSetupExisted = $true; $ClientSetupChanged = $true
  $held = [IO.File]::Open($ClientSetupFile, 'Open', 'Read', 'None')
  $phase = 'locked-publication'
  $rejected = $false
  try { try { Publish-ClientSetupCandidate $candidate $candidateAcl } catch { $rejected = $true } } finally { $held.Dispose() }
  if (-not $rejected -or @(Get-ChildItem -LiteralPath $private -Filter '.client-setup-*').Count -ne 0) { throw 'Locked publication was accepted or retained staging.' }
  Restore-ClientSetup
  if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($ClientSetupFile)) -cne [Convert]::ToBase64String($original) -or [IO.File]::GetAccessControl($ClientSetupFile).Sddl -cne $ClientSetupAcl.Sddl) { throw 'Locked publication rollback mismatch.' }
  $ClientSetupExisted = $false; $ClientSetupChanged = $true
  $phase = 'fresh-rollback'
  Restore-ClientSetup
  if ([IO.File]::Exists($ClientSetupFile)) { throw 'Failed fresh install retained the new description.' }
  [IO.File]::WriteAllText($ClientSetupFile, 'candidate')
  $ClientSetupExisted = $true; $ClientSetupChanged = $true; $ClientSetupBackup = $null
  $phase = 'missing-snapshot'
  try { Restore-ClientSetup; throw 'Missing snapshot was accepted.' } catch {
    if (-not $ClientSetupRecoveryFailed -or [IO.File]::ReadAllText($ClientSetupFile) -cne 'candidate') { throw 'Failed recovery discarded evidence or changed the candidate.' }
  }
  # A failed restore cannot cause a service restart; stop the candidate first.
  $InstallCommitted = $true; $ServiceName = 'private-fixture'; $ConfigBackup = $null
  $phase = 'restart-refusal'
  $script:stopped = 0; $script:started = 0
  function Get-ManagedService { return [pscustomobject]@{ Name='private-fixture' } }
  function Stop-Service { param($Name, [switch]$Force, $ErrorAction) $script:stopped++ }
  function Start-Service { param($Name, $ErrorAction) $script:started++ }
  Rollback-Installation 3>$null
  if ($script:stopped -ne 1 -or $script:started -ne 0 -or -not $ClientSetupRecoveryFailed) { throw 'Incomplete recovery restarted a service.' }
  Write-Output 'Windows private client-description recovery passed.'
} catch {
  $base = $_.Exception.GetBaseException()
  $kind = $base.GetType().Name
  if ($kind -notin @('UnauthorizedAccessException','IOException','ArgumentException','SecurityException','RuntimeException')) { $kind = 'unknown' }
  [Console]::Error.WriteLine(('CLIENT_SETUP_FIXTURE_FAILURE phase={0} kind={1} hresult={2}' -f $phase, $kind, $base.HResult))
  exit 1
} finally {
  $resolved = [IO.Path]::GetFullPath($private)
  if (-not $resolved.StartsWith([IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe private cleanup path.' }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
