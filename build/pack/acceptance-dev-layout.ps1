# acceptance-dev-layout.ps1 - regression: the dev layout (walk up to src\index.mjs) still resolves.
# Uses a FAKE core and a temp tree; production core (7310) is never started, production config is never read.
param([string]$Port = "7395")
$ErrorActionPreference = "Stop"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$Base = Join-Path $env:TEMP ("agentsoul-dev-" + $stamp)
if (Test-Path $Base) { Remove-Item $Base -Recurse -Force }
$devroot = Join-Path $Base "devroot"
New-Item -ItemType Directory -Force -Path (Join-Path $devroot "src") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $devroot "build") | Out-Null
Copy-Item "D:\AI\agent-soul\build\pack\fixtures\fake-core.mjs" (Join-Path $devroot "src\index.mjs") -Force
Copy-Item "D:\AI\agent-soul\build\AgentSoul.exe" (Join-Path $devroot "build\AgentSoul.exe") -Force
New-Item -ItemType Directory -Force -Path (Join-Path $devroot "runtime") | Out-Null
Copy-Item "C:\Users\pc\.workbuddy\binaries\node\versions\22.22.2-3\node.exe" (Join-Path $devroot "runtime\node.exe") -Force
foreach ($d in @("Microsoft.Web.WebView2.Core.dll","Microsoft.Web.WebView2.WinForms.dll","WebView2Loader.dll")) {
  Copy-Item (Join-Path "D:\AI\agent-soul\build" $d) (Join-Path (Join-Path $devroot "build") $d) -Force
}
Write-Output ("base = " + $Base)

$env:AGENT_SOUL_HUB_PORT = $Port
$env:AGENT_SOUL_SHELL_HOME = (Join-Path $Base "shellhome")
$ev = "AgentSoulDevEx-" + $stamp
$env:AGENT_SOUL_TEST_EXIT_EVENT = $ev

$exe = Join-Path $devroot "build\AgentSoul.exe"
$p = Start-Process -FilePath $exe -PassThru
$h = $null
$t0 = Get-Date
while (((Get-Date) - $t0).TotalSeconds -lt 60) {
  try { $h = Invoke-RestMethod -Uri ("http://127.0.0.1:" + $Port + "/api/health") -TimeoutSec 2; if ($h.ok) { break } } catch { }
  Start-Sleep -Milliseconds 400
}
$fails = 0
if ($h -and $h.fake) { Write-Output "  [PASS] dev layout: fake core reached via walk-up" } else { Write-Output "  [FAIL] dev layout health"; $fails++ }
$log = Join-Path $Base "shellhome\shell.log"
if (Test-Path $log) {
  $coreLine = (Select-String -Path $log -Pattern "run: core=" | Select-Object -Last 1).Line
  $layLine  = (Select-String -Path $log -Pattern "run: layout|run: 布局" | Select-Object -Last 1).Line
  Write-Output ("         " + $coreLine)
  Write-Output ("         " + $layLine)
  if ($coreLine -like "*devroot\src\index.mjs*") { Write-Output "  [PASS] resolved src\index.mjs by walking up" } else { Write-Output "  [FAIL] core path"; $fails++ }
  if ($coreLine -like "*app\*") { Write-Output "  [FAIL] wrongly used app layout"; $fails++ } else { Write-Output "  [PASS] did not use app\ layout (no app dir present)" }
}
$e = [System.Threading.EventWaitHandle]::OpenExisting($ev); [void]$e.Set(); [void]$e.Dispose()
$p.WaitForExit(60000) | Out-Null
Write-Output ("FAILS = " + $fails)
Write-Output ("BASE = " + $Base)
if ($fails -gt 0) { exit 1 }
