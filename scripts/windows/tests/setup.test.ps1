$ErrorActionPreference = 'Stop'
$installer = Join-Path $PSScriptRoot '..\install.ps1'
$ast = [Management.Automation.Language.Parser]::ParseFile($installer, [ref]$null, [ref]$null)
foreach ($statement in $ast.EndBlock.Statements) {
  if ($statement -is [Management.Automation.Language.FunctionDefinitionAst]) { . ([scriptblock]::Create($statement.Extent.Text)) }
}
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$helper = Join-Path $project 'dist\cli\clientSetupInstaller.js'
$node = (Get-Command node.exe).Source
$private = Join-Path $env:TEMP ('cb-setup-probe-' + [guid]::NewGuid())
[void][IO.Directory]::CreateDirectory($private)
$InstallRoot = $private; $ApplicationRelativePath = 'app'
$ConfigFile = Join-Path $private 'config.env'; $ClientSetupFile = Join-Path $private 'client.json'
$PrintCodexSetup = $true; $CodexUrl = ''; $CodexName = ''; $RefreshNetwork = $false
try {
  [IO.File]::WriteAllText($ConfigFile, ("COMMAND_BRIDGE_HTTP_HOST=127.0.0.1`nCOMMAND_BRIDGE_BEARER_TOKEN=" + ('0' * 64)))
  & $node $helper prepare $ConfigFile (Join-Path $private 'absent.json') $ClientSetupFile cb_timeout_probe https://diagnostic.example.com/mcp -
  if ($LASTEXITCODE -ne 0) { throw 'Shared helper preparation failed.' }
  function Invoke-External([string]$FilePath, [string[]]$ArgumentList) {
    if ($FilePath -ne (Join-Path $InstallRoot 'runtime\node.exe') -or $ArgumentList[0] -ne (Join-Path $InstallRoot 'app\dist\cli\clientSetupInstaller.js')) { throw 'Output used an unexpected runtime or helper.' }
    & $node $helper @($ArgumentList[1..($ArgumentList.Count-1)])
    if ($LASTEXITCODE -ne 0) { throw 'Shared renderer failed.' }
  }
  $output = @(Print-CodexSetup)
  if ($output -notcontains 'tool_timeout_sec = 360.0' -or $output -notcontains '[mcp_servers.cb_timeout_probe]') { throw 'Incorrect saved setup output.' }
  $hidden = @(& $node $helper print $ConfigFile $ClientSetupFile hidden)
  if (($hidden -join "`n").Contains(('0' * 64))) { throw 'Hidden output included a token.' }
  Write-Output 'Windows shared Codex setup checks passed.'
} finally {
  $resolved = [IO.Path]::GetFullPath($private)
  if (-not $resolved.StartsWith([IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe private cleanup path.' }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
