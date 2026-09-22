[CmdletBinding()]
param(
  [switch]$PrintCodexSetup,
  [string]$CodexUrl,
  [switch]$RefreshNetwork
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ServiceName = "CommandBridgeMCP"
$EventSource = "CommandBridgeMCP"
$PackageName = "command-bridge-mcp-server"
$PackageVersion = ""
$SourceRef = ""
$ApplicationRelativePath = "app"
$ConfigBackup = $null
$NodeVersion = "24.18.0"
$WinSwVersion = "2.12.0"
$WinSwUrl = "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe"
$WinSwSha256 = "05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da"
$NodeBaseUrl = "https://nodejs.org/download/release/v$NodeVersion"
$NodeArchiveName = "node-v$NodeVersion-win-x64.zip"
$InstallRoot = Join-Path $env:ProgramFiles "CommandBridgeMCP"
$ConfigRoot = Join-Path $env:ProgramData "CommandBridgeMCP"
$ConfigFile = Join-Path $ConfigRoot "command-bridge.env"
$WorkDirectory = Join-Path $ConfigRoot "work"
$LogsDirectory = Join-Path $ConfigRoot "logs"
$ServiceExeName = "CommandBridgeMCP.exe"
$XmlName = "CommandBridgeMCP.xml"
$TempRoot = Join-Path $env:TEMP ("command-bridge-install-" + [Guid]::NewGuid().ToString("N"))
$StagingRoot = Join-Path (Split-Path -Parent $InstallRoot) (".CommandBridgeMCP-staging-" + $PID)
$PreviousRoot = Join-Path (Split-Path -Parent $InstallRoot) (".CommandBridgeMCP-previous-" + $PID)
$ServicePreviouslyInstalled = $false
$PreviousMoved = $false
$ActivationSucceeded = $false
$InstallCommitted = $false
$EventSourceCreated = $false

function Write-Log {
  param([string]$Message)
  Write-Host "[CommandBridge] $Message"
}

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this installer from an elevated PowerShell session."
  }
  if (-not [Environment]::Is64BitOperatingSystem) {
    throw "Windows x64 is required. ARM64 is not supported by this installer yet."
  }
}

function Invoke-External {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$Arguments = @(),
    [string]$WorkingDirectory
  )

  Push-Location
  try {
    if ($WorkingDirectory) {
      Set-Location -LiteralPath $WorkingDirectory
    }
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "External command failed: $FilePath"
    }
  } finally {
    Pop-Location
  }
}

function Invoke-WebDownload {
  param([string]$Uri, [string]$Destination)
  Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Destination
}

function Get-Sha256 {
  param([string]$Path)
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Assert-Sha256 {
  param([string]$Path, [string]$Expected, [string]$Label)
  if ((Get-Sha256 $Path) -ne $Expected.ToLowerInvariant()) {
    throw "$Label SHA-256 verification failed."
  }
}

function Get-SourceRoot {
  $localSource = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
  if ((Test-Path -LiteralPath (Join-Path $localSource "package.json")) -and (Test-Path -LiteralPath (Join-Path $localSource "src"))) {
    $shaFile = Join-Path $localSource '.command-bridge-source-sha'
    $script:SourceRef = if (Test-Path -LiteralPath $shaFile) { [IO.File]::ReadAllText($shaFile).Trim() } else { (& git -C $localSource rev-parse HEAD).Trim() }
    if (-not (Test-Path -LiteralPath $shaFile)) {
      $dirty = & git -C $localSource status --porcelain --untracked-files=normal
      if ($LASTEXITCODE -ne 0 -or $dirty) { throw 'Commit local source changes before installation so release identity is unambiguous.' }
    }
    if ($script:SourceRef -cnotmatch '^[a-f0-9]{40}$') { throw 'A full source commit SHA is required.' }
    Write-Log "Using local CommandBridge source from $localSource."
    return (Resolve-Path -LiteralPath $localSource).Path
  }

  throw 'Use scripts/bootstrap.ps1 to download a CI-verified source snapshot.'
}

function Get-NodeRuntime {
  $checksumsPath = Join-Path $TempRoot "SHASUMS256.txt"
  $archivePath = Join-Path $TempRoot $NodeArchiveName
  $extractPath = Join-Path $TempRoot "node-extract"
  Write-Log "Downloading Node.js v$NodeVersion runtime."
  Invoke-WebDownload "$NodeBaseUrl/SHASUMS256.txt" $checksumsPath
  Invoke-WebDownload "$NodeBaseUrl/$NodeArchiveName" $archivePath

  $manifest = Get-Content -Raw -LiteralPath $checksumsPath
  $namePattern = [Regex]::Escape($NodeArchiveName)
  $match = [Regex]::Match($manifest, "(?m)^([A-Fa-f0-9]{64})\s+$namePattern$")
  if (-not $match.Success) {
    throw "Node.js checksum manifest does not contain $NodeArchiveName."
  }
  Assert-Sha256 $archivePath $match.Groups[1].Value "Node.js runtime"

  Expand-Archive -LiteralPath $archivePath -DestinationPath $extractPath -Force
  $nodeRoot = Join-Path $extractPath ("node-v$NodeVersion-win-x64")
  $node = Join-Path $nodeRoot "node.exe"
  if (-not (Test-Path -LiteralPath $node)) {
    throw "Node.js archive did not contain node.exe."
  }
  $version = (& $node --version | Select-Object -First 1).Trim()
  if ($LASTEXITCODE -ne 0 -or $version -ne "v$NodeVersion") {
    throw "Downloaded Node.js runtime failed its version check."
  }
  return $nodeRoot
}

function Get-WinSw {
  $path = Join-Path $TempRoot "WinSW-x64.exe"
  Write-Log "Downloading WinSW v$WinSwVersion."
  Invoke-WebDownload $WinSwUrl $path
  Assert-Sha256 $path $WinSwSha256 "WinSW"
  return $path
}

function Build-Source {
  param([string]$SourceRoot, [string]$NodeRoot)

  $node = Join-Path $NodeRoot "node.exe"
  $npm = Join-Path $NodeRoot "npm.cmd"
  if (-not (Test-Path -LiteralPath $npm)) {
    throw "Node.js runtime did not contain npm.cmd."
  }
  Push-Location $SourceRoot
  try {
    $name = (& $node -p "require('./package.json').name" | Select-Object -First 1).Trim()
    $version = (& $node -p "require('./package.json').version" | Select-Object -First 1).Trim()
  } finally {
    Pop-Location
  }
  if ($name -ne $PackageName -or $version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Source package metadata does not match CommandBridge $SourceRef."
  }
  $expectedVersion = Join-Path $SourceRoot '.command-bridge-source-version'
  if ((Test-Path -LiteralPath $expectedVersion) -and [IO.File]::ReadAllText($expectedVersion).Trim() -ne $version) { throw 'Source version does not match the verified channel.' }
  $script:PackageVersion = $version
  $script:ApplicationRelativePath = "releases\v$version-$SourceRef"

  Write-Log "Installing locked dependencies and running the CommandBridge test suite."
  $previousPath = $env:PATH
  try {
    $env:PATH = "$NodeRoot;$previousPath"
    Invoke-External $npm @("ci", "--ignore-scripts", "--no-audit", "--no-fund") $SourceRoot
    Invoke-External $npm @("run", "build") $SourceRoot
    Invoke-External $npm @("test") $SourceRoot
    Invoke-External $npm @("prune", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund") $SourceRoot
  } finally {
    $env:PATH = $previousPath
  }
}

function Test-PrivateIPv4 {
  param([string]$Address)
  $parsed = $null
  if ($Address -notmatch '^(\d{1,3}\.){3}\d{1,3}$' -or -not [Net.IPAddress]::TryParse($Address, [ref]$parsed)) { return $false }
  $bytes = $parsed.GetAddressBytes()
  return ($bytes.Length -eq 4 -and ($bytes[0] -eq 10 -or
    ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or
    ($bytes[0] -eq 192 -and $bytes[1] -eq 168) -or
    ($bytes[0] -eq 100 -and $bytes[1] -ge 64 -and $bytes[1] -le 127)))
}

function Get-AutomaticHttpHost {
  try {
    $addresses = @(Get-NetIPAddress -AddressFamily IPv4 -AddressState Preferred -ErrorAction Stop |
      Where-Object { -not $_.SkipAsSource -and (Test-PrivateIPv4 $_.IPAddress) } |
      Sort-Object InterfaceIndex, IPAddress)
    $routes = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue |
      Sort-Object RouteMetric, InterfaceIndex)
    foreach ($route in $routes) {
      $match = @($addresses | Where-Object { $_.InterfaceIndex -eq $route.InterfaceIndex })
      if ($match.Count -gt 0) { return $match[0].IPAddress }
    }
    if ($addresses.Count -gt 0) { return $addresses[0].IPAddress }
  } catch {
    Write-Warning "Could not detect a private IPv4 address; using loopback."
  }
  return "127.0.0.1"
}

function Get-AutomaticCodexUrl {
  $httpHost = Get-ConfigValue "COMMAND_BRIDGE_HTTP_HOST"
  $port = Get-ConfigValue "COMMAND_BRIDGE_HTTP_PORT"
  if ($httpHost -eq "0.0.0.0") { $httpHost = Get-AutomaticHttpHost }
  if ($httpHost -eq "::") { $httpHost = "::1" }
  if ($httpHost.Contains(":")) { $httpHost = "[$httpHost]" }
  return "http://{0}:{1}/mcp" -f $httpHost, $port
}

function New-SecureConfiguration {
  $newLine = [Environment]::NewLine
  New-Item -ItemType Directory -Path $ConfigRoot -Force | Out-Null
  New-Item -ItemType Directory -Path $WorkDirectory -Force | Out-Null
  New-Item -ItemType Directory -Path $LogsDirectory -Force | Out-Null

  if (Test-Path -LiteralPath $ConfigFile) {
    Write-Log "Preserving existing configuration and bearer token at $ConfigFile."
    if ($RefreshNetwork) {
      $script:ConfigBackup = [IO.File]::ReadAllText($ConfigFile)
      $httpHost = Get-AutomaticHttpHost
      $updated = [regex]::Replace($script:ConfigBackup, '(?m)^COMMAND_BRIDGE_HTTP_HOST=.*$', "COMMAND_BRIDGE_HTTP_HOST=$httpHost")
      $updated = [regex]::Replace($updated, '(?m)^COMMAND_BRIDGE_ALLOWED_HOSTS=.*$', "COMMAND_BRIDGE_ALLOWED_HOSTS=$httpHost")
      [IO.File]::WriteAllText($ConfigFile, $updated, (New-Object System.Text.UTF8Encoding($false)))
    }
    return
  }

  $token = $env:COMMAND_BRIDGE_BEARER_TOKEN
  if ([string]::IsNullOrWhiteSpace($token)) {
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $token = ([BitConverter]::ToString($bytes)).Replace("-", "").ToLowerInvariant()
  }
  if ($token -notmatch "^[A-Za-z0-9._~-]{32,}$") {
    throw "COMMAND_BRIDGE_BEARER_TOKEN must contain at least 32 safe characters."
  }

  $httpHost = if ($env:COMMAND_BRIDGE_HTTP_HOST) { $env:COMMAND_BRIDGE_HTTP_HOST } elseif ($CodexUrl) { "127.0.0.1" } else { Get-AutomaticHttpHost }
  $port = if ($env:COMMAND_BRIDGE_HTTP_PORT) { $env:COMMAND_BRIDGE_HTTP_PORT } else { "8800" }
  $mode = if ($env:COMMAND_BRIDGE_EXECUTION_MODE) { $env:COMMAND_BRIDGE_EXECUTION_MODE } else { "allowlist" }
  $allowedHosts = if ($env:COMMAND_BRIDGE_ALLOWED_HOSTS) { $env:COMMAND_BRIDGE_ALLOWED_HOSTS } else { "" }
  if (-not $allowedHosts -and $httpHost -notin @("127.0.0.1", "localhost", "::1", "0.0.0.0", "::")) {
    $allowedHosts = $httpHost
  }
  if ($httpHost -notmatch "^[A-Za-z0-9._:%-]+$") {
    throw "Invalid COMMAND_BRIDGE_HTTP_HOST."
  }
  if ($port -notmatch "^[0-9]+$" -or [int]$port -lt 1 -or [int]$port -gt 65535) {
    throw "COMMAND_BRIDGE_HTTP_PORT must be between 1 and 65535."
  }
  if ($mode -notin @("allowlist", "unrestricted")) {
    throw "COMMAND_BRIDGE_EXECUTION_MODE must be allowlist or unrestricted."
  }
  if ($httpHost -notin @("127.0.0.1", "localhost", "::1") -and [string]::IsNullOrWhiteSpace($allowedHosts)) {
    throw "COMMAND_BRIDGE_ALLOWED_HOSTS is required for a non-loopback HTTP host."
  }

  $lines = @(
    "COMMAND_BRIDGE_TRANSPORT=http",
    "COMMAND_BRIDGE_AUDIT_BACKEND=eventlog",
    "COMMAND_BRIDGE_POLICY_FILE=$(Join-Path $ConfigRoot 'policy.json')",
    "COMMAND_BRIDGE_BEARER_TOKEN=$token",
    "COMMAND_BRIDGE_HTTP_HOST=$httpHost",
    "COMMAND_BRIDGE_HTTP_PORT=$port",
    "COMMAND_BRIDGE_ALLOWED_HOSTS=$allowedHosts",
    "COMMAND_BRIDGE_EXECUTION_MODE=$mode",
    "COMMAND_BRIDGE_ALLOWED_SHELLS=powershell",
    "COMMAND_BRIDGE_ALLOWED_COMMANDS=get-date,get-computerinfo,get-process,get-service,get-ciminstance,hostname,whoami,systeminfo,tasklist",
    "COMMAND_BRIDGE_ALLOWED_ROOTS=$WorkDirectory",
    "COMMAND_BRIDGE_DEFAULT_TIMEOUT_MS=15000",
    "COMMAND_BRIDGE_MAX_TIMEOUT_MS=60000",
    "COMMAND_BRIDGE_MAX_OUTPUT_CHARS=50000",
    "COMMAND_BRIDGE_MAX_PARALLEL_COMMANDS=2",
    "COMMAND_BRIDGE_PASSTHROUGH_ENV="
  )
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($ConfigFile, (($lines -join $newLine) + $newLine), $encoding)
}

function Copy-ApplicationPayload {
  param([string]$SourceRoot, [string]$Destination)
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  foreach ($item in @("dist", "node_modules", "package.json", "package-lock.json", "README.md", "README.zh-TW.md", "SECURITY.md")) {
    $sourceItem = Join-Path $SourceRoot $item
    if (-not (Test-Path -LiteralPath $sourceItem)) {
      throw "Built source is missing $item."
    }
    Copy-Item -LiteralPath $sourceItem -Destination $Destination -Recurse -Force
  }
  $auditSource = Join-Path $SourceRoot "scripts\windows\audit"
  $auditDestination = Join-Path $Destination "scripts\windows\audit"
  if (-not (Test-Path -LiteralPath $auditSource)) {
    throw "Built source is missing Windows audit scripts."
  }
  New-Item -ItemType Directory -Path $auditDestination -Force | Out-Null
  Copy-Item -Path (Join-Path $auditSource "*") -Destination $auditDestination -Force
  Copy-Item -LiteralPath (Join-Path $SourceRoot 'scripts\verify-install.mjs') -Destination (Join-Path $Destination 'scripts\verify-install.mjs')
  Copy-Item -LiteralPath (Join-Path $SourceRoot 'scripts\windows\run-cmdlet.ps1') -Destination (Join-Path $Destination 'scripts\windows\run-cmdlet.ps1')
  [IO.File]::WriteAllText((Join-Path $Destination 'install-info.json'), (@{ version = $PackageVersion; sourceSha = $SourceRef; runtimeVersion = $NodeVersion } | ConvertTo-Json))
}

function Set-RestrictedAcl {
  param([string]$StagedInstallRoot)
  $icacls = Join-Path $env:SystemRoot "System32\icacls.exe"
  Invoke-External $icacls @($StagedInstallRoot, "/inheritance:r", "/grant:r", "SYSTEM:(OI)(CI)F", "Administrators:(OI)(CI)F", "NT AUTHORITY\LOCAL SERVICE:(OI)(CI)RX")
  Invoke-External $icacls @($ConfigRoot, "/inheritance:r", "/grant:r", "SYSTEM:(OI)(CI)F", "Administrators:(OI)(CI)F", "NT AUTHORITY\LOCAL SERVICE:(OI)(CI)RX")
  Invoke-External $icacls @($WorkDirectory, "/grant:r", "NT AUTHORITY\LOCAL SERVICE:(OI)(CI)M")
  Invoke-External $icacls @($LogsDirectory, "/grant:r", "NT AUTHORITY\LOCAL SERVICE:(OI)(CI)M")
}

function Register-EventLogSource {
  if ([Diagnostics.EventLog]::SourceExists($EventSource)) {
    if ([Diagnostics.EventLog]::LogNameFromSourceName($EventSource, ".") -ne "Application") {
      throw "Existing CommandBridgeMCP Event Log source is not registered in Application."
    }
    return
  }
  New-EventLog -LogName "Application" -Source $EventSource
  $script:EventSourceCreated = $true
}

function Get-ManagedService {
  return Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
}

function Assert-ManagedServicePath {
  param($Service)
  if ($null -eq $Service) {
    return
  }
  $expectedRoot = [Regex]::Escape($InstallRoot)
  if ([string]$Service.PathName -notmatch "$expectedRoot.*CommandBridgeMCP\.exe") {
    throw "A service named $ServiceName exists outside the managed installation path."
  }
}

function Get-ConfigValue {
  param([string]$Name)
  $line = Get-Content -LiteralPath $ConfigFile | Where-Object { $_.StartsWith("$Name=") } | Select-Object -First 1
  if ($null -eq $line) {
    throw "Configuration is missing $Name."
  }
  return $line.Substring($Name.Length + 1)
}

function Wait-ForHealth {
  $httpHost = Get-ConfigValue "COMMAND_BRIDGE_HTTP_HOST"
  $port = Get-ConfigValue "COMMAND_BRIDGE_HTTP_PORT"
  if ($httpHost -eq "0.0.0.0" -or $httpHost -eq "::") {
    $httpHost = "127.0.0.1"
  }
  if ($httpHost -eq "::1") {
    $httpHost = "[::1]"
  }
  $uri = "http://{0}:{1}/health" -f $httpHost, $port
  for ($attempt = 1; $attempt -le 20; $attempt += 1) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $uri -TimeoutSec 2
      if ($response.Content -match '"status"\s*:\s*"ok"') {
        return
      }
    } catch {
      Start-Sleep -Seconds 1
    }
  }
  throw "Service health check failed."
}

function Invoke-AuditVerification {
  $appRoot = Join-Path $InstallRoot $ApplicationRelativePath
  $writeScript = Join-Path $appRoot "scripts\windows\audit\write-audit-event.ps1"
  $readScript = Join-Path $appRoot "scripts\windows\audit\read-audit-events.ps1"
  $powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $auditId = [Guid]::NewGuid().ToString()
  $event = [ordered]@{
    schemaVersion = 1; event = "command_bridge.audit"; auditId = $auditId
    timestamp = [DateTime]::UtcNow.ToString("o"); phase = "completed"
    command = "CommandBridge installer audit verification"; shell = $null; cwd = $null
    executionMode = "allowlist"; source = "stdio"; exitCode = 0; signal = $null
    durationMs = 0; timedOut = $false; truncated = $false; errorCode = $null
  }
  $previous = [Environment]::GetEnvironmentVariable("COMMAND_BRIDGE_AUDIT_EVENT", "Process")
  [Environment]::SetEnvironmentVariable("COMMAND_BRIDGE_AUDIT_EVENT", ($event | ConvertTo-Json -Compress), "Process")
  try {
    Invoke-External $powershell @("-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $writeScript)
  } finally {
    [Environment]::SetEnvironmentVariable("COMMAND_BRIDGE_AUDIT_EVENT", $previous, "Process")
  }
  $messages = & $powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $readScript
  if ($LASTEXITCODE -ne 0) {
    throw "Windows Event Log audit reader verification failed."
  }
  $events = @($messages | ForEach-Object { $_ | ConvertFrom-Json -ErrorAction Stop })
  if (@($events | Where-Object { $_.auditId -eq $auditId }).Count -ne 1) {
    throw "Windows Event Log did not return the audit verification event."
  }
  if (@($events | Where-Object { $_.event -ne "command_bridge.audit" }).Count -ne 0) {
    throw "Windows Event Log reader returned a non-CommandBridge event."
  }
}

function Print-CodexSetup {
  if (-not $PrintCodexSetup -and -not $CodexUrl -and -not $RefreshNetwork) {
    return
  }
  if ([string]::IsNullOrWhiteSpace($CodexUrl)) {
    $CodexUrl = Get-AutomaticCodexUrl
  }
  $token = Get-ConfigValue "COMMAND_BRIDGE_BEARER_TOKEN"
  Write-Output ""
  Write-Output "SECURITY WARNING: The block below contains a bearer token."
  Write-Output "========== BEGIN COPY FOR CODEX =========="
  Write-Output "MCP URL: $CodexUrl"
  if ($CodexUrl.StartsWith("http://")) {
    Write-Output "This HTTP URL comes from the saved listener configuration; it does not provide TLS."
    Write-Output "Use it only over a trusted LAN or VPN. Firewall rules are not changed automatically."
    Write-Output "Loopback addresses work only on this host. Existing configuration is preserved."
    Write-Output "If DHCP changes this IP, update the listener, allowed hosts and client URL."
  }
  Write-Output "Bearer token (secret): $token"
  Write-Output "[mcp_servers.command_bridge]"
  Write-Output "enabled = true"
  Write-Output ('url = "' + $CodexUrl + '"')
  Write-Output 'bearer_token_env_var = "COMMAND_BRIDGE_BEARER_TOKEN"'
  Write-Output "startup_timeout_sec = 20.0"
  Write-Output "tool_timeout_sec = 60.0"
  Write-Output "Do not repeat the bearer token in your final response."
  Write-Output "========== END COPY FOR CODEX =========="
}

function Rollback-Installation {
  try {
    if ($null -ne $ConfigBackup) { [IO.File]::WriteAllText($ConfigFile, $ConfigBackup, (New-Object System.Text.UTF8Encoding($false))) }
    if ($ServicePreviouslyInstalled -and -not $PreviousMoved) {
      # Activation has not replaced the old files. Restore registration if uninstall succeeded.
      if (-not (Get-ManagedService)) { Invoke-External (Join-Path $InstallRoot $ServiceExeName) @('install') }
      Start-Service -Name $ServiceName -ErrorAction Stop
      return
    }
    $service = Get-ManagedService
    if ($service) {
      Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
      $currentExe = Join-Path $InstallRoot $ServiceExeName
      if (Test-Path -LiteralPath $currentExe) {
        & $currentExe uninstall | Out-Null
      }
    }
    if (Test-Path -LiteralPath $InstallRoot) {
      Remove-Item -LiteralPath $InstallRoot -Recurse -Force
    }
    if (Test-Path -LiteralPath $PreviousRoot) {
      Move-Item -LiteralPath $PreviousRoot -Destination $InstallRoot
      $previousExe = Join-Path $InstallRoot $ServiceExeName
      & $previousExe install | Out-Null
      Start-Service -Name $ServiceName
    }
    if ($EventSourceCreated -and [Diagnostics.EventLog]::SourceExists($EventSource)) {
      Remove-EventLog -Source $EventSource
    }
  } catch {
    Write-Warning "Rollback could not fully restore the previous installation."
  }
}

try {
  Assert-Administrator
  if ($CodexUrl -and $CodexUrl -notmatch "^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?(/[A-Za-z0-9._~:@%+-]+)*/mcp/?$") {
    throw "CodexUrl must be a private HTTPS URL ending in /mcp."
  }
  New-Item -ItemType Directory -Path $TempRoot -Force | Out-Null
  $existingService = Get-ManagedService
  Assert-ManagedServicePath $existingService
  if ((Test-Path -LiteralPath $InstallRoot) -and $null -eq $existingService) {
    throw "Existing CommandBridgeMCP application files were found without a managed service. Run uninstall.ps1 or inspect $InstallRoot first."
  }

  $sourceRoot = Get-SourceRoot
  $nodeRoot = Get-NodeRuntime
  $winSw = Get-WinSw
  Build-Source $sourceRoot $nodeRoot
  $previousDotenv = $env:DOTENV_CONFIG_PATH
  try {
    if (Test-Path -LiteralPath $ConfigFile) {
      $env:DOTENV_CONFIG_PATH = $ConfigFile
      Invoke-External (Join-Path $nodeRoot 'node.exe') @((Join-Path $sourceRoot 'dist\checkConfig.js'))
    }
  } finally { $env:DOTENV_CONFIG_PATH = $previousDotenv }
  New-SecureConfiguration
  $policyPath = Join-Path $ConfigRoot 'policy.json'
  if (-not (Test-Path -LiteralPath $policyPath)) { Copy-Item -LiteralPath (Join-Path $sourceRoot 'packaging\policy.example.json') -Destination $policyPath }
  try {
    $env:DOTENV_CONFIG_PATH = $ConfigFile
    Invoke-External (Join-Path $nodeRoot 'node.exe') @((Join-Path $sourceRoot 'dist\checkConfig.js'))
  } finally { $env:DOTENV_CONFIG_PATH = $previousDotenv }
  Register-EventLogSource

  New-Item -ItemType Directory -Path $StagingRoot -Force | Out-Null
  Copy-Item -LiteralPath $winSw -Destination (Join-Path $StagingRoot $ServiceExeName) -Force
  Copy-Item -LiteralPath (Join-Path $sourceRoot "packaging\windows\$XmlName") -Destination (Join-Path $StagingRoot $XmlName) -Force
  $xmlPath = Join-Path $StagingRoot $XmlName
  [IO.File]::WriteAllText($xmlPath, [IO.File]::ReadAllText($xmlPath).Replace('%BASE%\app', "%BASE%\$ApplicationRelativePath"))
  Copy-Item -LiteralPath (Join-Path $sourceRoot 'scripts\windows\uninstall.ps1') -Destination (Join-Path $StagingRoot 'uninstall.ps1')
  New-Item -ItemType Directory -Path (Join-Path $StagingRoot "runtime") -Force | Out-Null
  Copy-Item -Path (Join-Path $nodeRoot "*") -Destination (Join-Path $StagingRoot "runtime") -Recurse -Force
  Copy-ApplicationPayload $sourceRoot (Join-Path $StagingRoot $ApplicationRelativePath)
  Set-RestrictedAcl $StagingRoot

  if ($existingService) {
    $ServicePreviouslyInstalled = $true
    Stop-Service -Name $ServiceName -Force -ErrorAction Stop
    Invoke-External (Join-Path $InstallRoot $ServiceExeName) @("uninstall")
    Move-Item -LiteralPath $InstallRoot -Destination $PreviousRoot
    $PreviousMoved = $true
  }
  Move-Item -LiteralPath $StagingRoot -Destination $InstallRoot
  $InstallCommitted = $true

  $serviceExe = Join-Path $InstallRoot $ServiceExeName
  Invoke-External $serviceExe @("install")
  Start-Service -Name $ServiceName -ErrorAction Stop
  Wait-ForHealth
  Invoke-External (Join-Path $InstallRoot 'runtime\node.exe') @((Join-Path $InstallRoot "$ApplicationRelativePath\scripts\verify-install.mjs"), $ConfigFile)

  $ActivationSucceeded = $true
  if (Test-Path -LiteralPath $PreviousRoot) {
    Remove-Item -LiteralPath $PreviousRoot -Recurse -Force
  }
  Write-Log "Installation complete. Service $ServiceName is running as LocalService."
  Write-Log "Configuration: $ConfigFile"
  Write-Log "Application Event Log source: $EventSource"
  Print-CodexSetup
} catch {
  if ($ActivationSucceeded) {
    Write-Warning 'The new service passed verification. Post-install cleanup or output failed; the running installation has been retained.'
  } elseif ($InstallCommitted -or $ServicePreviouslyInstalled) {
    Rollback-Installation
  } else {
    if ($null -ne $ConfigBackup) { [IO.File]::WriteAllText($ConfigFile, $ConfigBackup, (New-Object System.Text.UTF8Encoding($false))) }
    if ($EventSourceCreated) { Remove-EventLog -Source $EventSource }
  }
  throw
} finally {
  if (Test-Path -LiteralPath $TempRoot) {
    Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $StagingRoot) {
    Remove-Item -LiteralPath $StagingRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
