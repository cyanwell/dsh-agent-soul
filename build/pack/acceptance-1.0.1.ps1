# acceptance-1.0.1.ps1 -- R3 rollback evidence + isolated acceptance.
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less UTF-8 file with the GBK code
# page, and a previous version of this file got mangled by an edit round-trip. Tool scripts do
# not need Chinese comments to be evidence.
#
# What it proves (each item lands as a file, never as "I remember running it"):
#   1. fresh install of 1.0.1: health 200, page build marker 1.0.1, both version dirs present
#   2. /api/status and /api/live contain no dev-machine path (D:/AI/yanqing-soul)
#   3. new session cwd lands inside the install root
#   4. rollback to 1.0.0: current.txt=1.0.0, app\1.0.1 still on disk, page marker gone
#   5. roll forward to 1.0.1 again: current.txt=1.0.1, marker back
#   6. graceful exit, no leftover process / port / real Start Menu entry
#
# Evidence root (NEVER deleted): D:\AI\agent-soul\_verify\dist-rollback-<ts>\
# Temp install root (deleted at the end): %TEMP%\agentsoul-r3-<ts>\
param(
  [string]$Version = '1.0.1',
  [string]$Prev = '1.0.0',
  [int]$Port = 7611
)
$ErrorActionPreference = 'Stop'
$NL = [Environment]::NewLine
$repo = 'D:\AI\agent-soul'
$dist = Join-Path $repo 'dist'
$setupExe = Join-Path $dist ('AgentSoul-Setup-' + $Version + '.exe')
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$base = Join-Path $env:TEMP ('agentsoul-r3-' + $ts)
$install = Join-Path $base 'install'
$startmenu = Join-Path $base 'startmenu'
$shellhome = Join-Path $base 'shellhome'
$evidence = Join-Path $repo ('_verify\dist-rollback-' + $ts)

$log = New-Object System.Collections.ArrayList
$fails = New-Object System.Collections.ArrayList
function Say($m) { [void]$log.Add([string]$m); Write-Output $m }
# NOTE: every call site uses the parenthesised form Check ('name') (cond) (detail); PowerShell
# parses that as ONE array argument, so handle both shapes here. (The first version of this
# script silently judged all 40 assertions FAIL for exactly this reason.)
function Check {
  param($Name, $Cond, $Detail)
  # Powershell splits "Check ('a') ($b) ('c')" in ways that are not stable across expression
  # shapes (sometimes one array, sometimes an array plus a second argument). Flatten whatever
  # arrives into positional slots -- asserting must never depend on argument boxing.
  $a = New-Object System.Collections.ArrayList
  foreach ($x in @($Name)) { foreach ($y in @($x)) { [void]$a.Add($y) } }
  if ($null -ne $Cond) { foreach ($y in @($Cond)) { [void]$a.Add($y) } }
  if ($null -ne $Detail) { foreach ($y in @($Detail)) { [void]$a.Add($y) } }
  $n = [string]$a[0]
  $c = if ($a.Count -gt 1) { $a[1] } else { $false }
  $d = if ($a.Count -gt 2) { $a[2] } else { $null }
  $suffix = ''
  if ($null -ne $d -and "$d" -ne '') { $suffix = '  ::  ' + $d }
  if ($c) { Say ('PASS  ' + $n + $suffix) }
  else { Say ('FAIL  ' + $n + $suffix); [void]$fails.Add($n) }
}
function Save($name, $text) { Set-Content -Path (Join-Path $evidence $name) -Value $text -Encoding UTF8 }
function Wait-Health([string]$url, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2
      if ($r.StatusCode -eq 200) { return $r }
    } catch { }
    Start-Sleep -Milliseconds 400
  }
  return $null
}
function Get-Text([string]$url) {
  $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 15
  return [System.Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())
}
function Find-ShellLog([string]$root) {
  $f = Get-ChildItem $root -Recurse -Filter 'shell.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($f) { return $f.FullName }
  return $null
}
function Stop-ShellGracefully {
  try {
    $ev = [System.Threading.EventWaitHandle]::OpenExisting($script:eventName)
    [void]$ev.Set()
    $ev.Dispose()
  } catch { Say ('[r3] exit-event open failed: ' + $_.Exception.Message) }
  $deadline = (Get-Date).AddSeconds(25)
  while ((Get-Date) -lt $deadline) {
    if ($script:shell.HasExited) { break }
    Start-Sleep -Milliseconds 250
  }
  Start-Sleep -Milliseconds 900
  Say ('[r3] shell exited=' + $script:shell.HasExited + ' exitCode=' + $script:shell.ExitCode)
}

New-Item -ItemType Directory -Path $evidence -Force | Out-Null
New-Item -ItemType Directory -Path $install -Force | Out-Null
New-Item -ItemType Directory -Path $startmenu -Force | Out-Null
New-Item -ItemType Directory -Path $shellhome -Force | Out-Null
Say ('[r3] base     = ' + $base)
Say ('[r3] evidence = ' + $evidence)

# ---- 0. baseline -------------------------------------------------------------
$realStartMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\AgentSoul'
$realPrograms = Join-Path $env:LOCALAPPDATA 'Programs\AgentSoul'
$smBefore = Test-Path $realStartMenu
$prBefore = Test-Path $realPrograms
$portBefore = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) -ne $null
Say ('[r3] baseline real-startmenu=' + $smBefore + ' real-programs=' + $prBefore + ' port' + $Port + '-listening=' + $portBefore)
Check ('port ' + $Port + ' free before test') ((-not $portBefore)) ('listening=' + $portBefore)

# ---- 1. install 1.0.1 --------------------------------------------------------
$sw = [Diagnostics.Stopwatch]::StartNew()
Start-Process -FilePath $setupExe -ArgumentList ('/D=' + $install), ('/StartMenuRoot=' + $startmenu), '/S' -Wait -NoNewWindow
$sw.Stop()
Say ('[r3] install ms=' + $sw.ElapsedMilliseconds)
$cur1 = (Get-Content (Join-Path $install 'app\current.txt')).Trim()
Save ('01-current-' + $Version + '.txt') $cur1
Check ('current.txt == ' + $Version + ' after install') (($cur1 -eq $Version)) ($cur1)
Check ('app\' + $Version + ' exists') ((Test-Path (Join-Path $install ('app\' + $Version))))
Check ('app\' + $Prev + ' also present (version coexistence)') ((Test-Path (Join-Path $install ('app\' + $Prev))))
Check ('installed config.json == config.release.json') (((Get-FileHash (Join-Path $install 'config.json')).Hash -eq (Get-FileHash (Join-Path $repo 'config.release.json')).Hash))
Copy-Item (Join-Path $install 'config.json') (Join-Path $evidence '42-config.json') -Force
$files = Get-ChildItem $install -Recurse -File
Say ('[r3] install files=' + $files.Count)
Save '40-install-tree.txt' (($files | ForEach-Object { $_.FullName.Replace($install + '\', '') + '  ' + $_.Length }) -join $NL)

$lnk = Join-Path $startmenu 'AgentSoul\AgentSoul.lnk'
Check ('start menu shortcut created in temp root') ((Test-Path $lnk)) ($lnk)
if (Test-Path $lnk) {
  $ws = New-Object -ComObject WScript.Shell
  $s = $ws.CreateShortcut($lnk)
  Save '41-shortcut.txt' (@(
    ('path             = ' + $lnk),
    ('target           = ' + $s.TargetPath),
    ('workingDirectory = ' + $s.WorkingDirectory),
    ('iconLocation     = ' + $s.IconLocation),
    ('description      = ' + $s.Description)
  ) -join $NL)
  Check ('shortcut target points at the temp install root') (($s.TargetPath -eq (Join-Path $install 'AgentSoul.exe'))) ($s.TargetPath)
  Check ('shortcut workingDirectory is the install root') (($s.WorkingDirectory -eq $install)) ($s.WorkingDirectory)
}

# ---- 2. first run (1.0.1) ----------------------------------------------------
$script:eventName = 'AgentSoulR3Exit' + $ts
$env:AGENT_SOUL_SHELL_HOME = $shellhome
$env:AGENT_SOUL_HUB_PORT = [string]$Port
$env:AGENT_SOUL_SYNC = 'off'
$env:AGENT_SOUL_CHAT = 'off'
$env:AGENT_SOUL_TEST_EXIT_EVENT = $script:eventName

$script:shell = Start-Process -FilePath (Join-Path $install 'AgentSoul.exe') -PassThru
Say ('[r3] shell pid=' + $script:shell.Id)
$health = Wait-Health ('http://127.0.0.1:' + $Port + '/api/health') 60
Check ('first run /api/health == 200') (($null -ne $health))
if ($health) {
  $hb = [System.Text.Encoding]::UTF8.GetString($health.RawContentStream.ToArray())
  Save ('03-health-' + $Version + '.json') $hb
  Say ('[r3] health=' + $hb)
  Check ('health.service == agent-soul-core') (($hb -match '"service"\s*:\s*"agent-soul-core"'))
  Check ('health.llmReady == false (release default)') (($hb -match '"llmReady"\s*:\s*false'))
}

$page = Get-Text ('http://127.0.0.1:' + $Port + '/')
Save ('02-page-' + $Version + '.html') $page
Check ('page carries build marker 1.0.1') (($page -match "agentsoul-build'\s+content='1\.0\.1'")) ('len=' + $page.Length)
Check ('page has no 1.0.0 marker') (($page -notmatch "content='1\.0\.0'"))

$status = Get-Text ('http://127.0.0.1:' + $Port + '/api/status')
Save ('04-status-' + $Version + '.json') $status
Check ('/api/status has no dev soul path') (($status -notmatch 'D:[\\/]AI[\\/]yanqing-soul')) ('len=' + $status.Length)
Check ('/api/status has no dev repo path') (($status -notmatch 'D:[\\/]AI[\\/]agent-soul'))

$live = Get-Text ('http://127.0.0.1:' + $Port + '/api/live')
Save ('05-live-' + $Version + '.json') $live
Check ('/api/live has no dev path') (($live -notmatch 'D:[\\/]AI[\\/]yanqing-soul')) ('len=' + $live.Length)

$sess = Get-Text ('http://127.0.0.1:' + $Port + '/api/sessions')
Save ('06-sessions-' + $Version + '.json') $sess

$newSess = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $Port + '/api/sessions') -Method Post -ContentType 'application/json' -Body '{}' -UseBasicParsing -TimeoutSec 15
$nb = [System.Text.Encoding]::UTF8.GetString($newSess.RawContentStream.ToArray())
Save ('07-new-session-' + $Version + '.json') $nb
$cwdOk = ($nb -match 'install') -and ($nb -notmatch 'D:[\\/]AI')
Check ('new session cwd inside install root') ($cwdOk) ($nb.Substring(0, [Math]::Min(260, $nb.Length)))

Start-Sleep -Milliseconds 600
$slog = Find-ShellLog $shellhome
if ($slog) {
  Copy-Item $slog (Join-Path $evidence ('08-shell-' + $Version + '.log')) -Force
  $sh = Get-Content $slog -Raw
  Check ('shell.log core path == app\' + $Version) (($sh -match ('app\\' + [regex]::Escape($Version) + '\\src\\index.mjs')))
} else {
  Check ('shell.log exists') ($false) ('not found under ' + $shellhome)
}

Stop-ShellGracefully
Check ('shell exited (1.0.1)') ($script:shell.HasExited)

# ---- 3. rollback to 1.0.0 ----------------------------------------------------
Start-Process -FilePath $setupExe -ArgumentList ('/Rollback=' + $Prev), ('/D=' + $install), '/S' -Wait -NoNewWindow
$cur0 = (Get-Content (Join-Path $install 'app\current.txt')).Trim()
Save '10-current-after-rollback.txt' $cur0
Check ('current.txt == ' + $Prev + ' after rollback') (($cur0 -eq $Prev)) ($cur0)
Check ('app\' + $Version + ' still on disk after rollback') ((Test-Path (Join-Path $install ('app\' + $Version))))
$v1Files = Get-ChildItem (Join-Path $install ('app\' + $Version)) -Recurse -File
Save ('14-app-' + $Version + '-still-there.txt') (($v1Files | ForEach-Object { $_.FullName.Replace($install + '\', '') + '  ' + $_.Length + '  ' + (Get-FileHash $_.FullName -Algorithm SHA256).Hash }) -join $NL)
Check ('app\' + $Version + ' has files on disk') (($v1Files.Count -gt 0)) ('files=' + $v1Files.Count)

$script:shell = Start-Process -FilePath (Join-Path $install 'AgentSoul.exe') -PassThru
$h2 = Wait-Health ('http://127.0.0.1:' + $Port + '/api/health') 60
Check ('health 200 after rollback') (($null -ne $h2))
$page0 = Get-Text ('http://127.0.0.1:' + $Port + '/')
Save ('11-page-' + $Prev + '.html') $page0
Check ('page marker gone after rollback') (($page0 -notmatch "content='1\.0\.1'"))
Start-Sleep -Milliseconds 600
$slog2 = Find-ShellLog $shellhome
if ($slog2) {
  Copy-Item $slog2 (Join-Path $evidence ('13-shell-' + $Prev + '.log')) -Force
  $sh2 = Get-Content $slog2 -Raw
  Check ('shell.log core path == app\' + $Prev) (($sh2 -match ('app\\' + [regex]::Escape($Prev) + '\\src\\index.mjs')))
}
Stop-ShellGracefully
Check ('shell exited (1.0.0)') ($script:shell.HasExited)

# ---- 4. roll forward to 1.0.1 ------------------------------------------------
Start-Process -FilePath $setupExe -ArgumentList ('/Rollback=' + $Version), ('/D=' + $install), '/S' -Wait -NoNewWindow
$curF = (Get-Content (Join-Path $install 'app\current.txt')).Trim()
Save '20-current-final.txt' $curF
Check ('final current.txt == ' + $Version) (($curF -eq $Version)) ($curF)

$script:shell = Start-Process -FilePath (Join-Path $install 'AgentSoul.exe') -PassThru
$h3 = Wait-Health ('http://127.0.0.1:' + $Port + '/api/health') 60
Check ('final health 200') (($null -ne $h3))
$pageF = Get-Text ('http://127.0.0.1:' + $Port + '/')
Save '21-page-final.html' $pageF
Check ('final page marker == 1.0.1') (($pageF -match "agentsoul-build'\s+content='1\.0\.1'"))
Start-Sleep -Milliseconds 600
$slog3 = Find-ShellLog $shellhome
if ($slog3) { Copy-Item $slog3 (Join-Path $evidence '22-shell-final.log') -Force }
Stop-ShellGracefully
Check ('shell exited (final)') ($script:shell.HasExited)

# ---- 5. physical snapshot ----------------------------------------------------
$snap = Join-Path $evidence '30-app-snapshot'
New-Item -ItemType Directory -Path $snap -Force | Out-Null
Copy-Item (Join-Path $install 'app') (Join-Path $snap 'app') -Recurse -Force
Copy-Item (Join-Path $install 'config.json') (Join-Path $snap 'config.json') -Force
$snapFiles = Get-ChildItem $snap -Recurse -File
Save '31-snapshot-manifest.txt' (($snapFiles | ForEach-Object { $_.FullName.Replace($snap + '\', '') + '  ' + $_.Length + '  ' + (Get-FileHash $_.FullName -Algorithm SHA256).Hash }) -join $NL)
Say ('[r3] snapshot files=' + $snapFiles.Count)
Check ('snapshot holds both version dirs') (((Test-Path (Join-Path $snap ('app\' + $Version))) -and (Test-Path (Join-Path $snap ('app\' + $Prev)))))

$distManifest = Join-Path $repo ('build\pack\logs\manifest-' + $Version + '.txt')
if (Test-Path $distManifest) { Copy-Item $distManifest (Join-Path $evidence ('32-manifest-' + $Version + '.txt')) -Force }
$artifacts = Join-Path $repo ('build\pack\logs\artifacts-' + $Version + '.txt')
if (Test-Path $artifacts) { Copy-Item $artifacts (Join-Path $evidence '33-artifacts.txt') -Force }

# ---- 6. leftovers ------------------------------------------------------------
$left = Get-Process -Name AgentSoul -ErrorAction SilentlyContinue
$leftNode = Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like ($install + '*') }
Check ('no AgentSoul process left') ((-not $left)) ('count=' + @($left).Count)
Check ('no node process from install root') ((-not $leftNode)) ('count=' + @($leftNode).Count)
$portAfter = $true
for ($i = 0; $i -lt 12; $i++) {
  $portAfter = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) -ne $null
  if (-not $portAfter) { break }
  Start-Sleep -Milliseconds 500
}
Check ('port ' + $Port + ' released') ((-not $portAfter))
$smAfter = Test-Path $realStartMenu
$prAfter = Test-Path $realPrograms
Check ('real Start Menu untouched') (($smAfter -eq $smBefore)) ('before=' + $smBefore + ' after=' + $smAfter)
Check ('real install dir untouched') (($prAfter -eq $prBefore)) ('before=' + $prBefore + ' after=' + $prAfter)
Check ('production port 7310 not listening') ((-not (Get-NetTCPConnection -LocalPort 7310 -State Listen -ErrorAction SilentlyContinue)))
Check ('production chat port 8901 not listening') ((-not (Get-NetTCPConnection -LocalPort 8901 -State Listen -ErrorAction SilentlyContinue)))

# ---- 7. cleanup --------------------------------------------------------------
$installData = Join-Path $install 'data'
if (Test-Path $installData) {
  Save '43-install-data-files.txt' ((Get-ChildItem $installData -Recurse -File | ForEach-Object { $_.FullName.Replace($install + '\', '') + '  ' + $_.Length }) -join $NL)
  $shut = Join-Path $installData 'shutdown.log'
  if (Test-Path $shut) { Copy-Item $shut (Join-Path $evidence '44-shutdown.log') -Force }
}
foreach ($v in 'AGENT_SOUL_SHELL_HOME', 'AGENT_SOUL_HUB_PORT', 'AGENT_SOUL_SYNC', 'AGENT_SOUL_CHAT', 'AGENT_SOUL_TEST_EXIT_EVENT') {
  Remove-Item ('Env:' + $v) -ErrorAction SilentlyContinue
}
for ($i = 0; $i -lt 3; $i++) {
  try { Remove-Item $base -Recurse -Force -ErrorAction Stop; break }
  catch { Start-Sleep -Milliseconds 1500 }
}
Check ('temp install root removed') ((-not (Test-Path $base))) ($base)
Check ('evidence root kept') ((Test-Path $evidence)) ($evidence)

Say '---'
Say ('fails=' + $fails.Count)
if ($fails.Count) { foreach ($f in $fails) { Say ('  FAILED: ' + $f) } }
Save '99-acceptance.log' ($log -join $NL)
if ($fails.Count) { exit 1 }
exit 0