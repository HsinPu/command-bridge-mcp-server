[CmdletBinding()]
param()
. (Join-Path $PSScriptRoot 'common.ps1')
$job = $null; $work = $null; $lock = $null; $failed = $false
try {
  . (Join-Path $PSScriptRoot "deployment-lock.ps1")
  $lock=Enter-CommandBridgeDeploymentLock
  Assert-UpdateEnabled
  try {
    $old = Read-UpdateRecord ''
    if ($old.state -in @('accepted','running')) { $old.state='interrupted'; $old.errorCode='UPDATE_INTERRUPTED'; $old.finishedAt=[DateTime]::UtcNow.ToString('o'); Write-UpdateRecord $old }
  } catch {}
  $job = @{ schemaVersion=1; jobId=[guid]::NewGuid().ToString(); state='accepted'; startedAt=[DateTime]::UtcNow.ToString('o'); finishedAt=$null; before=(Read-InstalledIdentity); after=$null; errorCode=$null }
  Write-UpdateRecord $job
  $lock.ReleaseMutex(); $lock.Dispose(); $lock=$null
  Start-Sleep -Seconds 10
  Assert-UpdateEnabled
  $job.state = 'running'; Write-UpdateRecord $job
  $work = Join-Path $UpdateRoot ('work-' + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $work | Out-Null
  & "$env:SystemRoot\System32\icacls.exe" $work /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Private work ACL failed.' }
  $bootstrap = Join-Path $work 'bootstrap.ps1'
  Copy-Item -LiteralPath (Join-Path $env:ProgramFiles 'CommandBridgeMCP\bootstrap.ps1') -Destination $bootstrap
  & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $bootstrap -Update *> (Join-Path $work 'install.log')
  if ($LASTEXITCODE -ne 0) { throw 'Managed installation failed.' }
  $job.after = Read-InstalledIdentity; $job.state = 'succeeded'
} catch {
  $failed = $true
  if ($job) { $job.state = 'failed'; $job.errorCode = 'UPDATE_INSTALL_FAILED'; try { $job.after = Read-InstalledIdentity } catch {} }
} finally {
  if ($lock) { $lock.ReleaseMutex(); $lock.Dispose() }
  if ($job) { $job.finishedAt=[DateTime]::UtcNow.ToString('o'); Write-UpdateRecord $job }
  if ($work) {
    $resolved=[IO.Path]::GetFullPath($work)
    if (-not $resolved.StartsWith([IO.Path]::GetFullPath($UpdateRoot).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe update cleanup path.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
  Get-ChildItem -LiteralPath $UpdateRoot -Filter '*.json' | Where-Object { $_.Name -match '^[a-f0-9-]{36}\.json$' } | Sort-Object LastWriteTimeUtc -Descending | Select-Object -Skip 20 | Remove-Item -Force
}

if ($failed) { exit 1 }
