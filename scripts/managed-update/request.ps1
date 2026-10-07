[CmdletBinding()]
param()
$requestStage = 0
trap {
  @{ controlError=$true; stage=$requestStage; hresult=$_.Exception.HResult; line=$_.InvocationInfo.ScriptLineNumber } | ConvertTo-Json -Compress
  exit 1
}
$requestStage = 1
. (Join-Path $PSScriptRoot 'common.ps1')
$previous = $null
try { $previous = Read-UpdateRecord '' } catch {}
$requestStage = 2
$task = Get-UpdateTask
if ($task.State -eq 4 -and $previous) { $previous | ConvertTo-Json -Compress -Depth 5; exit }
$requestStage = 3
$null = $task.Run($null)
$requestStage = 4
for ($i=0; $i -lt 40; $i++) {
  try {
    $job = Read-UpdateRecord ''
    if (-not $previous -or $job.jobId -ne $previous.jobId) { $job | ConvertTo-Json -Compress -Depth 5; exit }
  } catch {}
  Start-Sleep -Milliseconds 250
}
throw 'Update acknowledgment unavailable; query latest status before retrying.'
