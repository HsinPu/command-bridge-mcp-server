$ErrorActionPreference = 'Stop'
$installer = Join-Path $PSScriptRoot '..\install.ps1'
$ast = [Management.Automation.Language.Parser]::ParseFile($installer, [ref]$null, [ref]$null)
foreach ($statement in $ast.EndBlock.Statements) {
  if ($statement -is [Management.Automation.Language.FunctionDefinitionAst]) { . ([scriptblock]::Create($statement.Extent.Text)) }
}
# Pure output probe: no installation, actual token or host configuration.
function Get-ConfigValue([string]$Key) { return ('0' * 64) }
$PrintCodexSetup = $true
$CodexUrl = 'https://diagnostic.example.com/mcp'
$CodexName = 'cb_timeout_probe'
$RefreshNetwork = $false
$output = @(Print-CodexSetup)
if ($output -notcontains 'tool_timeout_sec = 360.0') { throw 'Incorrect Codex tool deadline.' }
if ($output -notcontains '[mcp_servers.cb_timeout_probe]') { throw 'Incorrect connection name.' }
Write-Output 'Windows Codex setup timeout checks passed.'
