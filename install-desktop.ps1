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
# ★★ 2026-10-23 实机报告 C4：原来的探测**只认** `%LOCALAPPDATA%\Programs\DeepSeek Harness`
#    和 PATH。用户把 DSH 装在别的盘（如 E:\dsh）、PATH 里又没有 node，
#    于是脚本在第二步直接 Die —— 而 node 其实就在 DSH 安装目录里，完全可以自己找到。
#    ★ 判据：**「DSH 自带 node」这件事不依赖安装位置**，所以不能写死一个目录去猜。
#    现在按「越确定越先试」的顺序：
#      ① DSH_NODE 环境变量（用户显式指定，永远优先）
#      ② 从 profile 往上推 DSH 安装根，再试两种已知布局（Electron 运行时自带的 node）
#      ③ 常见安装位置（含原来那个 LOCALAPPDATA\Programs）
#      ④ PATH
#    ★ 全都找不到时，报错必须给**可执行的下一步**（怎么设 DSH_NODE / 怎么找 node.exe），
#      不能只喊一句 not found —— 那正是报告里「照着提示也走不下去」的那一半。
$node = $null
$tried = @()

# ① 显式指定
if ($env:DSH_NODE) {
  $tried += "DSH_NODE=$($env:DSH_NODE)"
  if (Test-Path $env:DSH_NODE) { $node = (Resolve-Path $env:DSH_NODE).Path }
}

# ② 从 profile 往上找 DSH 安装根（profile 通常在 <DSH_ROOT>\home\profiles\desktop）
if (-not $node) {
  $roots = @()
  $cur = $Profile
  for ($i = 0; $i -lt 4 -and $cur; $i++) { $roots += $cur; $cur = Split-Path $cur -Parent }
  foreach ($r in $roots) {
    foreach ($c in @(
      (Join-Path $r 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe'),
      (Join-Path $r 'resources\runtime\bin\node.exe')
    )) {
      $tried += $c
      if (Test-Path $c) { $node = $c; break }
    }
    if ($node) { break }
  }
}

# ③ 常见安装位置（保留旧行为，但不再只认这一处）
if (-not $node) {
  $known = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'),
    (Join-Path $env:LOCALAPPDATA 'DeepSeek Harness'),
    (Join-Path $env:ProgramFiles 'DeepSeek Harness'),
    (Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'DeepSeek Harness')
  )
  foreach ($dd in $known) {
    if (-not $dd -or -not (Test-Path $dd)) { continue }
    $tried += $dd
    $f = Get-ChildItem $dd -Recurse -Filter 'node.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($f) { $node = $f.FullName; break }
  }
}

# ④ PATH
if (-not $node) {
  $c = Get-Command node -ErrorAction SilentlyContinue
  if ($c) { $node = $c.Source } else { $tried += 'PATH 里的 node' }
}

if (-not $node) {
  Write-Host '  FAIL node.exe not found. Tried:' -ForegroundColor Red
  foreach ($t in $tried) { Write-Host "         - $t" }
  Write-Host ''
  Write-Host '  Next step (pick one):' -ForegroundColor Yellow
  Write-Host '    1) point DSH_NODE at the node.exe that ships with DSH, then rerun:'
  Write-Host '         $env:DSH_NODE = ''<DSH install>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'''
  Write-Host '    2) or install Node.js and check that `node -v` works in a NEW shell'
  Write-Host '    3) if DSH lives somewhere unusual, locate its node.exe:'
  Write-Host '         Get-ChildItem ''<DSH install>'' -Recurse -Filter node.exe'
  exit 1
}
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
# ★ Stage the copy first, verify it, and only then swap it into place.
#   Why: an earlier version created $dest up-front and copied into it, so a failed
#   self-check left a half-populated dsh-agent-soul directory sitting in the user's
#   node_modules. package.json was untouched (that part was fine), but a broken
#   half-package is confusing to diagnose on the next run.
#   Staging under the profile's own node_modules keeps the final swap a same-volume rename
#   (staging in %TEMP% would turn Move-Item into copy+delete across volumes).
$stage = Join-Path $Profile "node_modules\.dsh-agent-soul-stage-$tag"
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stage | Out-Null

$files = @('package.json','cordis.patch.yml','index.js','client.js','install.js','kit-bridge.mjs','probe-kit-tools.mjs','install-desktop.ps1','README.md','INSTALL.md')
foreach ($f in $files) {
  $s1 = Join-Path $srcRoot $f
  if (Test-Path $s1) { Copy-Item $s1 (Join-Path $stage $f) -Force }
}
foreach ($d in @('kit','soul','skeleton','tools','plugins')) {
  $s1 = Join-Path $srcRoot $d
  if (Test-Path $s1) {
    $t1 = Join-Path $stage $d
    if (Test-Path $t1) { Remove-Item $t1 -Recurse -Force }
    Copy-Item $s1 $t1 -Recurse -Force
  }
}

# 4b. hard self-check on the STAGED copy - a package missing client.js makes DSH
#     fail to boot, which triggers sanitizeProfile and RESETS the user's bundles +
#     patch layer. Better to fail here, loudly, before the user restarts.
$mustHave = @('client.js','index.js','cordis.patch.yml','package.json','plugins','tools/add-bundle.cjs')
$missing = @()
foreach ($m in $mustHave) {
  if (-not (Test-Path (Join-Path $stage $m))) { $missing += $m }
}
if ($missing.Count -gt 0) {
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
  Die ("copy incomplete, missing: " + ($missing -join ', ') + " - staged copy discarded, your profile was not touched at all.")
}

# 4c. swap into place ---- rename-aside first, so a failed move can be undone.
#     Never delete the live directory before the new one is actually in place:
#     if Move-Item then failed, the user would be left with no package at all while
#     dsh.profile.bundles still names it -> DSH startup failure -> sanitizeProfile.
$backup = $null
if (Test-Path $dest) {
  $backup = Join-Path $Profile "node_modules\.dsh-agent-soul-old-$tag"
  Remove-Item $backup -Recurse -Force -ErrorAction SilentlyContinue
  Rename-Item -Path $dest -NewName (Split-Path $backup -Leaf) -ErrorAction SilentlyContinue
  if (Test-Path $dest) {
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
    Die ("cannot move the current package aside - DSH is probably still running. Quit DSH completely and run this again. Your existing package is untouched.")
  }
}
$swapped = $false
try {
  Move-Item $stage $dest -ErrorAction Stop
  $swapped = $true
} catch {
  $swapErr = $_.Exception.Message
}
if (-not $swapped) {
  $rollbackOk = $false
  if ($backup -and (Test-Path $backup)) {
    Rename-Item -Path $backup -NewName (Split-Path $dest -Leaf) -ErrorAction SilentlyContinue
    $rollbackOk = Test-Path $dest
  } else {
    $rollbackOk = $true
  }
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
  if ($rollbackOk) {
    Die ("swap failed: " + $swapErr + " - previous install restored, your profile is unchanged.")
  }
  Die ("swap failed: " + $swapErr + " - AND rollback failed. DO NOT restart DSH yet. Your previous copy is at: " + $backup + " - move it back to " + $dest + " first.")
}
if ($backup) { Remove-Item $backup -Recurse -Force -ErrorAction SilentlyContinue }
Ok 'files copied to node_modules/dsh-agent-soul (client.js verified, staged then swapped)'

# 5. backup + edit bundles
$pkgPath = Join-Path $Profile 'package.json'
$bak = "$pkgPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item $pkgPath $bak -Force
Ok "backed up: $(Split-Path $bak -Leaf)"

$addJs = Join-Path $dest 'tools\add-bundle.cjs'
if (-not (Test-Path $addJs)) { Die "add-bundle.cjs missing at $addJs" }
# ★ 第三个参数是 dependencies 的值（报告 v3 的 N1）。
#   不传的话只写 bundles —— 而装配计划的下一步是 dsh plugin add 装零件，
#   pnpm 会把「没写进 dependencies 的 node_modules 子目录」当 extraneous 清掉，
#   于是**装完就被剪掉**，再启动报 cannot resolve profile bundle。
#   file: 指向它在 node_modules 里的实际位置（相对 profile）。
$out = & $node $addJs $pkgPath 'dsh-agent-soul' 'file:node_modules/dsh-agent-soul' 2>&1
if ($LASTEXITCODE -ne 0) {
  Copy-Item $bak $pkgPath -Force
  Die "bundles edit failed, restored from backup: $out"
}
if ("$out" -match 'already') { Warn 'dsh-agent-soul already in bundles + dependencies (skipped)' }
elseif ("$out" -match 'added-deps') { Ok 'dependencies backfilled (bundles already had it)' }
else { Ok 'added to dsh.profile.bundles + dependencies' }

# 6. cleanup
Remove-Item $zip -Force -ErrorAction SilentlyContinue
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host '  ---------------------------------' -ForegroundColor Cyan
Write-Host '  installed.' -ForegroundColor Green
Write-Host ''
Write-Host '  ★ 注意：本体的源就在 node_modules 里（file:node_modules/dsh-agent-soul）。' -ForegroundColor DarkGray
Write-Host '    `rm -rf node_modules` 会把它一起删掉，之后 pnpm install 恢复不了。' -ForegroundColor DarkGray
Write-Host '    真要重来，重跑一遍本脚本即可（它会重新拷一遍）。' -ForegroundColor DarkGray
Write-Host ''
Write-Host '  RESTART DSH - not a page refresh.' -ForegroundColor Yellow
Write-Host ''
Write-Host '  After restart, in a conversation:'
Write-Host '    agent_soul_plan' -ForegroundColor Cyan
Write-Host ''
Write-Host '  Parts live under <pkg>/plugins/ (13 packages + tools/ scripts; 14th part is dsh-mnemon, an external npm package).'
Write-Host '  Health check:'
Write-Host '    agent_soul_verify' -ForegroundColor Cyan
Write-Host ''

# ── 装完立刻自检 ───────────────────────────────────────────────────────────
# 为什么挂在这儿：有用户的原话是「插件安装好了，但根本不知道有没有在运行」。
# 这一步把那句话变成一条看得见的结果，而不是让他自己去想该跑什么。
#
# ★ 这里只跑**静态**检查（verify-client-ids）——
#   它查「注册 id 撞车」；撞了的话 DSH 启动直接失败，装完不查等于把雷留到重启。
# ★ soul-one-shot 查的是**运行状态**，重启之前跑没有意义，所以只提示命令。
$toolsDir  = Join-Path $PSScriptRoot 'tools'
$idsScript = Join-Path $toolsDir 'verify-client-ids.mjs'
$oneShot   = Join-Path $toolsDir 'soul-one-shot.mjs'

Write-Host ''
Write-Host '  ---------------------------------' -ForegroundColor Cyan
Write-Host '  pre-flight check (before you restart)' -ForegroundColor Cyan

if (Test-Path $idsScript) {
  $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
  if ($nodeExe) {
    Write-Host ''
    & $nodeExe $idsScript
    Write-Host ''
    if ($LASTEXITCODE -ne 0) {
      Write-Host '  ★ 上面报了重复 id —— 先别重启，把这个解决掉。' -ForegroundColor Red
      Write-Host '    撞车不会给你好懂的报错，它表现为「DSH 起不来」或「某个面板整排消失」。' -ForegroundColor DarkGray
    }
  } else {
    Write-Host '  (node not on PATH - run this yourself before restarting:)' -ForegroundColor DarkGray
    Write-Host "    node `"$idsScript`"" -ForegroundColor DarkGray
  }
} else {
  Write-Host '  (tools/verify-client-ids.mjs not found - skipped)' -ForegroundColor DarkGray
}

if (Test-Path $oneShot) {
  Write-Host ''
  Write-Host '  After restart, one command answers "is it actually running":' -ForegroundColor DarkGray
  Write-Host "    node `"$oneShot`"" -ForegroundColor Cyan
}
Write-Host ''
