[CmdletBinding()]
param([string]$JobId)
. ([IO.Path]::Combine($PSScriptRoot, 'common.ps1'))
$job = Read-UpdateRecord $JobId
if ($job.state -in @('accepted','running') -and (Get-UpdateTask).State -ne 4) {
  $job.state = 'interrupted'; $job.errorCode = 'UPDATE_INTERRUPTED'
}
$job | ConvertTo-Json -Compress -Depth 5
