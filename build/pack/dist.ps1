# dist.ps1 - build a versioned, distributable AgentSoul tree.
#
# Layout (M1):
#   <Out>\AgentSoul.exe                         shell (launcher chain)
#   <Out>\Microsoft.Web.WebView2.Core.dll       ) shell deps, must sit next to the exe
#   <Out>\Microsoft.Web.WebView2.WinForms.dll   )
#   <Out>\WebView2Loader.dll                    )
#   <Out>\app\current.txt                       which version to run (rollback = edit this line)
#   <Out>\app\<Version>\src\...                 business payload (JS/HTML/CSS)
#   <Out>\app\<Version>\tools\soul-sync.mjs     required by src/index.mjs (../tools/soul-sync.mjs)
#   <Out>\runtime\node.exe                      bundled node (pinned), plus its LICENSE
#   <Out>\config.json                           safe defaults; shared by all versions (AGENT_SOUL_HOME=install root)
#   <Out>\workspace\README.txt                  user files live here (shared)
#
# Explicitly NOT copied: dev config.json, data\, _verify\, _backup\, build\, apiKey.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File D:\AI\agent-soul\build\pack\dist.ps1 [-Version 1.0.0] [-KeepExisting] [-AllowOverwrite]
#
# 2026-11-10 (R4): this script runs guard-release-config.ps1 first, and carries a RUNTIME
#   assertion Assert-ReleaseConfig -- the release config may only be config.release.json;
#   anything else throws. Reason: a single comment plus "I will be careful" is not a constraint.
# 2026-11-10 (R2): -KeepExisting keeps the version dirs already in dist -- 1.0.0 is published,
#   1.0.1 may only be added. An existing version dir is refused unless -AllowOverwrite.
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads a BOM-less UTF-8 file with the
#   GBK code page, and CJK bytes can decode into smart quotes that break parsing.
param([string]$Version = "1.0.0", [switch]$KeepExisting, [switch]$AllowOverwrite)

$ErrorActionPreference = "Stop"
$NL = [Environment]::NewLine
$repo = "D:\AI\agent-soul"
$build = Join-Path $repo "build"
$out = Join-Path $repo "dist\AgentSoul"
$nodeDir = "C:\Users\pc\.workbuddy\binaries\node\versions\22.22.2-3"
$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"

function Say($m) { Write-Output $m }

# ---- 0. R4 hard assertion ----------------------------------------------------
# static: guard scans build\ for repo-root config.json references; exit 1 -> throw.
# runtime: Assert-ReleaseConfig checks the leaf name of the file actually copied.
function Assert-ReleaseConfig([string]$p) {
  if (-not $p) { throw "R4: release config path is empty" }
  if (-not (Test-Path $p)) { throw ("R4: release fixture missing: " + $p) }
  $leaf = [System.IO.Path]::GetFileName($p)
  if ($leaf -ne "config.release.json") {
    throw ("R4: the only allowed release config is config.release.json, got: " + $leaf)
  }
}

$guard = Join-Path $PSScriptRoot "guard-release-config.ps1"
if (Test-Path $guard) {
  $psExe = Join-Path $PSHOME "powershell.exe"
  & $psExe -NoProfile -ExecutionPolicy Bypass -File $guard
  if ($LASTEXITCODE -ne 0) { throw "R4: packing chain references the production config.json -- refusing to build" }
} else {
  throw ("R4: guard script missing: " + $guard)
}

if (Test-Path $out) {
  if ($KeepExisting) { Say "keep-existing = $out (published versions are kept)" }
  else { Remove-Item $out -Recurse -Force }
}
New-Item -ItemType Directory -Path $out -Force | Out-Null

# ---- 1. shell + dlls ---------------------------------------------------------
foreach ($f in @("AgentSoul.exe", "Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.WinForms.dll", "WebView2Loader.dll")) {
  $src = Join-Path $build $f
  if (-not (Test-Path $src)) { throw "missing: $src" }
  Copy-Item $src (Join-Path $out $f) -Force
}

# ---- 2. versioned payload ----------------------------------------------------
$appRoot = Join-Path $out "app"
$verDir = Join-Path $appRoot $Version
if (Test-Path $verDir) {
  if (-not $AllowOverwrite) {
    throw ("version dir already exists: " + $verDir + " -- refusing to overwrite a published version; delete it manually or pass -AllowOverwrite")
  }
  Remove-Item $verDir -Recurse -Force
  Say ("overwrite-existing-version = " + $Version)
}
New-Item -ItemType Directory -Path $verDir -Force | Out-Null

Copy-Item (Join-Path $repo "src") (Join-Path $verDir "src") -Recurse -Force
New-Item -ItemType Directory -Path (Join-Path $verDir "tools") -Force | Out-Null
Copy-Item (Join-Path $repo "tools\soul-sync.mjs") (Join-Path $verDir "tools\soul-sync.mjs") -Force
foreach ($f in @("package.json", "README.md")) {
  $p = Join-Path $repo $f
  if (Test-Path $p) { Copy-Item $p (Join-Path $verDir $f) -Force }
}

$shellSha = (Get-FileHash (Join-Path $build "AgentSoul.exe") -Algorithm SHA256).Hash
$stamp = @(
  "AgentSoul payload " + $Version,
  "built: " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss"),
  "shell: AgentSoul.exe sha256 " + $shellSha,
  "",
  "This directory is the business payload only. The shell that starts it lives two levels up.",
  "Rollback: edit ..\current.txt back to an older version directory name."
) -join $NL
Set-Content -Path (Join-Path $verDir "VERSION.txt") -Value $stamp -Encoding UTF8

Set-Content -Path (Join-Path $appRoot "current.txt") -Value $Version -Encoding ASCII

# ---- 3. bundled node ---------------------------------------------------------
$runtime = Join-Path $out "runtime"
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
Copy-Item (Join-Path $nodeDir "node.exe") (Join-Path $runtime "node.exe") -Force
Copy-Item (Join-Path $nodeDir "LICENSE") (Join-Path $runtime "LICENSE-node.txt") -Force

# ---- 4. root config (safe defaults, shared by all versions) -----------------
$releaseCfg = Join-Path $repo "config.release.json"
Assert-ReleaseConfig $releaseCfg
Copy-Item $releaseCfg (Join-Path $out "config.json") -Force

# ---- 5. workspace ------------------------------------------------------------
$ws = Join-Path $out "workspace"
New-Item -ItemType Directory -Path $ws -Force | Out-Null
Set-Content -Path (Join-Path $ws "README.txt") -Value (@("AgentSoul workspace.", "Files the app works on go here (shared by every app version).") -join $NL) -Encoding UTF8

# ---- 6. notices --------------------------------------------------------------
# ---- 3b. secret helper (DPAPI CurrentUser) -----------------------------------
# ★ 1.0.2: the secret store ships INSIDE runtime so the runtime can resolve
#   llm.apiKeyRef = dpapi:<providerId> without ever depending on my dev machine.
#   It is compiled here, from buildpackSecretStore.cs, every build -- a stale
#   helper exe lying around in build is exactly the kind of thing that makes
#   "installed fine, cannot decrypt later" bugs.
$ssSrc = Join-Path $build "pack\SecretStore.cs"
$ssExe = Join-Path $runtime "SecretStore.exe"
if (-not (Test-Path $ssSrc)) { throw ("missing: " + $ssSrc) }
& $csc /nologo /target:exe /platform:anycpu /langversion:5 /utf8output ("/out:" + $ssExe) $ssSrc /r:System.dll /r:System.Core.dll
if ($LASTEXITCODE -ne 0) { throw ("SecretStore compile failed exit=" + $LASTEXITCODE) }
Say ("secretstore = $ssExe")
Say ("secretstore-sha256 = " + (Get-FileHash $ssExe -Algorithm SHA256).Hash)

$nodeVer = (& (Join-Path $nodeDir "node.exe") -v)
$notices = @(
  "AgentSoul " + $Version + " - third party notices",
  "",
  "1) Node.js " + $nodeVer + "  (bundled: runtime\node.exe)",
  "   License: full text ships as runtime\LICENSE-node.txt (Node.js MIT-style license; it bundles",
  "   the licenses of its own dependencies).",
  "",
  "2) Microsoft Edge WebView2 SDK  (bundled DLLs: Microsoft.Web.WebView2.Core.dll,",
  "   Microsoft.Web.WebView2.WinForms.dll, WebView2Loader.dll - NuGet package 1.0.4314.35)",
  "   Redistributable under the terms that come with that NuGet package.",
  "",
  "3) Microsoft Edge WebView2 Runtime - NOT bundled.",
  "   The runtime ships with Edge and is installed machine-wide. This package only detects it;",
  "   when it is missing the shell says so and tells you how to install it.",
  "",
  "No other third-party components are bundled."
) -join $NL
Set-Content -Path (Join-Path $out "THIRD-PARTY-NOTICES.txt") -Value $notices -Encoding UTF8

# ---- 7. summary --------------------------------------------------------------
$files = Get-ChildItem $out -Recurse -File
$sum = ($files | Measure-Object Length -Sum)
$nodeBytes = (Get-Item (Join-Path $runtime "node.exe")).Length
$payFiles = $files | Where-Object { $_.FullName.StartsWith($verDir) }
$paySum = ($payFiles | Measure-Object Length -Sum).Sum
Say "dist-root   = $out"
Say "version     = $Version"
Say "versions    = $((Get-ChildItem $appRoot -Directory | Select-Object -ExpandProperty Name | Sort-Object) -join ', ')"
Say "current     = $((Get-Content (Join-Path $appRoot 'current.txt')).Trim())"
Say "files       = $($files.Count)"
Say "total-bytes = $($sum.Sum)"
Say "node-bytes  = $nodeBytes"
Say "payload     = $paySum bytes in $($payFiles.Count) files"
Say "exe-sha256  = $shellSha"
Say "node-sha256 = $((Get-FileHash (Join-Path $runtime 'node.exe') -Algorithm SHA256).Hash)"