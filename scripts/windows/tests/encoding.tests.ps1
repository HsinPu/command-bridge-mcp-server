Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# ASCII script source is deliberate: PowerShell 5.1 misreads non-ASCII no-BOM scripts.
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '..\install.ps1'), [ref]$null, [ref]$null)
foreach ($statement in $ast.EndBlock.Statements) {
  if ($statement -is [Management.Automation.Language.FunctionDefinitionAst]) { . ([scriptblock]::Create($statement.Extent.Text)) }
}
$root = Join-Path $env:TEMP ('cb-text-config-' + [guid]::NewGuid())
[void][IO.Directory]::CreateDirectory($root)
$chinese = ([char]0x4e2d).ToString() + [char]0x6587 + [char]::ConvertFromUtf32(0x1f642)
$ConfigFile = Join-Path $root ($chinese + '.env')
$ConfigRoot = $root; $WorkDirectory = $root; $LogsDirectory = $root
$ClientSetupChanged = $false
$ConfigAclBackup = $null
$EnableFileTransfer = $false; $EnableUpload = $false; $EnableDownload = $false
$RefreshNetwork = $true
function Write-Log($Message) {}
function Get-AutomaticHttpHost { return '127.0.0.2' }
try {
  if ((Set-ConfigurationTextValue 'PATH=old' '^PATH=.*$' 'PATH=C:\$1\literal') -cne 'PATH=C:\$1\literal') { throw 'Literal path replacement expanded dollar signs.' }
  $common = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '..\..\managed-update\common.ps1'), [ref]$null, [ref]$null)
  foreach ($statement in $common.EndBlock.Statements) {
    if ($statement -is [Management.Automation.Language.FunctionDefinitionAst] -and $statement.Name -eq 'Get-Utf8LogTail') { . ([scriptblock]::Create($statement.Extent.Text)) }
  }
  foreach ($limit in @(4,5,6,7,8,9,10)) {
    $bytes = [Text.Encoding]::UTF8.GetBytes(($chinese * 10))
    $tail = Get-Utf8LogTail $bytes $limit
    $text = [Text.UTF8Encoding]::new($false,$true).GetString($tail)
    if (-not ($chinese * 10).EndsWith($text) -or $tail.Length -gt $limit) { throw 'UTF-8 log tail cut through a character.' }
  }
  foreach ($bom in @($false, $true)) {
    foreach ($newline in @("`n", "`r`n")) {
      $original = "# $chinese$newline" + "COMMAND_BRIDGE_EXECUTION_MODE=allowlist$newline" +
        "COMMAND_BRIDGE_HTTP_HOST=127.0.0.1$newline" + "COMMAND_BRIDGE_ALLOWED_HOSTS=127.0.0.1$newline" +
        "COMMAND_BRIDGE_ALLOWED_ROOTS=C:\$chinese$newline" + "COMMAND_BRIDGE_TRANSFER_ROOT=C:\$chinese$newline" +
        "COMMAND_BRIDGE_UPLOAD_ENABLED=false$newline" + "COMMAND_BRIDGE_BEARER_TOKEN=fixture-value$newline" + "# keep last line"
      [IO.File]::WriteAllText($ConfigFile, $original, [Text.UTF8Encoding]::new($bom, $true))
      $before = [IO.File]::ReadAllBytes($ConfigFile)
      $ConfigBackup = $null; $ExecutionMode = 'guarded'; $EnableUpload = $false
      if ((Get-ConfigValue 'COMMAND_BRIDGE_ALLOWED_ROOTS') -cne "C:\$chinese") { throw 'Chinese configuration value was misread.' }
      New-SecureConfiguration
      $expected = $original.Replace('EXECUTION_MODE=allowlist', 'EXECUTION_MODE=guarded').Replace('127.0.0.1', '127.0.0.2')
      if ((Read-Utf8Configuration) -cne $expected) { throw 'Mode or network edit changed unrelated UTF-8 contents/newlines.' }
      $EnableUpload = $true; Set-TransferConfiguration
      if ((Get-ConfigValue 'COMMAND_BRIDGE_TRANSFER_ROOT') -cne "C:\$chinese") { throw 'Transfer edit damaged Chinese paths.' }
      $current = [IO.File]::ReadAllBytes($ConfigFile)
      if ($bom -and ($current[0] -ne 239 -or $current[1] -ne 187 -or $current[2] -ne 191)) { throw 'UTF-8 BOM was lost.' }
      Restore-ConfigurationBytes
      if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($ConfigFile)) -cne [Convert]::ToBase64String($before)) { throw 'Rollback did not restore exact original bytes.' }
    }
  }
  foreach ($bytes in @([byte[]](255,254,65,0), [byte[]](35,32,228), [byte[]](164,164,164,229))) {
    [IO.File]::WriteAllBytes($ConfigFile, $bytes)
    $ConfigBackup = $null; $EnableUpload = $false
    $rejected = $false
    try { New-SecureConfiguration } catch { if ($_.Exception.Message -match 'valid UTF-8') { $rejected = $true } else { throw } }
    if (-not $rejected) { throw 'Invalid configuration encoding was accepted.' }
    if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($ConfigFile)) -cne [Convert]::ToBase64String($bytes)) { throw 'Invalid configuration was rewritten.' }
    if ($null -ne $ConfigBackup) { throw 'Invalid bytes were published as a rollback snapshot.' }
  }
  Write-Output 'UTF-8 configuration reads, BOM/newline preservation and byte-exact rollback passed.'
} finally {
  $resolved = [IO.Path]::GetFullPath($root)
  if (-not $resolved.StartsWith([IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe encoding fixture cleanup path.' }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
