[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$PSModuleAutoLoadingPreference='None'
$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')
Import-Module ([IO.Path]::Combine($PSHOME,'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1'))
Import-Module ([IO.Path]::Combine($PSHOME,'Modules\Microsoft.PowerShell.Management\Microsoft.PowerShell.Management.psd1'))
$result=@{schemaVersion=1;service=@{state='unknown';restartCount=$null;exitCode=$null};reader=@{status='ok';reason=$null};storage=@();errors=@()}
try {$service=Get-Service -Name CommandBridgeMCP -ErrorAction Stop; $result.service.state=if($service.Status -eq 'Running'){'running'}elseif($service.Status -eq 'Stopped'){'stopped'}else{'unknown'}} catch {if($_.FullyQualifiedErrorId -like 'NoServiceFoundForGivenName*'){$result.service.state='notInstalled'}else{$result.reader=@{status='unavailable';reason='readerFailed'}}}
foreach($item in @(@('application',[IO.Path]::Combine($env:ProgramFiles,'CommandBridgeMCP')),@('audit',[IO.Path]::Combine($env:ProgramData,'CommandBridgeMCP\logs')),@('work',[IO.Path]::Combine($env:ProgramData,'CommandBridgeMCP\work')))) {
 $free=$null
 try {$drive=New-Object IO.DriveInfo([IO.Path]::GetPathRoot($item[1]));$free=[math]::Max(0,[math]::Floor($drive.AvailableFreeSpace/1MB))}catch{}
 $result.storage+=@{resource=$item[0];freeMb=$free}
}
# Bounded, fixed WinSW files. Classify only known diagnostic event codes, never return raw lines.
$codes=@('AUDIT_LOG_READ_FAILED','AUDIT_LOG_WRITE_FAILED','EACCES','EPERM','ENOENT','ENOSPC','EADDRINUSE','ERR_MODULE_NOT_FOUND')
foreach($name in @('CommandBridgeMCP.err.log','CommandBridgeMCP.out.log')) {
 $path=[IO.Path]::Combine($env:ProgramData,'CommandBridgeMCP\logs',$name)
 $stream=$null
 try {
  $parent=[IO.Path]::GetDirectoryName($path)
  if(([IO.File]::GetAttributes($parent) -band [IO.FileAttributes]::ReparsePoint) -or ([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint)) {throw 'Unsafe log source'}
  $stream=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
  $null=$stream.Seek([math]::Max(0,$stream.Length-65536),[IO.SeekOrigin]::Begin)
  $buffer=New-Object byte[] 65536
  $count=$stream.Read($buffer,0,$buffer.Length)
  $text=[Text.Encoding]::UTF8.GetString($buffer,0,$count)
  foreach($line in ($text -split '\r?\n')) {
   try {$entry=$line|ConvertFrom-Json -ErrorAction Stop;if($entry.event -eq 'command_bridge.diagnostic' -and $entry.code -in $codes -and $result.errors.Count -lt 20){$result.errors+=@{code=$entry.code}}}catch{}
  }
 } catch [IO.FileNotFoundException] {} catch [IO.DirectoryNotFoundException] {} catch {$result.reader=@{status='unavailable';reason='readerFailed'}} finally {if($stream){$stream.Dispose()}}
}
$result|ConvertTo-Json -Depth 5 -Compress
