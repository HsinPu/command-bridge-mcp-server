function Enter-CommandBridgeDeploymentLock {
  $mutex = New-Object System.Threading.Mutex($false, 'Global\CommandBridgeMCP.Install')
  try {
    $acquired = $false
    try { $acquired = $mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) { throw 'Another CommandBridge installation or removal is already running.' }
    return $mutex
  } catch { $mutex.Dispose(); throw }
}
