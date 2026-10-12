# Fixed protected temporary-access storage. No caller paths or shell templates.
$ErrorActionPreference = 'Stop'
$PSModuleAutoloadingPreference = 'None'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($args.Count -ne 1 -or $args[0] -notin @('read', 'write')) { exit 2 }
. ([IO.Path]::Combine($PSScriptRoot, 'installation-paths.ps1'))
$root = [IO.Path]::Combine([Environment]::GetFolderPath('CommonApplicationData'), 'CommandBridgeMCP')
$path = [IO.Path]::Combine($root, 'access-lease.json')
$stage = $null
function Set-AccessLeaseAcl([string]$Target) {
  # File.Replace preserves destination security; apply a fresh descriptor each time.
  $security = [Security.AccessControl.FileSecurity]::new()
  $security.SetAccessRuleProtection($true, $false)
  $security.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
  $security.SetGroup([IO.File]::GetAccessControl($Target).GetGroup([Security.Principal.SecurityIdentifier]))
  foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) { $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'Allow')) }
  $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-19'), 'ReadAndExecute', 'Allow'))
  [IO.File]::SetAccessControl($Target, $security)
}
try {
  if ((Test-ProtectedPath $root $root) -ne $true) { throw 'ACCESS_ROOT_UNSAFE' }
  if ([IO.File]::Exists($path)) {
    if ((Test-ProtectedPath $path $root) -ne $true -or [IO.FileInfo]::new($path).Length -gt 4096) { throw 'ACCESS_RECORD_UNSAFE' }
    # LocalService may only read the lease; it must not own or modify it.
    $acl = [IO.File]::GetAccessControl($path)
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-18', 'S-1-5-32-544')) { throw 'ACCESS_OWNER_UNSAFE' }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
          ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]0xD0156) -ne 0 -and
          $rule.IdentityReference.Value -notin @('S-1-5-18', 'S-1-5-32-544')) { throw 'ACCESS_WRITER_UNSAFE' }
    }
  } elseif ([IO.Directory]::Exists($path)) { throw 'ACCESS_RECORD_UNSAFE' }
  if ($args[0] -eq 'read') {
    if (-not [IO.File]::Exists($path)) { [Console]::Write('ABSENT'); exit 0 }
    $bytes = [IO.File]::ReadAllBytes($path)
    if ($bytes.Length -gt 4096) { throw 'ACCESS_RECORD_TOO_LARGE' }
    [Console]::Write([Text.UTF8Encoding]::new($false, $true).GetString($bytes)); exit 0
  }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not [Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'ADMINISTRATOR_REQUIRED' }
  $payload = [Environment]::GetEnvironmentVariable('COMMAND_BRIDGE_ACCESS_PAYLOAD')
  [Environment]::SetEnvironmentVariable('COMMAND_BRIDGE_ACCESS_PAYLOAD', $null)
  if (-not $payload -or [Text.Encoding]::UTF8.GetByteCount($payload) -gt 4096) { throw 'ACCESS_PAYLOAD_INVALID' }
  $stage = [IO.Path]::Combine($root, '.access-lease.' + [guid]::NewGuid().ToString())
  $stream = [IO.File]::Open($stage, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $bytes = [Text.UTF8Encoding]::new($false).GetBytes($payload); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  Set-AccessLeaseAcl $stage
  if ((Test-ProtectedPath $stage $root) -ne $true) { throw 'ACCESS_STAGE_UNSAFE' }
  if ([IO.File]::Exists($path)) { [IO.File]::Replace($stage, $path, [NullString]::Value) } else { [IO.File]::Move($stage, $path) }
  $stage = $null
  Set-AccessLeaseAcl $path
  if ((Test-ProtectedPath $path $root) -ne $true) { throw 'ACCESS_PUBLICATION_UNSAFE' }
  [Console]::Write('OK')
} catch { [Console]::Error.WriteLine('CommandBridge temporary access storage failed.'); exit 1 }
finally { if ($stage -and [IO.File]::Exists($stage)) { [IO.File]::Delete($stage) } }
