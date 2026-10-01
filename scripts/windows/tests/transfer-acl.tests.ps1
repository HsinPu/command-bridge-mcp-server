$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Output 'SKIP_ADMIN_REQUIRED'
  exit 0
}
# Load production functions without executing the installer entry point.
$installer = Join-Path (Split-Path -Parent $PSScriptRoot) 'install.ps1'
$ast = [Management.Automation.Language.Parser]::ParseFile($installer, [ref]$null, [ref]$null)
foreach ($statement in $ast.EndBlock.Statements) {
  if ($statement -is [Management.Automation.Language.FunctionDefinitionAst]) {
    . ([scriptblock]::Create($statement.Extent.Text))
  }
}
$fixture = Join-Path $env:TEMP ('cb-native-acl-' + [guid]::NewGuid())
try {
  $ConfigRoot = Join-Path $fixture 'config'
  $WorkDirectory = Join-Path $fixture 'work'
  $LogsDirectory = Join-Path $fixture 'logs'
  $application = Join-Path $fixture 'application'
  $transfer = Join-Path $ConfigRoot 'transfers'
  foreach ($path in @($ConfigRoot, $WorkDirectory, $LogsDirectory, $application, $transfer)) {
    [IO.Directory]::CreateDirectory($path) | Out-Null
  }
  $script:TransferDirectoryCreated = $true
  Set-RestrictedAcl -StagedInstallRoot $application
  # Read directly through .NET; CI's parent PowerShell 7 module path must not
  # redirect Windows PowerShell's Microsoft.PowerShell.Security discovery.
  $acl = [IO.Directory]::GetAccessControl($transfer)
  if (-not $acl.AreAccessRulesProtected) { throw 'Transfer ACL inherits permissions.' }
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544') { throw 'Incorrect transfer owner.' }
  $directoryRules = @($acl.Access | Where-Object {
    $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq 'S-1-5-19' -and
    $_.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None
  })
  if ($directoryRules.Count -ne 1) { throw 'Missing LocalService directory access.' }
  $rights = $directoryRules[0].FileSystemRights
  if (-not ($rights -band [Security.AccessControl.FileSystemRights]::CreateFiles)) { throw 'Cannot publish transfer files.' }
  foreach ($forbidden in @('Delete', 'DeleteSubdirectoriesAndFiles', 'ChangePermissions', 'TakeOwnership')) {
    if ($rights -band [Security.AccessControl.FileSystemRights]::$forbidden) { throw 'Unsafe directory rights.' }
  }
  Write-Output 'Native transfer ACL owner, inheritance and publication rights passed.'
} finally {
  $resolved = [IO.Path]::GetFullPath($fixture)
  $temporaryRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
  if (-not $resolved.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe ACL fixture cleanup path.' }
  if ([IO.Directory]::Exists($resolved)) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
