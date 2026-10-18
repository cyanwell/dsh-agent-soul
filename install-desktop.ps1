# install-desktop.ps1 - desktop one-command installer for dsh-agent-soul
#
# Why this file exists:
#   The desktop profile refuses `dsh plugin add` (DSH says:
#   profile "desktop" is managed exclusively by the Electron application).
#   So installing means: copy files -> add name to bundles -> restart.
#   All three can be automated. This script is that.
#
# Usage (one command):
#   irm https://raw.githubusercontent.com/cyanwell/dsh-agent-soul/main/install-desktop.ps1 | iex
#
# Or local:
#   powershell -ExecutionPolicy Bypass -File .\install-desktop.ps1
#
# Discipline:
#   1. Back up package.json before touching it.
#   2. Edit JSON with node, never ConvertTo-Json (it drops fields, and
#      Set-Content -Encoding UTF8 writes a BOM on PS 5.1 -> DSH crashes at startup).
#   3. Idempotent - safe to run twice.

param(
  [string]$Profile,
  [string]$Ref = 'main'
)

$ErrorActionPreference = 'Stop'

function Ok($m)   { Write-Host "  ok   $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  warn $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "  FAIL $m" -ForegroundColor Red; exit 1 }

Write-Host ''
Write-Host '  dsh-agent-soul - desktop install' -ForegroundColor Cyan
Write-Host '  ---------------------------------'

# 1. locate profile
if (-not $Profile) {
  $cands = @()
  if ($env:DSH_HOME) { $cands += (Join-Path $env:DSH_HOME 'profiles\desktop') }
  $cands += (Join-Path $env:USERPROFILE '.dsh\profiles\desktop')
  $cands += 'D:\AI\dsh\home\profiles\desktop'
  $cands += (Join-Path $env:APPDATA 'dsh\profiles\desktop')
  foreach ($c in $cands) {
    if (Test-Path (Join-Path $c 'package.json')) { $Profile = $c; break }
  }
}
if (-not $Profile -or -not (Test-Path (Join-Path $Profile 'package.json'))) {
  Die 'profile not found. Pass -Profile <path> (that dir must contain package.json).'
}
Ok "profile: $Profile"

# 2. locate node (shipped with DSH)
$node = $null
$dd = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'
if (Test-Path $dd) {
  $f = Get-ChildItem $dd -Recurse -Filter 'node.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($f) { $node = $f.FullName }
}
if (-not $node) {
  $c = Get-Command node -ErrorAction SilentlyContinue
  if ($c) { $node = $c.Source }
}
if (-not $node) { Die 'node.exe not found. DSH ships one - search under the DSH install dir.' }
Ok "node: $node"

# 3. download
$tag = [guid]::NewGuid().ToString('N').Substring(0,8)
$zip = Join-Path $env:TEMP "dsh-agent-soul-$tag.zip"
$tmp = Join-Path $env:TEMP "dsh-agent-soul-src-$tag"
$url = "https://github.com/cyanwell/dsh-agent-soul/archive/refs/heads/$Ref.zip"
Write-Host "  get  $url"
try { Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing }
catch { Die "download failed: $($_.Exception.Message)" }
Expand-Archive -Path $zip -DestinationPath $tmp -Force
$src = Get-ChildItem $tmp -Directory | Select-Object -First 1
if (-not $src) { Die 'extract produced no directory' }
$srcRoot = $src.FullName
Ok 'downloaded'

# 4. copy into node_modules
$dest = Join-Path $Profile 'node_modules\dsh-agent-soul'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$files = @('package.json','cordis.patch.yml','index.js','install.js','kit-bridge.mjs','README.md','INSTALL.md')
foreach ($f in $files) {
  $s = Join-Path $srcRoot $f
  if (Test-Path $s) { Copy-Item $s (Join-Path $dest $f) -Force }
}
foreach ($d in @('kit','soul','skeleton','tools')) {
  $s = Join-Path $srcRoot $d
  if (Test-Path $s) {
    $t = Join-Path $dest $d
    if (Test-Path $t) { Remove-Item $t -Recurse -Force }
    Copy-Item $s $t -Recurse -Force
  }
}
Ok 'files copied to node_modules\dsh-agent-soul'

# 5. backup + edit bundles
$pkgPath = Join-Path $Profile 'package.json'
$bak = "$pkgPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item $pkgPath $bak -Force
Ok "backed up: $(Split-Path $bak -Leaf)"

$addJs = Join-Path $dest 'tools\add-bundle.js'
if (-not (Test-Path $addJs)) { Die "add-bundle.js missing at $addJs" }
$out = & $node $addJs $pkgPath 'dsh-agent-soul' 2>&1
if ($LASTEXITCODE -ne 0) {
  Copy-Item $bak $pkgPath -Force
  Die "bundles edit failed, restored from backup: $out"
}
if ("$out" -match 'already') { Warn 'dsh-agent-soul already in bundles (skipped)' }
else { Ok 'added to dsh.profile.bundles' }

# 6. cleanup
Remove-Item $zip -Force -ErrorAction SilentlyContinue
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host '  ---------------------------------' -ForegroundColor Cyan
Write-Host '  installed.' -ForegroundColor Green
Write-Host ''
Write-Host '  RESTART DSH - not a page refresh.' -ForegroundColor Yellow
Write-Host ''
Write-Host '  After restart, in a conversation:'
Write-Host '    agent_soul_plan' -ForegroundColor Cyan
Write-Host ''
Write-Host '  Parts live under <pkg>/plugins/ (14 of them).'
Write-Host '  Health check:'
Write-Host '    agent_soul_verify' -ForegroundColor Cyan
Write-Host ''