# Shared protected-path checks for fixed installation assets.
$privileged = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
function Test-ProtectedPath([string]$Path, [string]$ManagedRoot) {
  if (-not [IO.File]::Exists($Path) -and -not [IO.Directory]::Exists($Path)) { return $null }
  try {
    $cursor = $Path
    while ($cursor) {
      if (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
      $directory = [IO.Directory]::Exists($cursor)
      $acl = if ($directory) { [IO.Directory]::GetAccessControl($cursor) } else { [IO.File]::GetAccessControl($cursor) }
      if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $privileged) { return $false }
      foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
        # Outside the managed tree, creating an unrelated child is harmless;
        # replacing this tree or changing its ACL/owner must remain forbidden.
        $mask = if ($cursor.Equals($ManagedRoot, [StringComparison]::OrdinalIgnoreCase) -or $cursor.StartsWith($ManagedRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { 0xD0156 } else { 0xD0040 }
        if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
            ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]$mask) -ne 0 -and
            $rule.IdentityReference.Value -notin $privileged) { return $false }
      }
      $parent = [IO.Path]::GetDirectoryName($cursor)
      if (-not $parent -or $parent -eq $cursor) { break }
      $cursor = $parent
    }
    return $true
  } catch { return $false }
}
