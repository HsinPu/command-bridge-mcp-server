function Assert-ManagedUpdateDirectory([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $item = Get-Item -LiteralPath $Path -Force
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe managed update directory.' }
  $acl = Get-Acl -LiteralPath $Path
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($owner -notin @('S-1-5-18','S-1-5-32-544')) { throw 'Managed update directory must be owned by SYSTEM or Administrators.' }
  $write = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
  foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $write) -and $rule.IdentityReference.Value -notin @('S-1-5-18','S-1-5-32-544','S-1-3-0')) { throw 'Managed update directory is writable by non-administrators.' }
  }
}
function Set-ManagedUpdateAcl([string]$Path) {
  Invoke-External "$env:SystemRoot\System32\icacls.exe" @($Path,'/inheritance:r','/grant:r','*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F','*S-1-5-19:(OI)(CI)RX')
  Invoke-External "$env:SystemRoot\System32\icacls.exe" @($Path,'/setowner','*S-1-5-32-544')
}
function Install-ManagedUpdater([string]$Source) {
  $script:UpdaterProgram = Join-Path $env:ProgramFiles 'CommandBridgeUpdate'
  $state = Join-Path $env:ProgramData 'CommandBridgeUpdate'
  Assert-ManagedUpdateDirectory $UpdaterProgram
  Assert-ManagedUpdateDirectory $state
  New-Item -ItemType Directory -Path $state -Force | Out-Null
  Set-ManagedUpdateAcl $state
  $diagnostics = Join-Path $state 'diagnostics'
  Assert-ManagedUpdateDirectory $diagnostics
  New-Item -ItemType Directory -Path $diagnostics -Force | Out-Null
  Invoke-External "$env:SystemRoot\System32\icacls.exe" @($diagnostics,'/inheritance:r','/grant:r','*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F')
  Invoke-External "$env:SystemRoot\System32\icacls.exe" @($diagnostics,'/setowner','*S-1-5-32-544')
  $script:UpdaterOldTask = $null
  $existingTask = $null
  try { $scheduler=New-Object -ComObject Schedule.Service; $scheduler.Connect(); $existingTask=$scheduler.GetFolder('\').GetTask('CommandBridgeUpdate') } catch {}
  if ($existingTask) {
    $action = $existingTask.Definition.Actions.Item(1)
    $expected = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + (Join-Path $UpdaterProgram 'worker.ps1') + '"'
    if ($existingTask.Definition.Actions.Count -ne 1 -or $action.Path -ine "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -or $action.Arguments -cne $expected -or $existingTask.Definition.Principal.UserId -notin @('SYSTEM','S-1-5-18')) { throw 'An unrelated task uses the managed updater name.' }
    $script:UpdaterOldTask=@{xml=$existingTask.Xml; sddl=$existingTask.GetSecurityDescriptor(7)}
  }
  $script:UpdaterBackup = Join-Path $TempRoot 'update-assets-backup'
  New-Item -ItemType Directory -Path $UpdaterBackup | Out-Null
  $script:UpdaterPreviouslyPresent = Test-Path -LiteralPath $UpdaterProgram
  if ($UpdaterPreviouslyPresent) { Get-ChildItem -LiteralPath $UpdaterProgram -File | Copy-Item -Destination $UpdaterBackup }
  $script:UpdaterChanged = $true
  New-Item -ItemType Directory -Path $UpdaterProgram -Force | Out-Null
  Set-ManagedUpdateAcl $UpdaterProgram
  foreach ($name in @('common.ps1','request.ps1','status.ps1','worker.ps1','deployment-lock.ps1')) {
    $dest=Join-Path $UpdaterProgram $name
    if ((Test-Path -LiteralPath $dest) -and ((Get-Item -LiteralPath $dest).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe update asset.' }
    $sourceAsset = if ($name -eq 'deployment-lock.ps1') { Join-Path $Source 'scripts\windows\deployment-lock.ps1' } else { Join-Path $Source "scripts\managed-update\$name" }
    Copy-Item -LiteralPath $sourceAsset -Destination $dest -Force
  }
  $ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  $action=New-ScheduledTaskAction -Execute $ps -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + (Join-Path $UpdaterProgram 'worker.ps1') + '"')
  $principal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 45) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName 'CommandBridgeUpdate' -Action $action -Principal $principal -Settings $settings -Force | Out-Null
  $scheduler=New-Object -ComObject Schedule.Service; $scheduler.Connect()
  $scheduler.GetFolder('\').GetTask('CommandBridgeUpdate').SetSecurityDescriptor('D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX;;;LS)',0)
}
function Restore-ManagedUpdater {
  if (-not $script:UpdaterChanged) { return }
  if ($UpdaterOldTask) {
    Register-ScheduledTask -TaskName 'CommandBridgeUpdate' -Xml $UpdaterOldTask.xml -Force | Out-Null
    $scheduler=New-Object -ComObject Schedule.Service; $scheduler.Connect(); $scheduler.GetFolder('\').GetTask('CommandBridgeUpdate').SetSecurityDescriptor($UpdaterOldTask.sddl,0)
  } else { Unregister-ScheduledTask -TaskName 'CommandBridgeUpdate' -Confirm:$false -ErrorAction SilentlyContinue }
  if ($UpdaterPreviouslyPresent) { Get-ChildItem -LiteralPath $UpdaterBackup -File | Copy-Item -Destination $UpdaterProgram -Force }
  elseif (Test-Path -LiteralPath $UpdaterProgram) {
    if ([IO.Path]::GetFullPath($UpdaterProgram) -cne [IO.Path]::GetFullPath((Join-Path $env:ProgramFiles 'CommandBridgeUpdate'))) { throw 'Unsafe rollback cleanup path.' }
    Remove-Item -LiteralPath $UpdaterProgram -Recurse -Force
  }
  $script:UpdaterChanged=$false
}
