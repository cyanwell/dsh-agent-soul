# acceptance.ps1 - isolated acceptance for the AgentSoul versioned distribution + installer.
# Uses ONLY temp directories: install root, Start Menu root, shell home (logs/WebView2 profile).
# Never touches %LOCALAPPDATA%\Programs\AgentSoul, the real Start Menu, or production data.
param(
  [string]$Setup = "D:\AI\agent-soul\dist\AgentSoul-Setup-1.0.0.exe",
  [string]$Port = "7391",
  [string]$Base = ""
)
$ErrorActionPreference = "Stop"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
if ([string]::IsNullOrEmpty($Base)) { $Base = Join-Path $env:TEMP ("agentsoul-accept-" + $stamp) }
if (Test-Path $Base) { Remove-Item $Base -Recurse -Force }
New-Item -ItemType Directory -Path $Base -Force | Out-Null

$install = Join-Path $Base "install"
$sm      = Join-Path $Base "startmenu"
$shellHome = Join-Path $Base "shellhome"
$ucEvt = "AgentSoulAccUC-" + $stamp
$exEvt = "AgentSoulAccEX-" + $stamp

function Ok($m)  { Write-Output ("  [PASS] " + $m) }
function Bad($m) { Write-Output ("  [FAIL] " + $m); $script:fails++ }
function Head($m){ Write-Output ""; Write-Output ("== " + $m + " ==") }
$script:fails = 0

Write-Output ("base = " + $Base)

# ---------------------------------------------------------------- 1. install
Head "1. setup /D=<temp> /StartMenuRoot=<temp> /S"
$out = & $Setup ("/D=" + $install) ("/StartMenuRoot=" + $sm) "/S" 2>&1 | Out-String
Write-Output $out.Trim()
if ($LASTEXITCODE -ne 0) { Bad ("setup exit " + $LASTEXITCODE) } else { Ok "setup exit 0" }

# ---------------------------------------------------------------- 2. files
Head "2. installed file layout"
$must = @(
  "AgentSoul.exe",
  "Microsoft.Web.WebView2.Core.dll",
  "Microsoft.Web.WebView2.WinForms.dll",
  "WebView2Loader.dll",
  "app\current.txt",
  "app\1.0.0\src\index.mjs",
  "app\1.0.0\src\web\dashboard.html",
  "app\1.0.0\tools\soul-sync.mjs",
  "runtime\node.exe",
  "runtime\LICENSE-node.txt",
  "config.json",
  "THIRD-PARTY-NOTICES.txt"
)
foreach ($m in $must) {
  if (Test-Path (Join-Path $install $m)) { Ok $m } else { Bad ("missing " + $m) }
}
$cur = (Get-Content (Join-Path $install "app\current.txt") -Raw).Trim()
if ($cur -eq "1.0.0") { Ok ("current.txt = " + $cur) } else { Bad ("current.txt = " + $cur) }
$cfg = Get-Content (Join-Path $install "config.json") -Raw | ConvertFrom-Json
if ($cfg.chat.enabled -eq $false) { Ok "config.chat.enabled = false" } else { Bad "config.chat.enabled != false" }
if ($null -eq $cfg.soul.root) { Ok "config.soul.root = null (no dev 书房)" } else { Bad ("config.soul.root = " + $cfg.soul.root) }
if ($cfg.dataDir -eq "data") { Ok "config.dataDir = data (install root)" } else { Bad ("dataDir = " + $cfg.dataDir) }
if ([string]::IsNullOrEmpty($cfg.llm.apiKey)) { Ok "config.llm.apiKey = empty" } else { Bad "config.llm.apiKey not empty" }

# forbidden content must not exist
Head "3. forbidden content in install tree"
$badDirs = @("data", "_backup", "_verify", "_shots", "build", "dist", "node_modules")
foreach ($d in $badDirs) {
  if (Test-Path (Join-Path $install $d)) { Bad ("unexpected dir " + $d) } else { Ok ("no " + $d) }
}

# ---------------------------------------------------------------- 3. shortcut
Head "4. Start Menu shortcut"
$lnk = Join-Path $sm "AgentSoul\AgentSoul.lnk"
if (Test-Path $lnk) { Ok ("lnk exists (" + (Get-Item $lnk).Length + " bytes)") } else { Bad "lnk missing" }
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut($lnk)
$t = $s.TargetPath; $w = $s.WorkingDirectory; $i = $s.IconLocation
[void][Runtime.InteropServices.Marshal]::ReleaseComObject($s)
[void][Runtime.InteropServices.Marshal]::ReleaseComObject($ws)
if ($t -eq (Join-Path $install "AgentSoul.exe")) { Ok ("target = " + $t) } else { Bad ("target = " + $t) }
if ($w -eq $install) { Ok ("workingDirectory = " + $w) } else { Bad ("workdir = " + $w) }
if ($i -like ((Join-Path $install "AgentSoul.exe") + ",0")) { Ok ("icon = " + $i) } else { Bad ("icon = " + $i) }
if (Test-Path ([Environment]::GetFolderPath("Programs") + "\AgentSoul")) { Bad "REAL start menu was written!" } else { Ok "real Start Menu untouched" }

# ---------------------------------------------------------------- 4. first run
Head "5. first run (real core, sync off, chat off, port $Port)"
$env:AGENT_SOUL_HUB_PORT = $Port
$env:AGENT_SOUL_SHELL_HOME = $shellHome
$env:AGENT_SOUL_SYNC = "off"
$env:AGENT_SOUL_CHAT = "off"
$env:AGENT_SOUL_TEST_USERCLOSE_EVENT = $ucEvt
$env:AGENT_SOUL_TEST_EXIT_EVENT = $exEvt

$exe = Join-Path $install "AgentSoul.exe"
$proc = Start-Process -FilePath $exe -PassThru
Write-Output ("  shell pid = " + $proc.Id)

$health = $null
$t0 = Get-Date
while (((Get-Date) - $t0).TotalSeconds -lt 90) {
  try {
    $health = Invoke-RestMethod -Uri ("http://127.0.0.1:" + $Port + "/api/health") -TimeoutSec 2
    if ($health.ok) { break }
  } catch { }
  Start-Sleep -Milliseconds 500
}
$secs = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
if ($health -and $health.ok) {
  Ok ("GET /api/health 200 in " + $secs + "s")
  Write-Output ("         service=" + $health.service + " pid=" + $health.pid + " port=" + $health.port + " llmReady=" + $health.llmReady + " sessions=" + $health.sessions)
  if ($health.service -eq "agent-soul-core") { Ok "service = agent-soul-core (真 core)" } else { Bad ("service = " + $health.service) }
  if ($health.port -eq [int]$Port) { Ok ("core port = " + $health.port) } else { Bad ("port = " + $health.port) }
} else { Bad "health never went 200" }

# chat must not listen on 8901
$chatOpen = $false
try { $chatOpen = (Test-NetConnection -ComputerName 127.0.0.1 -Port 8901 -InformationLevel Quiet -WarningAction SilentlyContinue) } catch { $chatOpen = $false }
if ($chatOpen) { Bad "8901 is listening (chat must be off)" } else { Ok "8901 not listening (chat off)" }

# ---------------------------------------------------------------- 5. HTML-only update
Head "6. HTML-only update (no rebuild, no repack)"
$marker = "ACCEPTANCE-HTML-PATCH-" + $stamp
$dash = Join-Path $install "app\1.0.0\src\web\dashboard.html"
$orig = Get-Content $dash -Raw
Set-Content -Path $dash -Value ($orig + "<!-- " + $marker + " -->") -Encoding UTF8
try {
  $page = (Invoke-WebRequest -Uri ("http://127.0.0.1:" + $Port + "/") -UseBasicParsing -TimeoutSec 5).Content
  if ($page -like ("*" + $marker + "*")) { Ok "served page picked up the edited HTML with no restart" } else { Bad "edited HTML not served" }
} catch { Bad ("GET / failed: " + $_.Exception.Message) }
Set-Content -Path $dash -Value $orig -Encoding UTF8
$htmlFiles = Get-ChildItem (Join-Path $install "app\1.0.0\src\web") -Filter *.html
$htmlBytes = ($htmlFiles | Measure-Object Length -Sum).Sum
Write-Output ("         src\web\*.html = " + $htmlFiles.Count + " files / " + $htmlBytes + " bytes")

# ---------------------------------------------------------------- 6. close / exit
Head "7. window close (X) then exit - no leftovers"
$uc = [System.Threading.EventWaitHandle]::OpenExisting($ucEvt)
[void]$uc.Set()
Start-Sleep -Seconds 3
$p2 = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
if ($p2 -and -not $p2.HasExited) { Ok "after X: shell still alive (parked in tray)" } else { Bad "shell died on window close" }
if ($p2) {
  if ($p2.MainWindowHandle -eq 0) { Ok "after X: main window hidden (MainWindowHandle=0)" } else { Bad ("after X: window still visible hwnd=" + $p2.MainWindowHandle) }
}
try { $h2 = Invoke-RestMethod -Uri ("http://127.0.0.1:" + $Port + "/api/health") -TimeoutSec 2; if ($h2.ok) { Ok "after X: core still serving" } else { Bad "core not serving after X" } } catch { Bad "health after X failed" }
[void]$uc.Dispose()

$ex = [System.Threading.EventWaitHandle]::OpenExisting($exEvt)
[void]$ex.Set()
$t1 = Get-Date
$gone = $false
while (((Get-Date) - $t1).TotalSeconds -lt 90) {
  $p3 = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
  if (-not $p3) { $gone = $true; break }
  Start-Sleep -Milliseconds 500
}
$exitSecs = [math]::Round(((Get-Date) - $t1).TotalSeconds, 1)
if ($gone) { Ok ("exit: shell process gone in " + $exitSecs + "s") } else { Bad "shell still running after exit" }
[void]$ex.Dispose()

Start-Sleep -Seconds 2
$leftNode = Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like ($install + "*") }
if ($leftNode) { Bad ("leftover core node: " + ($leftNode.Id -join ",")) } else { Ok "no leftover bundled node.exe" }
$leftShell = Get-Process -Name AgentSoul -ErrorAction SilentlyContinue | Where-Object { $_.Path -like ($install + "*") }
if ($leftShell) { Bad ("leftover shell: " + ($leftShell.Id -join ",")) } else { Ok "no leftover AgentSoul.exe" }
$portOpen = $false
try { $portOpen = (Test-NetConnection -ComputerName 127.0.0.1 -Port $Port -InformationLevel Quiet -WarningAction SilentlyContinue) } catch { }
if ($portOpen) { Bad ("port " + $Port + " still listening") } else { Ok ("port " + $Port + " released") }
$wvLeft = 0
try { $wvLeft = (Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like ("*" + $shellHome.Replace('\','\\') + "*") }).Count } catch { }
Write-Output ("         msedgewebview2 bound to our profile: " + $wvLeft)

# ---------------------------------------------------------------- 7. data + logs
Head "8. generated state + logs"
$dataDir = Join-Path $install "data"
if (Test-Path $dataDir) { Ok ("data dir created at install root: " + (Get-ChildItem $dataDir -Recurse -File | Measure-Object).Count + " files") } else { Bad "data dir not created" }
$shutdownLog = Join-Path $dataDir "shutdown.log"
if (Test-Path $shutdownLog) { Ok "shutdown.log present"; Get-Content $shutdownLog -Tail 3 | ForEach-Object { Write-Output ("         " + $_) } } else { Write-Output "         (no shutdown.log)" }
$shellLog = Join-Path $shellHome "shell.log"
if (Test-Path $shellLog) {
  Ok "shell.log present"
  Write-Output "         --- tail ---"
  Get-Content $shellLog -Tail 22 | ForEach-Object { Write-Output ("         " + $_) }
} else { Bad "shell.log missing" }

# ---------------------------------------------------------------- 8. html-only patch package
Head "9. html-only update package (<=1MB) applied to the live install"
$patch = "D:\AI\agent-soul\dist\AgentSoul-1.0.0-htmlpatch.zip"
if (Test-Path $patch) {
  $pb = (Get-Item $patch).Length
  if ($pb -lt 1048576) { Ok ("htmlpatch.zip = " + $pb + " bytes (< 1 MB)") } else { Bad ("htmlpatch.zip = " + $pb + " bytes (>= 1 MB)") }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zipObj = [System.IO.Compression.ZipFile]::OpenRead($patch)
  $entries = $zipObj.Entries.Count
  $zipObj.Dispose()
  Ok ("htmlpatch entries = " + $entries)
  $tmpx = Join-Path $Base "patchx"
  [System.IO.Compression.ZipFile]::ExtractToDirectory($patch, $tmpx)
  $srcWeb = Join-Path $tmpx "app\1.0.0\src\web"
  Copy-Item (Join-Path $srcWeb "*") (Join-Path $install "app\1.0.0\src\web") -Force -Recurse
  Ok "patch overlaid onto app\1.0.0\src\web"
} else { Bad "htmlpatch.zip missing" }

# ---------------------------------------------------------------- 9. secrets scan
Head "10. credential scan (must be 0)"
$patterns = @(
  'sk-[A-Za-z0-9]{16,}',
  'ghp_[A-Za-z0-9]{20,}',
  'AKIA[0-9A-Z]{16}',
  'BEGIN [A-Z ]*PRIVATE KEY',
  '"apiKey" : "[^"]{6,}"',
  'Authorization: Bearer [A-Za-z0-9\-_\.]{20,}'
)
$hits = 0
$scanRoots = @($install, "D:\AI\agent-soul\dist\AgentSoul")
foreach ($root in $scanRoots) {
  foreach ($f in (Get-ChildItem $root -Recurse -File -Include *.mjs,*.json,*.html,*.css,*.js,*.md,*.txt)) {
    $txt = Get-Content $f.FullName -Raw -ErrorAction SilentlyContinue
    if (-not $txt) { continue }
    foreach ($pat in $patterns) {
      $m = [regex]::Matches($txt, $pat)
      foreach ($x in $m) {
        if ($x.Value -eq '"apiKey" : ""') { continue }
        $hits++
        Write-Output ("         HIT " + $f.FullName + " :: " + $x.Value.Substring(0, [Math]::Min(40, $x.Value.Length)))
      }
    }
  }
}
if ($hits -eq 0) { Ok "0 credential-like strings in install tree and dist tree" } else { Bad ($hits.ToString() + " credential-like strings found") }

$setupBytes = [System.IO.File]::ReadAllBytes($Setup)
$setupTxt = [System.Text.Encoding]::GetEncoding(28591).GetString($setupBytes)
if ($setupTxt.Contains("D:/AI/agent-soul/data")) { Bad "setup exe contains the dev dataDir" } else { Ok "setup exe does not contain the dev dataDir" }
$devHits = (Select-String -Path (Join-Path $install "app\1.0.0\src\*.mjs"),(Join-Path $install "app\1.0.0\src\**\*.mjs"),(Join-Path $install "app\1.0.0\src\web\*.html"),(Join-Path $install "app\1.0.0\tools\*.mjs") -Pattern "D:/AI/" -ErrorAction SilentlyContinue | Measure-Object).Count
Write-Output ("         info: dev-machine path literals in payload = " + $devHits + " (pre-existing defaults, not secrets)")

# ---------------------------------------------------------------- 10. portable zip
Head "11. portable zip is self-contained"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zpath = "D:\AI\agent-soul\dist\AgentSoul-1.0.0-portable.zip"
$ex = Join-Path $Base "portable"
[System.IO.Compression.ZipFile]::ExtractToDirectory($zpath, $ex)
foreach ($m in @("AgentSoul.exe","app\current.txt","app\1.0.0\src\index.mjs","runtime\node.exe","config.json","WebView2Loader.dll")) {
  if (Test-Path (Join-Path $ex $m)) { Ok ("portable has " + $m) } else { Bad ("portable misses " + $m) }
}
$z = [System.IO.Compression.ZipFile]::OpenRead($zpath)
$zc = $z.Entries.Count
$z.Dispose()
Ok ("portable zip entries = " + $zc + ", bytes = " + (Get-Item $zpath).Length)

Write-Output ""
Write-Output ("FAILS = " + $script:fails)
Write-Output ("BASE = " + $Base)
if ($script:fails -gt 0) { exit 1 }
