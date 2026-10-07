[CmdletBinding()]
param()
. (Join-Path $PSScriptRoot 'common.ps1')
$previous = $null
try { $previous = Read-UpdateRecord '' } catch {}
$task = Get-UpdateTask
if ($task.State -eq 4 -and $previous) { $previous | ConvertTo-Json -Compress -Depth 5; exit }
$null = $task.Run($null)
for ($i=0; $i -lt 40; $i++) {
  try {
    $job = Read-UpdateRecord ''
    if (-not $previous -or $job.jobId -ne $previous.jobId) { $job | ConvertTo-Json -Compress -Depth 5; exit }
  } catch {}
  Start-Sleep -Milliseconds 250
}
throw 'Update acknowledgment unavailable; query latest status before retrying.'
