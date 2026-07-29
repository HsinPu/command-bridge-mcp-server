[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$eventJson = [Environment]::GetEnvironmentVariable("COMMAND_BRIDGE_AUDIT_EVENT", "Process")
if ([string]::IsNullOrWhiteSpace($eventJson)) {
  throw "CommandBridge audit event payload is missing."
}

try {
  $event = $eventJson | ConvertFrom-Json -ErrorAction Stop
} catch {
  throw "CommandBridge audit event payload is invalid."
}

if (
  $event.schemaVersion -ne 1 -or
  $event.event -ne "command_bridge.audit" -or
  [string]::IsNullOrWhiteSpace([string]$event.auditId) -or
  [string]::IsNullOrWhiteSpace([string]$event.timestamp)
) {
  throw "CommandBridge audit event payload is invalid."
}

switch ([string]$event.phase) {
  "attempted" {
    $eventId = 1000
    $entryType = "Information"
  }
  "blocked" {
    $eventId = 1001
    $entryType = "Warning"
  }
  "completed" {
    $eventId = 1002
    $entryType = "Information"
  }
  "failed" {
    $eventId = 1003
    $entryType = "Error"
  }
  default {
    throw "CommandBridge audit event phase is invalid."
  }
}

Write-EventLog -LogName "Application" -Source "CommandBridgeMCP" -EventId $eventId -EntryType $entryType -Message $eventJson -Category 0 -ErrorAction Stop
