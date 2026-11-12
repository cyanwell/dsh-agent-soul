# guard-release-config.ps1 -- R4: packing chain may only reference config.release.json
#
# Why this exists (independent acceptance section 7.4): the only defence so far was one comment
# and good intentions. And the implementer really did read the production config.json once
# (disclosed in the implementation report section 9). A rule that can be bypassed by
# "I will be careful next time" is not a constraint.
#
# Two layers:
#   1) static (this script): any reference to the REPO-ROOT config.json inside build\ -> fail.
#   2) runtime (dist.ps1 Assert-ReleaseConfig): at the moment of copying, the leaf name must be
#      config.release.json, otherwise throw.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File build\pack\guard-release-config.ps1
#   powershell ... -File build\pack\guard-release-config.ps1 -ScanDir <dir>   # fault injection
# Exit: 0 = clean, 1 = violation (packing must stop).
#
# NOTE: output lines are ASCII on purpose (this box runs Windows PowerShell 5.1 with a GBK code
# page; Chinese in stdout would be mojibake for whoever reads the log). Chinese lives in comments,
# which are read as UTF-8 because this file carries a BOM.
param(
  [string[]]$ScanDir = @(),
  [switch]$Json
)
$ErrorActionPreference = 'Stop'
$repo = 'D:\AI\agent-soul'
if (-not $ScanDir -or $ScanDir.Count -eq 0) { $ScanDir = @((Join-Path $repo 'build'), (Join-Path $repo 'tools')) }

# Forbidden: pointing at the production (dev) config.json.
# Allowed: config.release.json, and the installed copy under a target dir (Installer.cs uses
# Path.Combine(target, "config.json") -- that is the destination, not the source).
$rules = @(
  @{ id = 'repo-config-literal'; re = 'D:[\\/]AI[\\/]agent-soul[\\/]config\.json'; why = 'hard-coded repo-root config.json (production config)' },
  @{ id = 'join-repo-config';    re = 'Join-Path\s+\$(repo|root|repoRoot)\s+["'']?config\.json'; why = 'Join-Path on the repo root production config' },
  @{ id = 'var-repo-config';     re = '\$repo\s*\+?\s*["'']?[\\/]?config\.json'; why = 'repo variable concatenated with the production config name' }
)

# Positive requirement: a packing entry point must name its release fixture explicitly.
$entryScripts = @('dist.ps1', 'make-packages.ps1', 'package.mjs')

$files = @()
foreach ($d in $ScanDir) {
  if (-not (Test-Path $d)) { continue }
  $files += Get-ChildItem $d -Recurse -File | Where-Object {
    $_.Extension -in '.ps1', '.cs', '.mjs', '.js' -and $_.Name -notmatch '\.bak'
  }
}

$violations = New-Object System.Collections.ArrayList
$checked = 0
foreach ($f in $files) {
  $checked++
  $rel = $f.FullName.Replace($repo + '\', '')
  $lines = [System.IO.File]::ReadAllLines($f.FullName)
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $line = $lines[$i]
    foreach ($r in $rules) {
      if ($line -match $r.re) {
        [void]$violations.Add([pscustomobject]@{ file = $rel; line = $i + 1; rule = $r.id; why = $r.why; text = $line.Trim() })
      }
    }
  }
  if ($entryScripts -contains $f.Name) {
    $text = [System.IO.File]::ReadAllText($f.FullName)
    if ($text -notmatch 'config\.release\.json') {
      [void]$violations.Add([pscustomobject]@{ file = $rel; line = 0; rule = 'missing-release-fixture'; why = 'packing entry does not reference config.release.json'; text = '' })
    }
  }
}

if ($Json) {
  Write-Output (ConvertTo-Json @{ ok = ($violations.Count -eq 0); scanned = $checked; violations = $violations } -Depth 5)
} else {
  Write-Output ('[R4] scanned-files=' + $checked)
  if ($violations.Count -eq 0) {
    Write-Output '[R4] PASS  no reference to repo-root config.json; every packing entry names config.release.json'
  } else {
    Write-Output ('[R4] FAIL  violations=' + $violations.Count)
    foreach ($v in $violations) {
      Write-Output ('  ' + $v.file + ':' + $v.line + '  [' + $v.rule + ']  ' + $v.why)
      if ($v.text) { Write-Output ('      ' + $v.text) }
    }
  }
}
if ($violations.Count -gt 0) { exit 1 }
exit 0
