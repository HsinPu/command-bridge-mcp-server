[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$records = Get-WinEvent -FilterHashtable @{
  LogName = "Application"
  ProviderName = "CommandBridgeMCP"
} -MaxEvents 101 -ErrorAction Stop

foreach ($record in $records) {
  # Write-EventLog stores its supplied string as an insertion value. Prefer it
  # over .Message: hosts without a MessageResourceFile can render .Message as
  # a localized "description cannot be found" wrapper around that value.
  $message = if ($record.Properties.Count -gt 0) {
    [string]$record.Properties[0].Value
  } else {
    [string]$record.Message
  }
  if ([string]::IsNullOrWhiteSpace($message)) { continue }

  try {
    $event = $message | ConvertFrom-Json -ErrorAction Stop
    if (
      $event.schemaVersion -eq 1 -and
      $event.event -eq "command_bridge.audit" -and
      -not [string]::IsNullOrWhiteSpace([string]$event.auditId) -and
      -not [string]::IsNullOrWhiteSpace([string]$event.timestamp)
    ) {
      [Console]::Out.WriteLine($message)
    }
  } catch {
    # A malformed application event is not a CommandBridge audit event.
  }
}
