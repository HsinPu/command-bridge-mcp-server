Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$UpdateRoot = Join-Path $env:ProgramData 'CommandBridgeUpdate'
function Read-UpdateRecord([string]$Id) {
  if ($Id -and $Id -cnotmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') { throw 'Invalid job ID.' }
  $name = if ($Id) { "$Id.json" } else { 'latest.json' }
  return (Get-Content -LiteralPath (Join-Path $UpdateRoot $name) -Raw | ConvertFrom-Json)
}
function Get-UpdateTask {
  $scheduler = New-Object -ComObject Schedule.Service
  $scheduler.Connect()
  return $scheduler.GetFolder('\').GetTask('CommandBridgeUpdate')
}
function Write-UpdateRecord($Job) {
  $json = $Job | ConvertTo-Json -Compress -Depth 5
  $audit = Join-Path $UpdateRoot 'audit.jsonl'
  if ((Test-Path -LiteralPath $audit) -and (Get-Item -LiteralPath $audit).Length -gt 10MB) {
    if (Test-Path -LiteralPath "$audit.4") { Remove-Item -LiteralPath "$audit.4" }
    for ($i=3; $i -ge 1; $i--) { if (Test-Path -LiteralPath "$audit.$i") { Move-Item -LiteralPath "$audit.$i" -Destination "$audit.$($i+1)" } }
    Move-Item -LiteralPath $audit -Destination "$audit.1"
  }
  [IO.File]::AppendAllText($audit, $json + "`n", (New-Object Text.UTF8Encoding($false)))
  foreach ($name in @("$($Job.jobId).json", 'latest.json')) {
    $temp = Join-Path $UpdateRoot ('.' + [guid]::NewGuid())
    [IO.File]::WriteAllText($temp, $json, (New-Object Text.UTF8Encoding($false)))
    $dest = Join-Path $UpdateRoot $name
    if (Test-Path -LiteralPath $dest) { [IO.File]::Replace($temp, $dest, $null) } else { [IO.File]::Move($temp, $dest) }
  }
}
function Read-InstalledIdentity {
  $info = Get-Content -LiteralPath (Join-Path $env:ProgramFiles 'CommandBridgeMCP\install-info.json') -Raw | ConvertFrom-Json
  if ($info.sourceSha -cnotmatch '^[a-f0-9]{40}$' -or $info.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid installation identity.' }
  return @{ version=$info.version; sourceSha=$info.sourceSha }
}
function Assert-UpdateEnabled {
  $config = [IO.File]::ReadAllText((Join-Path $env:ProgramData 'CommandBridgeMCP\command-bridge.env'))
  $settings = @([regex]::Matches($config, '(?m)^\s*COMMAND_BRIDGE_MCP_UPDATE_ENABLED\s*=([^\r\n]*)'))
  if ($settings.Count -gt 1) { throw 'Duplicate update setting.' }
  if ($settings.Count -eq 1) {
    $raw = $settings[0].Groups[1].Value.Trim()
    $match = [regex]::Match($raw, '^(?:"([^"]*)"|''([^'']*)''|([^#\s]*))\s*(?:#.*)?$')
    if (-not $match.Success) { throw 'Invalid update setting.' }
    $value = if ($match.Groups[1].Success) { $match.Groups[1].Value } elseif ($match.Groups[2].Success) { $match.Groups[2].Value } else { $match.Groups[3].Value }
    if ($value -cne 'true') { throw 'Managed update disabled or invalid.' }
  }
}
