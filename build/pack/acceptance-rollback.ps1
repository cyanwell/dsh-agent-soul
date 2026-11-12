# acceptance-rollback.ps1 - version switching + rollback, still inside a temp root.
param(
  [string]$Setup = "D:\AI\agent-soul\dist\AgentSoul-Setup-1.0.0.exe",
  [string]$Base = ""
)
$ErrorActionPreference = "Stop"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
if ([string]::IsNullOrEmpty($Base)) { $Base = Join-Path $env:TEMP ("agentsoul-rb-" + $stamp) }
if (Test-Path $Base) { Remove-Item $Base -Recurse -Force }
New-Item -ItemType Directory -Path $Base -Force | Out-Null
$install = Join-Path $Base "install"
$shellHome = Join-Path $Base "shellhome"
$fails = 0
function Ok($m)  { Write-Output ("  [PASS] " + $m) }
function Bad($m) { Write-Output ("  [FAIL] " + $m); $script:fails++ }
function Head($m){ Write-Output ""; Write-Output ("== " + $m + " ==") }

Write-Output ("base = " + $Base)
& $Setup ("/D=" + $install) "/NoShortcut" "/S" | Out-Null
if (-not (Test-Path (Join-Path $install "app\1.0.0\src\index.mjs"))) { Bad "1.0.0 install failed"; exit 1 }
Ok "1.0.0 installed"

# ---- make a 1.0.1 that differs ONLY in html (this is the point: business payload is swappable)
Head "build app\1.0.1 from 1.0.0 (html differs only)"
Copy-Item (Join-Path $install "app\1.0.0") (Join-Path $install "app\1.0.1") -Recurse -Force
$d101 = Join-Path $install "app\1.0.1\src\web\dashboard.html"
Add-Content -Path $d101 -Value "<!-- BUILD-101 -->" -Encoding UTF8
Set-Content -Path (Join-Path $install "app\current.txt") -Value "1.0.1" -Encoding ASCII
Ok "current.txt = 1.0.1"

function Try-Health($port, $seconds) {
  $t0 = Get-Date
  while (((Get-Date) - $t0).TotalSeconds -lt $seconds) {
    try { $h = Invoke-RestMethod -Uri ("http://127.0.0.1:" + $port + "/api/health") -TimeoutSec 2; if ($h.ok) { return $h } } catch { }
    Start-Sleep -Milliseconds 400
  }
  return $null
}

$env:AGENT_SOUL_SHELL_HOME = $shellHome
$env:AGENT_SOUL_SYNC = "off"
$env:AGENT_SOUL_CHAT = "off"
$exe = Join-Path $install "AgentSoul.exe"

# ---- run 1.0.1
Head "run with current.txt = 1.0.1 (port 7392)"
$ev1 = "AgentSoulRbEx1-" + $stamp
$env:AGENT_SOUL_HUB_PORT = "7392"
$env:AGENT_SOUL_TEST_EXIT_EVENT = $ev1
$p = Start-Process -FilePath $exe -PassThru
$h = Try-Health 7392 90
if ($h -and $h.ok) { Ok ("health 200 (pid " + $h.pid + ")") } else { Bad "health failed" }
$page = ""
try { $page = (Invoke-WebRequest -Uri "http://127.0.0.1:7392/" -UseBasicParsing -TimeoutSec 5).Content } catch { }
if ($page -like "*BUILD-101*") { Ok "served page is 1.0.1 (BUILD-101 marker present)" } else { Bad "served page is not 1.0.1" }
$log = Join-Path $shellHome "shell.log"
if (Test-Path $log) {
  $ln = Select-String -Path $log -Pattern "run: core=" | Select-Object -Last 1
  if ($ln -and $ln.Line -like "*app\1.0.1*") { Ok "shell.log: core = app\1.0.1\src\index.mjs" } else { Bad ("shell.log core line: " + $ln.Line) }
}
$e = [System.Threading.EventWaitHandle]::OpenExisting($ev1); [void]$e.Set(); [void]$e.Dispose()
$p.WaitForExit(90000) | Out-Null
Ok "exited"

# ---- rollback
Head "rollback to 1.0.0 (installer /Rollback)"
& $Setup ("/D=" + $install) "/Rollback=1.0.0" "/S" | Out-Null
$cur = (Get-Content (Join-Path $install "app\current.txt") -Raw).Trim()
if ($cur -eq "1.0.0") { Ok "current.txt = 1.0.0" } else { Bad ("current.txt = " + $cur) }
if (Test-Path (Join-Path $install "app\1.0.1\src\index.mjs")) { Ok "1.0.1 still on disk (kept for re-rollback)" } else { Bad "1.0.1 was deleted" }

# ---- run 1.0.0 again
Head "run with current.txt = 1.0.0 (port 7393)"
$ev2 = "AgentSoulRbEx2-" + $stamp
$env:AGENT_SOUL_HUB_PORT = "7393"
$env:AGENT_SOUL_TEST_EXIT_EVENT = $ev2
$p2 = Start-Process -FilePath $exe -PassThru
$h2 = Try-Health 7393 90
if ($h2 -and $h2.ok) { Ok ("health 200 (pid " + $h2.pid + ")") } else { Bad "health failed" }
$page2 = ""
try { $page2 = (Invoke-WebRequest -Uri "http://127.0.0.1:7393/" -UseBasicParsing -TimeoutSec 5).Content } catch { }
if ($page2 -notlike "*BUILD-101*") { Ok "served page is back to 1.0.0 (marker gone)" } else { Bad "still serving 1.0.1" }
$ln2 = Select-String -Path $log -Pattern "run: core=" | Select-Object -Last 1
if ($ln2 -and $ln2.Line -like "*app\1.0.0*") { Ok "shell.log: core = app\1.0.0\src\index.mjs" } else { Bad ("shell.log core line: " + $ln2.Line) }
$e2 = [System.Threading.EventWaitHandle]::OpenExisting($ev2); [void]$e2.Set(); [void]$e2.Dispose()
$p2.WaitForExit(90000) | Out-Null
Ok "exited"

# ---- data survived the version switch
Head "shared state stayed outside app\<version>"
$shared = Join-Path $install "data"
if (Test-Path $shared) { Ok ("data at install root: " + (Get-ChildItem $shared -Recurse -File | Measure-Object).Count + " files") } else { Bad "no shared data dir" }
$leak = Get-ChildItem (Join-Path $install "app") -Recurse -Filter "*.log" -ErrorAction SilentlyContinue
if ($leak) { Bad ("logs landed inside app\<version>: " + ($leak.FullName -join ", ")) } else { Ok "no runtime state inside app\<version>" }

Write-Output ""
Write-Output ("FAILS = " + $fails)
Write-Output ("BASE = " + $Base)
if ($fails -gt 0) { exit 1 }
