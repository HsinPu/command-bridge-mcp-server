Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Load only function definitions; never execute the service installation body.
$installerPath = Join-Path (Split-Path -Parent $PSScriptRoot) "install.ps1"
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($installerPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw ($parseErrors | Out-String) }
foreach ($statement in $ast.EndBlock.Statements) {
  if ($statement -is [System.Management.Automation.Language.FunctionDefinitionAst]) {
    . ([scriptblock]::Create($statement.Extent.Text))
  }
}

function Assert-True($Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

# Mock directory creation and write configuration only to a unique temporary file.
$ConfigRoot = $env:TEMP
$WorkDirectory = "TestDrive:\work"
$LogsDirectory = "TestDrive:\logs"
$ConfigFile = Join-Path $env:TEMP ("command-bridge-test-" + [guid]::NewGuid() + ".env")
function New-Item { param($ItemType, $Path, [switch]$Force, $ErrorAction) }
function Test-Path { param($LiteralPath) return $false }
$CodexUrl = ""
$CodexName = ""
$PrintCodexSetup = $true
$RefreshNetwork = $false
$EnableFileTransfer = $false
$EnableUpload = $false
$EnableDownload = $false
$ExecutionMode = ''
$ConfigBackup = $null
$HostFixture = Join-Path $env:TEMP ("command bridge host " + [guid]::NewGuid())
$InstallRoot = $HostFixture
$ApplicationRelativePath = 'current'
[void][IO.Directory]::CreateDirectory((Join-Path $HostFixture 'runtime'))
[void][IO.Directory]::CreateDirectory((Join-Path $HostFixture 'current\dist\config'))
[IO.File]::Copy($env:COMMAND_BRIDGE_TEST_NODE, (Join-Path $HostFixture 'runtime\node.exe'))
$hostSource = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path 'dist\config\allowedHosts.js'
[IO.File]::Copy($hostSource, (Join-Path $HostFixture 'current\dist\config\allowedHosts.js'))
[IO.File]::WriteAllText((Join-Path $HostFixture 'current\package.json'), '{"type":"module"}')
$script:addresses = @(
  [pscustomobject]@{ IPAddress = '8.8.8.8'; InterfaceIndex = 1; SkipAsSource = $false },
  [pscustomobject]@{ IPAddress = '10.0.0.2'; InterfaceIndex = 2; SkipAsSource = $false },
  [pscustomobject]@{ IPAddress = '192.168.1.20'; InterfaceIndex = 3; SkipAsSource = $false }
)
function Get-NetIPAddress { param($AddressFamily, $AddressState, $ErrorAction) return $script:addresses }
function Get-NetRoute { param($AddressFamily, $DestinationPrefix, $ErrorAction) return [pscustomobject]@{ InterfaceIndex = 3; RouteMetric = 5 } }
Assert-True ((Get-AutomaticHttpHost) -eq '192.168.1.20') "Default route should be preferred."
foreach ($address in @('10.0.0.1', '172.16.0.1', '172.31.255.1', '192.168.1.1', '100.64.0.1', '100.127.255.1')) {
  Assert-True (Test-PrivateIPv4 $address) "Expected private address: $address"
}
foreach ($address in @('8.8.8.8', '127.0.0.1', '169.254.1.1', '172.32.0.1', '100.128.0.1', '192.168.999.1', '::1')) {
  Assert-True (-not (Test-PrivateIPv4 $address)) "Unexpected private address: $address"
}
$savedEnvironment = @{}
foreach ($key in @("COMMAND_BRIDGE_BEARER_TOKEN", "COMMAND_BRIDGE_HTTP_HOST", "COMMAND_BRIDGE_HTTP_PORT", "COMMAND_BRIDGE_EXECUTION_MODE", "COMMAND_BRIDGE_ALLOWED_HOSTS")) {
  $savedEnvironment[$key] = [Environment]::GetEnvironmentVariable($key)
  [Environment]::SetEnvironmentVariable($key, $null)
}
try {
  New-SecureConfiguration
  $configuration = [IO.File]::ReadAllText($ConfigFile)
  Assert-True ($configuration -match 'COMMAND_BRIDGE_HTTP_HOST=192\.168\.1\.20') "Detected HTTP host missing."
  Assert-True ($configuration -match 'COMMAND_BRIDGE_ALLOWED_HOSTS=192\.168\.1\.20') "Allowed host missing."
  Assert-True ($configuration -match 'COMMAND_BRIDGE_BEARER_TOKEN=[a-f0-9]{64}') "Generated token missing."
  $configuration = $configuration.Replace('COMMAND_BRIDGE_ALLOWED_HOSTS=192.168.1.20', 'COMMAND_BRIDGE_ALLOWED_HOSTS=192.168.1.20:8800')
  [IO.File]::WriteAllText($ConfigFile, $configuration)
  function Invoke-LocalHealthRequest {
    param($Uri, $HostHeader)
    Assert-True ($Uri -eq 'http://192.168.1.20:8800/health') "Unexpected health URL."
    Assert-True ($HostHeader -eq '192.168.1.20') 'Missing configured Host header.'
    return '{"status":"ok"}'
  }
  Wait-ForHealth
  Assert-True ((Get-AutomaticCodexUrl) -eq 'http://192.168.1.20:8800/mcp') "Automatic URL did not match listener."
  Assert-True ((Get-CodexConnectionName -MachineName 'TWT-PELPLMAP06D.example.com') -ceq 'cb_twt_pelplmap06d_example_com') 'Default Codex connection name was not normalized.'
  Assert-True ((Get-CodexConnectionName -MachineName '---') -ceq 'cb_host') 'Empty normalized hostname needs a safe fallback.'
  $CodexName = 'cb_oracle_prod'
  Assert-True ((Get-CodexConnectionName) -ceq 'cb_oracle_prod') 'Custom Codex connection name was ignored.'
  foreach ($invalidName in @('', 'Bad-Name', '9host', 'host space', ('a' * 65))) {
    try {
      Assert-CodexConnectionName $invalidName
      throw 'Expected CodexName validation failure.'
    } catch {
      Assert-True ($_.Exception.Message -like 'CodexName must be*') 'Invalid CodexName did not fail validation.'
    }
  }
  $setup = (Print-CodexSetup) -join "`n"
  Assert-True ($setup.Contains('[mcp_servers.cb_oracle_prod]')) 'Custom Codex TOML section missing.'
  Assert-True ($setup.Contains('bearer_token_env_var = "CB_ORACLE_PROD_TOKEN"')) 'Per-host token variable missing.'
  Assert-True ($setup.Contains('Never overwrite the existing connection or its token.')) 'Collision guidance missing.'
  Assert-True (((Print-CodexSetup) -join "`n") -match 'url = "http://192.168.1.20:8800/mcp"') "Printed URL missing."
  # Reinstallation must preserve saved config even if the detected address changes.
  function Test-Path { param($LiteralPath) return $true }
  $script:addresses = @()
  New-SecureConfiguration
  Assert-True ([IO.File]::ReadAllText($ConfigFile) -eq $configuration) "Existing configuration changed."
  Assert-True ((Get-AutomaticHttpHost) -eq '127.0.0.1') "No-address fallback missing."
  function Test-Path { param($LiteralPath) return $false }
  $CodexUrl = 'https://mcp.example.com/mcp'
  New-SecureConfiguration
  Assert-True ((Get-AutomaticCodexUrl) -eq 'http://127.0.0.1:8800/mcp') "HTTPS setup should default to loopback."
  Assert-True (((Print-CodexSetup) -join "`n") -match 'url = "https://mcp.example.com/mcp"') "Explicit URL was overridden."
  $CodexUrl = ''
  $env:COMMAND_BRIDGE_HTTP_HOST = '10.20.30.40'
  $env:COMMAND_BRIDGE_HTTP_PORT = '9900'
  New-SecureConfiguration
  Assert-True ((Get-AutomaticCodexUrl) -eq 'http://10.20.30.40:9900/mcp') "Explicit host/port ignored."
  $beforeTransfer = [IO.File]::ReadAllText($ConfigFile)
  [IO.File]::AppendAllText($ConfigFile, "`r`nCOMMAND_BRIDGE_TRANSFER_ROOT=C:\private`r`nCOMMAND_BRIDGE_TRANSFER_MAX_BYTES=1024`r`nCOMMAND_BRIDGE_DOWNLOAD_ENABLED=false`r`n")
  $EnableUpload = $true
  Set-TransferConfiguration
  $transferText = [IO.File]::ReadAllText($ConfigFile)
  Assert-True ($transferText.Contains('COMMAND_BRIDGE_UPLOAD_ENABLED=true')) 'Upload opt-in missing.'
  Assert-True ($transferText.Contains('COMMAND_BRIDGE_DOWNLOAD_ENABLED=false')) 'Upload unexpectedly enabled download.'
  Assert-True ($transferText.Contains('COMMAND_BRIDGE_TRANSFER_ROOT=C:\private')) 'Custom root changed.'
  Assert-True ($transferText.Contains('COMMAND_BRIDGE_TRANSFER_MAX_BYTES=1024')) 'Reduced size limit changed.'
  $EnableUpload = $false
  Set-TransferConfiguration
  Assert-True ([IO.File]::ReadAllText($ConfigFile) -eq $transferText) 'Omitted transfer switches reset saved settings.'
  $ConfigBackup = $null
  $ExecutionMode = 'guarded'
  Set-ExecutionModeConfiguration
  $guardedText = [IO.File]::ReadAllText($ConfigFile)
  Assert-True ($guardedText -match '(?m)^COMMAND_BRIDGE_EXECUTION_MODE=guarded\r?$') 'Guarded mode not selected.'
  Assert-True ([Text.UTF8Encoding]::new($false).GetString($ConfigBackup) -ceq $transferText) 'Mode switch did not save complete rollback configuration.'
  $ExecutionMode = ''
  Set-ExecutionModeConfiguration
  Assert-True ([IO.File]::ReadAllText($ConfigFile) -ceq $guardedText) 'Omitted mode changed saved settings.'
  $ExecutionMode = 'allowlist'
  Set-ExecutionModeConfiguration
  Assert-True ([Text.UTF8Encoding]::new($false).GetString($ConfigBackup) -ceq $transferText) 'Subsequent edits replaced rollback backup.'
  Assert-True ([IO.File]::ReadAllText($ConfigFile) -ceq $transferText) 'Round-trip mode switch changed other settings.'
  $ExecutionMode = ''
} finally {
  foreach ($key in $savedEnvironment.Keys) {
    [Environment]::SetEnvironmentVariable($key, $savedEnvironment[$key])
  }
  Remove-Item -LiteralPath $ConfigFile -Force -ErrorAction SilentlyContinue
  [IO.Directory]::Delete($HostFixture, $true)
}

# Build with the current runtime as the downloaded runtime, and no Node on PATH.
Remove-Item Function:\Test-Path
$SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$NodeRoot = Split-Path -Parent $env:COMMAND_BRIDGE_TEST_NODE
$metadata = Get-Content -Raw (Join-Path $SourceRoot 'package.json') | ConvertFrom-Json
$PackageName = $metadata.name
$PackageVersion = $metadata.version
$SourceRef = "v$PackageVersion"
$originalPath = $env:PATH
$script:buildCalls = 0
$script:failBuild = $false
function Invoke-External {
  param($FilePath, $Arguments, $WorkingDirectory)
  Assert-True ((Get-Command node.exe).Source -eq $env:COMMAND_BRIDGE_TEST_NODE) "Build did not use bundled Node."
  $script:buildCalls += 1
  if ($script:failBuild) { throw "Simulated build failure" }
}
try {
  $env:PATH = $env:SystemRoot
  Build-Source $SourceRoot $NodeRoot
  Assert-True ($script:buildCalls -eq 4) "Build steps missing."
  Assert-True ($env:PATH -eq $env:SystemRoot) "PATH not restored after success."
  $script:failBuild = $true
  try {
    Build-Source $SourceRoot $NodeRoot
    throw "Expected build failure."
  } catch {
    Assert-True ($_.Exception.Message -eq "Simulated build failure") "Unexpected build error."
  }
  Assert-True ($env:PATH -eq $env:SystemRoot) "PATH not restored after failure."
} finally {
  $env:PATH = $originalPath
}

# Mock the fixed writer/reader rather than touching the machine's Event Log.
$InstallRoot = $SourceRoot
$ApplicationRelativePath = ''
$script:failBuild = $false
function Invoke-External {
  param($FilePath, $Arguments)
  $script:verificationEvent = $env:COMMAND_BRIDGE_AUDIT_EVENT
}
$readerCommand = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
Set-Item -Path "Function:$readerCommand" -Value {
  $global:LASTEXITCODE = 0
  return $script:verificationEvent
}
Invoke-AuditVerification
# If stopping/unregistering the old service fails, rollback must not delete its files.
$ConfigBackup = $null
$ServicePreviouslyInstalled = $true
$PreviousMoved = $false
$ServiceName = 'TestService'
$script:restarted = $false
function Get-ManagedService { return [pscustomobject]@{ Name = 'TestService'; ProcessId = 0 } }
function Start-Service { param($Name, $ErrorAction) $script:restarted = $true }
function Remove-Item { param($LiteralPath, [switch]$Recurse, [switch]$Force) throw 'Rollback attempted to delete the unchanged installation.' }
Rollback-Installation
Assert-True $script:restarted 'The previous service must be restarted without replacing its files.'
$script:diagnostics = @()
function Write-Log { param($Message) $script:diagnostics += $Message }
function Get-Service { param($Name, $ErrorAction) return [pscustomobject]@{ Status = 'Stopped' } }
function Get-ChildItem { param($LiteralPath, $Filter, $ErrorAction) return [pscustomobject]@{ FullName = 'fixture.log'; Name = 'fixture.log'; Length = 100 } }
function Get-ConfigValue { param($Name) return 'actual-bearer-value' }
function Get-Content {
  param($LiteralPath, $Tail, $ErrorAction, $Encoding)
  return @('secret=must-never-print actual-bearer-value', 'Startup dependency checks failed: audit, policyReadOnly', 'Error: EACCES secret=must-never-print', '{"event":"command_bridge.audit","command":"private-command"}')
}
Write-ServiceStartupDiagnostics
Assert-True ($script:diagnostics -contains 'Startup dependency failed: audit') 'Missing audit diagnosis.'
Assert-True ($script:diagnostics -contains 'Startup dependency failed: policyReadOnly') 'Missing policy diagnosis.'
Assert-True ($script:diagnostics -contains 'Startup error category: EACCES') 'Missing error category.'
Assert-True (($script:diagnostics -join '') -notmatch 'actual-bearer-value|must-never-print|private-command') 'Diagnostics exposed credentials or Audit payloads.'
Assert-True ((Protect-StartupDiagnosticLine -Line ('x' * 1000) -Token '').Length -eq 700) 'Diagnostics must bound line length.'
Write-Output "Windows installer behavior checks passed."
