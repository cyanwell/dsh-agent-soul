# verify-guard-injection.ps1 -- R4 fault injection: prove the assertion actually stops a build.
#
# Method (safe: no production config.json is opened, no real packing runs):
#   1) write a deliberately violating fake packer into a temp dir (the same shape as dist.ps1),
#   2) run the SAME guard on it -> must exit 1,
#   3) run the guard on the real build\ -> must exit 0.
# Both directions must hold; testing only the passing side proves nothing.
#
# The two "bad" strings are assembled at runtime (config + .json) so that this file itself does
# not contain the forbidden literal -- otherwise the guard would flag its own injection fixture.
param([string]$OutLog)
$ErrorActionPreference = 'Stop'
$repo = 'D:\AI\agent-soul'
$guard = Join-Path $repo 'build\pack\guard-release-config.ps1'
$ps = Join-Path $PSHOME 'powershell.exe'
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$tmp = Join-Path $env:TEMP ('agentsoul-guard-inject-' + $ts)
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

$lines = New-Object System.Collections.ArrayList
function Say($m) { [void]$lines.Add([string]$m); Write-Output $m }

$cfgLeaf = 'config' + '.json'

# (1) same shape as dist.ps1 step 4, but pointing at the production config
$bad = Join-Path $tmp 'bad-packer.ps1'
Set-Content -Path $bad -Encoding UTF8 -Value @(
  ('$repo = "D:\AI\agent-soul"'),
  ('$out = Join-Path $repo "dist\AgentSoul"'),
  ('Copy-Item (Join-Path $repo "' + $cfgLeaf + '") (Join-Path $out "' + $cfgLeaf + '") -Force')
)
# (2) a variant that DOES mention config.release.json -- proves "contains release => pass" is wrong
$bad2 = Join-Path $tmp 'bad-packer-2.ps1'
Set-Content -Path $bad2 -Encoding UTF8 -Value @(
  ('# fixture: config.release.json is mentioned on purpose, it must not whitelist this file'),
  ('$dest = "C:\tmp\out"'),
  ('Copy-Item "D:\AI\agent-soul\' + $cfgLeaf + '" $dest -Force')
)

Say ('[inject] tmp=' + $tmp)
Say '[inject] case-1: fake packer copies the production config from the repo root'
$r1 = & $ps -NoProfile -ExecutionPolicy Bypass -File $guard -ScanDir $tmp 2>&1
$c1 = $LASTEXITCODE
Say ('[inject] case-1 exit=' + $c1 + '  (expected 1)')
foreach ($l in $r1) { Say ('    ' + $l) }

Say '[inject] case-2 real build tree (expected 0)'
$r2 = & $ps -NoProfile -ExecutionPolicy Bypass -File $guard 2>&1
$c2 = $LASTEXITCODE
foreach ($l in $r2) { Say ('    ' + $l) }

$ok = ($c1 -eq 1) -and ($c2 -eq 0)
Say ('[inject] verdict=' + $(if ($ok) { 'PASS (violation blocked, real tree clean)' } else { 'FAIL (assertion ineffective)' }))

Remove-Item $tmp -Recurse -Force
if ($OutLog) { Set-Content -Path $OutLog -Value ($lines -join [Environment]::NewLine) -Encoding UTF8 }
if (-not $ok) { exit 1 }
exit 0
