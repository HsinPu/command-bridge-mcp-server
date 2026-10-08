# The fixed host supplies a UTF-8 console even when the Node service has none.
# User command text is used only by cmd in guarded/unrestricted Shell mode.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$command = [Environment]::GetEnvironmentVariable('COMMAND_BRIDGE_CMD_REQUEST')
[Environment]::SetEnvironmentVariable('COMMAND_BRIDGE_CMD_REQUEST', $null)
if ($null -eq $command) { throw 'Missing cmd request.' }
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = [IO.Path]::Combine($env:SystemRoot, 'System32', 'cmd.exe')
# /s removes the outer pair; do not use CRT quoting for cmd source text.
$start.Arguments = '/d /s /c "' + $command + '"'
$start.UseShellExecute = $false
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$process = [Diagnostics.Process]::new()
$process.StartInfo = $start
try {
  if (-not $process.Start()) { throw 'Could not start cmd.' }
  # Forward raw bytes independently: no line formatting or second text decode.
  $stdout = $process.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
  $stderr = $process.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
  $process.WaitForExit()
  $null = $stdout.GetAwaiter().GetResult()
  $null = $stderr.GetAwaiter().GetResult()
  $exitCode = $process.ExitCode
} finally { $process.Dispose() }
exit $exitCode
