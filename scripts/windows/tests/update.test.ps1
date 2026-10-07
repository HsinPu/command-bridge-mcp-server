$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$work = Join-Path ([IO.Path]::GetTempPath()) ('cb-update-test-' + [guid]::NewGuid())
$oldProgramFiles = $env:ProgramFiles
$oldFixture = $env:CB_UPDATE_FIXTURE
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $env:ProgramFiles = $work
  $env:CB_UPDATE_FIXTURE = $work
  $app = Join-Path $work 'CommandBridgeMCP'
  New-Item -ItemType Directory -Path $app | Out-Null
  $oldSha = 'a' * 40
  $newSha = 'b' * 40
  @{version='4.3.0'; sourceSha=$oldSha} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $app 'install-info.json')
  $bootstrap = Join-Path $work 'bootstrap.ps1'
  $source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\..\bootstrap.ps1'))
  # Only the disposable application test mocks elevation. Real service tests use administrator runners.
  $source = $source.Replace('if (-not $Check) {', 'if ($false) {')
  [IO.File]::WriteAllText($bootstrap, $source)
  $global:cbUpdate_channel = "$oldSha`n4.3.0`n"
  $global:cbUpdate_requests = @()
  $global:cbUpdate_failDownload = $false
  function Invoke-WebRequest {
    param([switch]$UseBasicParsing, [int]$TimeoutSec, [Parameter(Position=0)][string]$Uri, [string]$OutFile)
    $global:cbUpdate_requests += $Uri
    if ($global:cbUpdate_failDownload) { throw 'Fixture download failed' }
    if ($Uri.EndsWith('/channel.txt')) { return @{Content=$global:cbUpdate_channel} }
    [IO.File]::WriteAllText($OutFile, 'fixture archive')
  }
  function Expand-Archive {
    param([string]$LiteralPath, [string]$DestinationPath)
    $dir = Join-Path $DestinationPath 'source\scripts\windows'
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $global:cbUpdate_downloadWork = Split-Path -Parent $DestinationPath
    [IO.File]::WriteAllText((Join-Path $dir 'install.ps1'), @'
param([switch]$Update,[string]$ExpectedInstalledSha,[switch]$PrintCodexSetup)
if (-not $Update -or $ExpectedInstalledSha -ne ('a'*40)) { throw 'Wrong update arguments' }
$root=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
[IO.File]::WriteAllText((Join-Path $env:CB_UPDATE_FIXTURE 'selected'), [IO.File]::ReadAllText((Join-Path $root '.command-bridge-source-sha')))
if ($env:CB_UPDATE_FAIL -eq '1') { throw 'Fixture deployment failed' }
'@)
    # Changing the channel while downloading cannot affect this attempt.
    $global:cbUpdate_channel = ('c' * 40) + "`n9.0.0`n"
  }
  $output = @(& $bootstrap -Update)
  if ($output -notcontains 'Already up to date.' -or $global:cbUpdate_requests.Count -ne 1) { throw 'Identical SHA downloaded/deployed.' }
  $global:cbUpdate_channel = "$newSha`n4.3.0`n"
  & $bootstrap -Update -Check | Out-Null
  if (Test-Path -LiteralPath (Join-Path $work 'selected')) { throw 'Check deployed.' }
  & $bootstrap -Update | Out-Null
  if ([IO.File]::ReadAllText((Join-Path $work 'selected')) -ne $newSha) { throw 'Source was not pinned.' }
  if (Test-Path -LiteralPath $global:cbUpdate_downloadWork) { throw 'Bootstrap temporary files remain.' }
  $global:cbUpdate_channel = "$newSha`n4.3.0`n"
  $env:CB_UPDATE_FAIL = '1'
  $failed = $false
  try { & $bootstrap -Update | Out-Null } catch { $failed = $true }
  if (-not $failed -or (Test-Path -LiteralPath $global:cbUpdate_downloadWork)) { throw 'Deployment failure or cleanup lost.' }
  Remove-Item Env:CB_UPDATE_FAIL
  $global:cbUpdate_failDownload = $true
  $failed = $false
  try { & $bootstrap -Update -Check | Out-Null } catch { $failed = $true }
  if (-not $failed) { throw 'Download failure was ignored.' }
  $global:cbUpdate_failDownload = $false; $global:cbUpdate_channel = "main`n4.3.0`n"
  $failed = $false
  try { & $bootstrap -Update -Check | Out-Null } catch { $failed = $true }
  if (-not $failed) { throw 'Invalid channel was accepted.' }
  # The installed wrapper executes outside the installation, and cleans up after a thrown error.
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\update.ps1') -Destination (Join-Path $app 'update.ps1')
  [IO.File]::WriteAllText((Join-Path $app 'bootstrap.ps1'), "param([switch]`$Update,[switch]`$Check,[switch]`$PrintCodexSetup)`n[IO.File]::WriteAllText((Join-Path `$env:CB_UPDATE_FIXTURE 'wrapper-location'), `$PSScriptRoot)`nthrow 'Fixture wrapper failure'")
  $failed = $false
  try { & (Join-Path $app 'update.ps1') -Check } catch { $failed = $true }
  $wrapperWork = [IO.File]::ReadAllText((Join-Path $work 'wrapper-location'))
  if (-not $failed -or $wrapperWork -eq $app -or (Test-Path -LiteralPath $wrapperWork)) { throw 'Wrapper failure/cleanup incorrect.' }
  # Real Windows named mutex contention across separate processes.
  # Installer builds run these tests while holding the production mutex.
  # Use production acquisition logic with a unique disposable mutex name.
  $lockHelper = Join-Path $work 'deployment-lock.ps1'
  $lockSource = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\deployment-lock.ps1'))
  [IO.File]::WriteAllText($lockHelper, $lockSource.Replace('Global\CommandBridgeMCP.Install', ('Local\CommandBridgeMCP.Test.' + [guid]::NewGuid())))
  . $lockHelper
  $mutex = Enter-CommandBridgeDeploymentLock
  try {
    $probe = Join-Path $work 'lock.ps1'
    [IO.File]::WriteAllText($probe, ". '$lockHelper'`ntry { `$m=Enter-CommandBridgeDeploymentLock; `$m.ReleaseMutex(); `$m.Dispose(); exit 1 } catch { exit 0 }")
    & powershell.exe -NoProfile -NonInteractive -File $probe
    if ($LASTEXITCODE -ne 0) { throw 'Concurrent deployment was not blocked.' }
  } finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
  $mutex = Enter-CommandBridgeDeploymentLock; $mutex.ReleaseMutex(); $mutex.Dispose()
  # Exercise production ACL construction without changing host permissions.
  $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '..\install.ps1'), [ref]$null, [ref]$null)
  foreach ($statement in $ast.EndBlock.Statements) {
    if ($statement -is [Management.Automation.Language.FunctionDefinitionAst]) { . ([scriptblock]::Create($statement.Extent.Text)) }
  }
  $global:cbUpdate_aclCalls = @()
  function Invoke-External { param([string]$FilePath, [string[]]$Arguments) $global:cbUpdate_aclCalls += ,$Arguments }
  $ConfigRoot = Join-Path $work 'config'; $WorkDirectory = Join-Path $ConfigRoot 'work'; $LogsDirectory = Join-Path $ConfigRoot 'logs'
  $script:TransferDirectoryCreated = $false
  Set-RestrictedAcl $app
  if ($global:cbUpdate_aclCalls[0] -notcontains '*S-1-5-32-545:(OI)(CI)RX') { throw 'CLI is not readable/executable by ordinary users.' }
  if ($global:cbUpdate_aclCalls[1] -contains '*S-1-5-32-545:(OI)(CI)RX') { throw 'Configuration was made public.' }
  Write-Output 'Windows update and deployment lock checks passed.'
} finally {
  $env:ProgramFiles = $oldProgramFiles
  $env:CB_UPDATE_FIXTURE = $oldFixture
  Remove-Item Env:CB_UPDATE_FAIL -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $work -Recurse -Force
}
