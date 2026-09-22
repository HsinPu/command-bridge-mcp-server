# Run only on a disposable CI VM: installs and removes the real service.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') { throw 'Disposable GitHub runner required.' }
$root = (Get-Location).Path
$config = Join-Path $env:ProgramData 'CommandBridgeMCP\command-bridge.env'
$install = Join-Path $env:ProgramFiles 'CommandBridgeMCP'
$fixture = Join-Path $env:RUNNER_TEMP ('command-bridge-smoke-' + [guid]::NewGuid())
function Run-Installer([string]$Path, [string[]]$Extra = @()) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Path @Extra
  if ($LASTEXITCODE -ne 0) { throw 'Installer failed.' }
}
function Run-FailingInstaller([string]$Log, [string[]]$Extra = @(), [string]$Path = (Join-Path $fixture 'scripts\windows\install.ps1')) {
  # Windows PowerShell turns native stderr into ErrorRecords. Capture them without
  # aborting before the exit-code and activation-evidence assertions can run.
  $ErrorActionPreference = 'Continue'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Path @Extra *> $Log
  return $LASTEXITCODE
}
try {
  Run-Installer (Join-Path $root 'scripts\windows\install.ps1')
  if ((Get-Service CommandBridgeMCP).Status -ne 'Running') { throw 'Service is not running.' }
  if ((Get-CimInstance Win32_Service -Filter "Name='CommandBridgeMCP'").StartMode -ne 'Auto') { throw 'Service is not automatic.' }
  $before = [IO.File]::ReadAllText($config)
  $preserved = Join-Path $env:ProgramData 'CommandBridgeMCP\work\preserved'
  [IO.File]::WriteAllText($preserved, 'keep')
  Run-Installer (Join-Path $root 'scripts\windows\install.ps1')
  if ([IO.File]::ReadAllText($config) -ne $before) { throw 'Reinstallation changed configuration.' }
  Run-Installer (Join-Path $root 'scripts\windows\install.ps1') @('-RefreshNetwork') | Out-Null
  Restart-Service CommandBridgeMCP
  $xmlBefore = [IO.File]::ReadAllText((Join-Path $install 'CommandBridgeMCP.xml'))
  [xml]$definition = $xmlBefore
  $release = Split-Path -Parent (Split-Path -Parent (([string]$definition.service.arguments).Trim('"').Replace('%BASE%', $install)))
  $node = Join-Path $install 'runtime\node.exe'
  $infoBefore = [IO.File]::ReadAllText((Join-Path $release 'install-info.json'))
  $beforeRefresh = [IO.File]::ReadAllText($config)
  $hostBefore = [regex]::Match($beforeRefresh, '(?m)^COMMAND_BRIDGE_HTTP_HOST=([^\r\n]+)').Groups[1].Value
  $newHost = if ($hostBefore -eq '127.0.0.1') { '127.0.0.2' } else { '127.0.0.1' }
  $verifyMarker = Join-Path (Split-Path -Parent $preserved) ('rollback-verify-' + [guid]::NewGuid() + '.json')
  $healthMarker = Join-Path (Split-Path -Parent $preserved) ('rollback-health-' + [guid]::NewGuid() + '.json')
  $helper = Join-Path $root 'scripts\tests\rollback-fixture.mjs'
  function Assert-Restored {
    if ([IO.File]::ReadAllText($config) -ne $beforeRefresh) { throw 'Rollback changed configuration.' }
    if ((Get-Service CommandBridgeMCP).Status -ne 'Running') { throw 'Rollback did not recover service.' }
    if ([IO.File]::ReadAllText((Join-Path $install 'CommandBridgeMCP.xml')) -ne $xmlBefore) { throw 'Rollback changed release.' }
    if ([IO.File]::ReadAllText((Join-Path $release 'install-info.json')) -ne $infoBefore) { throw 'Rollback changed source identity.' }
    if ([IO.File]::ReadAllText($preserved) -ne 'keep') { throw 'Rollback changed working data.' }
    & $node (Join-Path $release 'scripts\verify-install.mjs') $config
    if ($LASTEXITCODE -ne 0) { throw 'Restored service failed MCP/Audit verification.' }
  }
  New-Item -ItemType Directory -Path $fixture | Out-Null
  Get-ChildItem -LiteralPath $root -Force | Where-Object { $_.Name -notin @('.git', 'node_modules', 'dist') } | Copy-Item -Destination $fixture -Recurse
  & $node $helper prepare $fixture verify ('1' * 40) $verifyMarker $newHost
  if ($LASTEXITCODE -ne 0) { throw 'Fixture setup failed.' }
  if ((Run-FailingInstaller (Join-Path $fixture 'verify.log') @('-RefreshNetwork')) -eq 0) { throw 'Expected verification failure.' }
  if (-not (Select-String -LiteralPath (Join-Path $fixture 'verify.log') -Pattern 'INJECTED_POST_ACTIVATION_FAILURE' -Quiet)) { throw 'Wrong failure stage.' }
  & $node $helper assert $verifyMarker ('1' * 40) verified
  if ($LASTEXITCODE -ne 0) { throw 'Activation evidence missing.' }
  Assert-Restored
  Copy-Item -LiteralPath (Join-Path $root 'scripts\verify-install.mjs') -Destination (Join-Path $fixture 'scripts\verify-install.mjs') -Force
  & $node $helper prepare $fixture health ('2' * 40) $healthMarker
  if ($LASTEXITCODE -ne 0) { throw 'Fixture setup failed.' }
  if ((Run-FailingInstaller (Join-Path $fixture 'health.log')) -eq 0) { throw 'Expected service health failure.' }
  & $node $helper assert $healthMarker ('2' * 40) started
  if ($LASTEXITCODE -ne 0) { throw 'Startup evidence missing.' }
  Assert-Restored
  $validConfig = [IO.File]::ReadAllText($config)
  [IO.File]::WriteAllText($config, [regex]::Replace($validConfig, '(?m)^COMMAND_BRIDGE_ALLOWED_COMMANDS=.*$', 'COMMAND_BRIDGE_ALLOWED_COMMANDS=unknown-custom-command'))
  if ((Run-FailingInstaller -Log (Join-Path $fixture 'migration.log') -Path (Join-Path $root 'scripts\windows\install.ps1')) -eq 0) { throw 'Expected migration rejection.' }
  if ((Get-Service CommandBridgeMCP).Status -ne 'Running') { throw 'Migration stopped existing service.' }
  [IO.File]::WriteAllText($config, $validConfig)
  Run-Installer (Join-Path $install 'uninstall.ps1') @('-Yes')
  if (-not (Test-Path -LiteralPath $config) -or -not (Test-Path -LiteralPath $preserved)) { throw 'Uninstall deleted preserved data.' }
  Run-Installer (Join-Path $root 'scripts\windows\install.ps1')
  Run-Installer (Join-Path $install 'uninstall.ps1') @('-Purge', '-Yes')
  if (Test-Path -LiteralPath $config) { throw 'Purge left configuration.' }
} finally {
  $resolved = [IO.Path]::GetFullPath($fixture)
  if (-not $resolved.StartsWith([IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test cleanup path.' }
  if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
