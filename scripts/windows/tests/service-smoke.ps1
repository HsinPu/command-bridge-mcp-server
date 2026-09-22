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
  New-Item -ItemType Directory -Path $fixture | Out-Null
  Get-ChildItem -LiteralPath $root -Force | Where-Object { $_.Name -notin @('.git', 'node_modules', 'dist') } | Copy-Item -Destination $fixture -Recurse
  [IO.File]::WriteAllText((Join-Path $fixture '.command-bridge-source-sha'), ('1' * 40))
  [IO.File]::WriteAllText((Join-Path $fixture 'scripts\verify-install.mjs'), 'throw new Error("Injected verification failure");')
  $beforeRefresh = [IO.File]::ReadAllText($config)
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $fixture 'scripts\windows\install.ps1') -RefreshNetwork
  if ($LASTEXITCODE -eq 0) { throw 'Expected verification failure.' }
  if ([IO.File]::ReadAllText($config) -ne $beforeRefresh) { throw 'Network refresh rollback changed configuration.' }
  if ((Get-Service CommandBridgeMCP).Status -ne 'Running') { throw 'Rollback did not recover service.' }
  if ([IO.File]::ReadAllText((Join-Path $install 'CommandBridgeMCP.xml')) -ne $xmlBefore) { throw 'Rollback changed release.' }
  Copy-Item -LiteralPath (Join-Path $root 'scripts\verify-install.mjs') -Destination (Join-Path $fixture 'scripts\verify-install.mjs') -Force
  [IO.File]::WriteAllText((Join-Path $fixture '.command-bridge-source-sha'), ('2' * 40))
  [IO.File]::WriteAllText((Join-Path $fixture 'src\index.ts'), 'process.exit(1);')
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $fixture 'scripts\windows\install.ps1')
  if ($LASTEXITCODE -eq 0) { throw 'Expected service health failure.' }
  if ((Get-Service CommandBridgeMCP).Status -ne 'Running') { throw 'Health rollback did not recover service.' }
  if ([IO.File]::ReadAllText((Join-Path $install 'CommandBridgeMCP.xml')) -ne $xmlBefore) { throw 'Health rollback changed release.' }
  $validConfig = [IO.File]::ReadAllText($config)
  [IO.File]::WriteAllText($config, [regex]::Replace($validConfig, '(?m)^COMMAND_BRIDGE_ALLOWED_COMMANDS=.*$', 'COMMAND_BRIDGE_ALLOWED_COMMANDS=unknown-custom-command'))
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\windows\install.ps1')
  if ($LASTEXITCODE -eq 0) { throw 'Expected migration rejection.' }
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
