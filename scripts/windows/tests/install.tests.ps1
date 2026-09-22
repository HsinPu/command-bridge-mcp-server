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
$ConfigRoot = "TestDrive:\config"
$WorkDirectory = "TestDrive:\work"
$LogsDirectory = "TestDrive:\logs"
$ConfigFile = Join-Path $env:TEMP ("command-bridge-test-" + [guid]::NewGuid() + ".env")
function New-Item { param($ItemType, $Path, [switch]$Force) }
function Test-Path { param($LiteralPath) return $false }
$savedEnvironment = @{}
foreach ($key in @("COMMAND_BRIDGE_BEARER_TOKEN", "COMMAND_BRIDGE_HTTP_HOST", "COMMAND_BRIDGE_HTTP_PORT", "COMMAND_BRIDGE_EXECUTION_MODE", "COMMAND_BRIDGE_ALLOWED_HOSTS")) {
  $savedEnvironment[$key] = [Environment]::GetEnvironmentVariable($key)
  [Environment]::SetEnvironmentVariable($key, $null)
}
try {
  New-SecureConfiguration
  $configuration = [IO.File]::ReadAllText($ConfigFile)
  Assert-True ($configuration -match 'COMMAND_BRIDGE_HTTP_HOST=127\.0\.0\.1') "Default HTTP host missing."
  Assert-True ($configuration -match 'COMMAND_BRIDGE_BEARER_TOKEN=[a-f0-9]{64}') "Generated token missing."
  function Invoke-WebRequest {
    param([switch]$UseBasicParsing, $Uri, $TimeoutSec)
    Assert-True ($Uri -eq 'http://127.0.0.1:8800/health') "Unexpected health URL."
    return @{ Content = '{"status":"ok"}' }
  }
  Wait-ForHealth
} finally {
  foreach ($key in $savedEnvironment.Keys) {
    [Environment]::SetEnvironmentVariable($key, $savedEnvironment[$key])
  }
  Remove-Item -LiteralPath $ConfigFile -Force -ErrorAction SilentlyContinue
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
Write-Output "Windows installer behavior checks passed."
