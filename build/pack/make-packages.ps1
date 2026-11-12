# make-packages.ps1 -- build the three 1.0.1 artifacts (portable zip / html-only patch / setup exe).
#
# Why a script instead of hand commands: the 1.0.0 artifacts were produced by hand, so
# "how were they built" is not reproducible. Every number in the report must come from a
# command somebody else can re-run.
#
# R2: the html-only patch contains **only** HTML / CSS / browser JS from app\<ver>\src\web.
#     No .mjs at all -- the server payload (server.mjs / status-data.mjs / diary.mjs) lives in
#     app\<ver> and travels with the version directory, never with the page patch.
# R4: this script runs guard-release-config.ps1 first and refuses to build when it fails.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File build\pack\make-packages.ps1 -Version 1.0.1
param(
  [string]$Version = '1.0.1'
)
$ErrorActionPreference = 'Stop'
$NL = [Environment]::NewLine
$repo = 'D:\AI\agent-soul'
$dist = Join-Path $repo 'dist'
$out = Join-Path $dist 'AgentSoul'
$logs = Join-Path $repo 'build\pack\logs'
$psExe = Join-Path $PSHOME 'powershell.exe'
New-Item -ItemType Directory -Path $logs -Force | Out-Null

function Say($m) { Write-Output $m }

# ---- 0. R4: release fixture assertion --------------------------------------
$guard = Join-Path $repo 'build\pack\guard-release-config.ps1'
& $psExe -NoProfile -ExecutionPolicy Bypass -File $guard
if ($LASTEXITCODE -ne 0) { throw 'R4: guard failed -- packing must stop' }

# ---- 1. preconditions -------------------------------------------------------
$verDir = Join-Path $out ('app\' + $Version)
if (-not (Test-Path $verDir)) { throw ('version dir missing, run dist.ps1 first: ' + $verDir) }
$current = (Get-Content (Join-Path $out 'app\current.txt')).Trim()
if ($current -ne $Version) { throw ('current.txt is ' + $current + ', expected ' + $Version + ' -- roll forward first') }
if (-not (Test-Path (Join-Path $out 'config.json'))) { throw 'dist config.json missing' }

# config.json must be byte-identical to the release fixture (never the dev one)
$relSha = (Get-FileHash (Join-Path $repo 'config.release.json') -Algorithm SHA256).Hash
$dstSha = (Get-FileHash (Join-Path $out 'config.json') -Algorithm SHA256).Hash
if ($relSha -ne $dstSha) { throw ('R4: dist config.json is not the release fixture (rel=' + $relSha + ' dst=' + $dstSha + ')') }
Say ('config-fixture  sha256=' + $dstSha + '  (== config.release.json)')

# ---- 1b. distribution notes (must be written BEFORE zipping) (kept in sync with what the patch really is) -----
$notes = @(
  ('AgentSoul ' + $Version + ' - distribution notes'),
  ('=============================================='),
  '',
  'Layout',
  '------',
  'AgentSoul.exe                        shell (single instance / core / health / tray / graceful shutdown)',
  'Microsoft.Web.WebView2.*.dll         managed deps (must sit next to the exe)',
  'WebView2Loader.dll                   native dep (must sit next to the exe)',
  'app\current.txt                       active version (rollback = edit this one line)',
  'app\<version>\src\...               business payload (server .mjs + pages) - versioned',
  'app\<version>\tools\soul-sync.mjs    imported by src\index.mjs',
  'runtime\node.exe                     bundled Node.js (plus runtime\LICENSE-node.txt)',
  'runtime\SecretStore.exe              DPAPI (CurrentUser) secret store - resolves llm.apiKeyRef',
  'config.json                          shared by every version, lives in the install root',
  'workspace\                           user files + the default status dir, shared',
  'THIRD-PARTY-NOTICES.txt              third-party components',
  '',
  'Versions (this build)',
  '---------------------',
  '1.0.0  first public payload (kept as is)',
  '1.0.1  dev-machine path literals removed; status dir resolves to the install root',
  '1.0.2  WinForms setup wizard; DPAPI secret store; OpenAI + Anthropic protocols',
  '1.0.3  apiKeyRef is never echoed unless it matches the allow-list; helper override is dev-only',
  '1.0.4  the POST /api/config receipt is redacted too (changed / restartRequired / before / after)',
  '1.0.5  three dead readings fixed: huanqi (credits + stalled), waker ledger (authoritative, read-only), autonomy (three time points)',
  '',
  'What 1.0.5 changes',
  '------------------',
  'Three readings that used to be dead now show either the real value or an explicit no-reading.',
  '1) Huanqi: the dashboard showed 0 / 3 forever. Two bugs stacked - the web layer read',
  '   loop.__huanqiByRound, which index.mjs never assigned, and it read d.streak, a field the',
  '   detector does not have (the real one is d.stalled). One shared read model',
  '   (organs/huanqi-read.mjs) now reports the in-process stalled / stallThreshold and the DSH',
  '   credit / creditMax separately, plus the last verdict; a missing source shows "-" and why.',
  '2) Waker ledger: soul_waker and the organs card read data\ledger.json (1 stale item) instead',
  '   of the authoritative ledger in the status dir (43 events). All readers now use',
  '   organs/waker-read.mjs over the status-dir lead-waker ledger: read-only, full-file scan,',
  '   source path + mtime + the four views (act / done / audit / auto). Nothing writes to it.',
  '3) Autonomy: any in-process vs on-disk mismatch used to be called a conflict. Now three',
  '   time points are reported separately (runtime verdict / config snapshot / on-disk config);',
  '   a later config mtime means a stale snapshot, and only an opposite value at the same',
  '   instant is a conflict. The decision algorithm itself was not touched.',
  'No write path, decision algorithm or authoritative data file was changed.',
  '',
  'What 1.0.4 changes',
  '------------------',
  '1.0.3 stopped GET /api/config and /api/health from echoing an untrusted llm.apiKeyRef, but the',
  'WRITE receipt still did: POST /api/config answered with changed[].before and',
  'restartRequired[].before carrying the OLD raw value, and the settings page printed it as',
  '"secret ref: <old raw value> -> dpapi:...". Fixing a mistyped ref was itself the leak.',
  '1.0.4 routes every display of a sensitive field through one predicate (fd.type=secret or',
  'fd.key=llm.apiKeyRef) and one safe formatter: a secret is only configured / not configured,',
  'a ref is only an allow-listed reference (or unknown / invalid). The same rule covers field',
  'metadata (display / defaultDisplay) and the pages, which additionally refuse to render',
  'anything that does not look like one of those words. No behaviour change for a legal ref.',
  '',
  'What 1.0.3 changes',
  '------------------',
  'Security hardening only. GET /api/config and /api/health no longer echo an untrusted',
  'llm.apiKeyRef: a value matching env:[A-Za-z_][A-Za-z0-9_]* or dpapi:[a-z][a-z0-9_-]*',
  'is shown as is, anything else is reported as "invalid" or "unknown" (no slice, no length).',
  'The same allow-list now guards the resolver error text and the startup banner, so a raw',
  'key pasted into apiKeyRef cannot reach a response, a log, or a screenshot.',
  'AGENT_SOUL_SECRETSTORE only overrides the helper path when AGENT_SOUL_DEV=1; distribution',
  'builds always use <install root>\runtime\SecretStore.exe. The wizard now restricts',
  'Provider ID to the same alphabet so it cannot write a ref the runtime rejects.',
  '',
  'What 1.0.2 adds to the setup exe',
  '--------------------------------',
  'Three-page wizard: install location / API configuration / install + finish.',
  'The API page asks for provider id, display name, protocol (OpenAI Chat Completions or',
  'Anthropic Messages), API address (may be left EMPTY - the per-protocol default is used),',
  'the API key (required, masked) and the model. The key is required: it is what the v4',
  'internal LLM monitoring / decision / scheduling units run on.',
  'Agent Soul is NOT DeepSeek Harness and not another general harness.',
  '',
  'Secrets',
  '-------',
  'The key is encrypted with Windows DPAPI (CurrentUser) by runtime\SecretStore.exe, fed',
  'through stdin, and stored at data\secrets\<providerId>.dpapi. config.json only carries',
  'llm.apiKeyRef = dpapi:<providerId>. No secret is ever written to a command line, a log,',
  'install-info.txt, config.json, or this package.',
  'Upgrades keep the secret (data\ is a user directory). Only /Uninstall /Purge deletes it.',
  'Two different update channels - do not mix them',
  '-----------------------------------------------',
  '1) AgentSoul-<ver>-htmlpatch.zip  -- PAGES ONLY.',
  '   Contains only app\<ver>\src\web\*.html / *.css / *.js (browser-side).',
  '   It never contains server code: server.mjs / status-data.mjs / diary.mjs live in',
  '   app\<ver>\src\web\ but are .mjs, so they are NOT part of a page patch.',
  '2) AgentSoul-<ver>-portable.zip  -- FULL tree, including server payload and bundled node.',
  '',
  'Rollback',
  '--------',
  'Edit app\current.txt back to the older version name (the installer does not delete old',
  'directories). Equivalent: AgentSoul-Setup.exe /Rollback=<version> /D=<install dir>.',
  '',
  'Where data and config live',
  '--------------------------',
  'Install root, never inside a version dir: config.json / data\ / workspace\.',
  'The shell passes AGENT_SOUL_HOME=<install root> to the core, so upgrades and rollbacks',
  'never move settings or data.',
  '',
  'Default safe posture',
  '--------------------',
  'chat.enabled=false (8901 closed), llm.apiKey empty, no sessions / ledger / backups bundled.'
)
Set-Content -Path (Join-Path $out 'DISTRIBUTION.txt') -Value $notes -Encoding UTF8
Say ('distribution-notes refreshed')
# ---- 2. portable zip --------------------------------------------------------
# 2026-11-11: the instance override layer (config.local.json) must NOT ship.
# It carries this machine's paths (workspace=D:/AI); on another machine that is a
# directory that does not exist. Set it aside before packing, put it back after.
$localFile = Join-Path $out 'config.local.json'
$localBak = $null
if (Test-Path $localFile) {
  $localBak = $localFile + '.packing-' + (Get-Date -Format 'HHmmss')
  Move-Item $localFile $localBak -Force
  Say ('instance-override set aside: ' + (Split-Path $localBak -Leaf))
}
$portable = Join-Path $dist ('AgentSoul-' + $Version + '-portable.zip')
if (Test-Path $portable) { Remove-Item $portable -Force }
Say ('packing portable: ' + $portable)
Compress-Archive -Path (Join-Path $out '*') -DestinationPath $portable -CompressionLevel Optimal
# restore the instance override (see above) -- the zip must never contain it
if ($localBak -and (Test-Path $localBak)) { Move-Item $localBak $localFile -Force }

# ---- 3. html-only patch (HTML / CSS / browser JS only) -----------------------
$webDir = Join-Path $verDir 'src\web'
$stage = Join-Path $env:TEMP ('agentsoul-htmlpatch-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$stageApp = Join-Path $stage ('app\' + $Version + '\src\web')
New-Item -ItemType Directory -Path $stageApp -Force | Out-Null
$webFiles = Get-ChildItem $webDir -File | Where-Object { $_.Extension -in '.html', '.css', '.js' }
foreach ($f in $webFiles) { Copy-Item $f.FullName (Join-Path $stageApp $f.Name) -Force }
$banned = Get-ChildItem $stageApp -Recurse -File | Where-Object { $_.Extension -notin '.html', '.css', '.js' }
if ($banned) { throw ('htmlpatch contains non-page files: ' + ($banned.Name -join ',')) }
$patch = Join-Path $dist ('AgentSoul-' + $Version + '-htmlpatch.zip')
if (Test-Path $patch) { Remove-Item $patch -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $patch -CompressionLevel Optimal
Remove-Item $stage -Recurse -Force
Say ('packing htmlpatch: ' + $patch + '  files=' + $webFiles.Count)

# ---- 4. setup exe (payload = the portable zip, byte for byte) ----------------
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$cs = Join-Path $repo 'build\pack\Installer.cs'
$setup = Join-Path $dist ('AgentSoul-Setup-' + $Version + '.exe')
if (-not (Test-Path $csc)) { throw ('csc missing: ' + $csc) }
#  1.0.2: /target:winexe -- the setup is a GUI wizard now. A console-subsystem exe
#   would flash a black window before the wizard appears. Silent mode still prints to
#   an attached console (AttachConsole in Installer.cs) and always writes
#   <install root>\install-log.txt, so automation does not depend on stdio.
$args = @(
  '/nologo', '/target:winexe', '/platform:anycpu', '/langversion:5', '/utf8output',
  ('/out:' + $setup),
  ('/resource:' + $portable + ',payload.zip'),
  '/r:System.dll', '/r:System.Core.dll',
  '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll', '/r:System.Web.Extensions.dll',
  '/r:System.IO.Compression.dll', '/r:System.IO.Compression.FileSystem.dll',
  $cs
)
& $csc $args
if ($LASTEXITCODE -ne 0) { throw ('csc failed exit=' + $LASTEXITCODE) }

# ---- 5. manifests -----------------------------------------------------------
$files = Get-ChildItem $out -Recurse -File | Sort-Object FullName
$rows = @()
foreach ($f in $files) {
  $rel = $f.FullName.Replace($out + '\', '')
  $rows += ('{0}  {1}  {2}' -f $rel, $f.Length, (Get-FileHash $f.FullName -Algorithm SHA256).Hash)
}
$sum = ($files | Measure-Object Length -Sum).Sum
$manifest = Join-Path $logs ('manifest-' + $Version + '.txt')
Set-Content -Path $manifest -Value (@(
  ('AgentSoul ' + $Version + ' dist tree'),
  ('files ' + $files.Count + ' bytes ' + $sum),
  ('generated ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')),
  ''
) + $rows) -Encoding UTF8
Say ('manifest: ' + $manifest + '  files=' + $files.Count + ' bytes=' + $sum)

# ---- 6. artifact hashes -----------------------------------------------------
$artifacts = @($setup, $portable, $patch, (Join-Path $out 'AgentSoul.exe'), (Join-Path $out 'runtime\node.exe'), (Join-Path $out 'runtime\SecretStore.exe'))
$artRows = @()
foreach ($a in $artifacts) {
  $artRows += ('{0}  {1}  {2}' -f (Split-Path $a -Leaf), (Get-Item $a).Length, (Get-FileHash $a -Algorithm SHA256).Hash)
  Say ('artifact  ' + (Split-Path $a -Leaf) + '  bytes=' + (Get-Item $a).Length + '  sha256=' + (Get-FileHash $a -Algorithm SHA256).Hash)
}
$artFile = Join-Path $logs ('artifacts-' + $Version + '.txt')
Set-Content -Path $artFile -Value $artRows -Encoding UTF8
Say ('artifacts-manifest: ' + $artFile)

