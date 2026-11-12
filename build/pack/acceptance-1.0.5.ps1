# acceptance-1.0.5.ps1 -- isolated acceptance for the 1.0.5 payload (wizard / DPAPI / dual protocol).
# 1.0.5 delta: the payload carries the three read-model fixes (huanqi / waker ledger / autonomy).
# 1.0.3 delta: apiKeyRef is allow-listed in every surface; helper override is dev-only.
#
# ASCII-only on purpose (same reason as acceptance-1.0.1.ps1): Windows PowerShell 5.1 reads a
# BOM-less UTF-8 file with the GBK code page, and CJK bytes can decode into smart quotes that
# break parsing. Evidence does not need Chinese comments.
#
# What it proves (each item becomes a line in 99-acceptance.log):
#   1. silent install into a TEMP root, all three version dirs coexist, config = release fixture
#   2. the shipped config references the secret (llm.apiKeyRef = dpapi:...) and carries no key
#   3. secret stored through the INSTALLED helper (stdin), canary roundtrip works
#   4. first run on a high port: health 200, llmReady true, protocol/keySource as configured
#   5. GET /api/config shows hasKey/display and never the key itself
#  5b. POST /api/config receipt is redacted (F-1): 0 canary, before == unknown
#   6. no canary anywhere in the install tree, the shell log, the setup exe or the zips
#   7. graceful exit, port released, no leftover process, real Start Menu untouched
#   8. /Uninstall keeps the secret; /Uninstall /Purge deletes it
#   9. temp root removed, evidence root kept
#
# Evidence: D:\AI\agent-soul\_verify\accept-105-<ts>\  (never deleted)
param(
  [string]$Version = '1.0.5',
  [int]$Port = 7665
)
$ErrorActionPreference = 'Stop'
$NL = [Environment]::NewLine
$repo = 'D:\AI\agent-soul'
$dist = Join-Path $repo 'dist'
$setupExe = Join-Path $dist ('AgentSoul-Setup-' + $Version + '.exe')
$portable = Join-Path $dist ('AgentSoul-' + $Version + '-portable.zip')
$patch = Join-Path $dist ('AgentSoul-' + $Version + '-htmlpatch.zip')
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$base = Join-Path $env:TEMP ('agentsoul-105-' + $ts)
$install = Join-Path $base 'install'
$startmenu = Join-Path $base 'startmenu'
$shellhome = Join-Path $base 'shellhome'
$evidence = Join-Path $repo ('_verify\accept-105-' + $ts)
$canary = 'sk-canary-accept-105-' + $ts.Replace('-', '')

$log = New-Object System.Collections.ArrayList
$fails = New-Object System.Collections.ArrayList
function Say($m) { [void]$log.Add([string]$m); Write-Output $m }
function T {
  param([string]$Name, [bool]$Ok, [string]$Detail = '')
  $suffix = if ($Detail) { '  ::  ' + $Detail } else { '' }
  if ($Ok) { Say ('PASS  ' + $Name + $suffix) } else { Say ('FAIL  ' + $Name + $suffix); [void]$fails.Add($Name) }
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
  $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 20
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
  } catch { Say ('[exit] event open failed: ' + $_.Exception.Message) }
  $deadline = (Get-Date).AddSeconds(25)
  while ((Get-Date) -lt $deadline) {
    if ($script:shell.HasExited) { break }
    Start-Sleep -Milliseconds 250
  }
  Start-Sleep -Milliseconds 900
  Say ('[exit] exited=' + $script:shell.HasExited + ' code=' + $script:shell.ExitCode)
}
function Scan-Tree([string]$root) {
  $hits = @()
  if (-not (Test-Path $root)) { return $hits }
  foreach ($f in Get-ChildItem $root -Recurse -File -ErrorAction SilentlyContinue) {
    try {
      $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
      $txt = [System.Text.Encoding]::UTF8.GetString($bytes)
      if ($txt.Contains($canary)) { $hits += $f.FullName }
    } catch { }
  }
  return $hits
}

New-Item -ItemType Directory -Path $evidence -Force | Out-Null
New-Item -ItemType Directory -Path $install -Force | Out-Null
New-Item -ItemType Directory -Path $startmenu -Force | Out-Null
New-Item -ItemType Directory -Path $shellhome -Force | Out-Null
Say ('[run] base     = ' + $base)
Say ('[run] evidence = ' + $evidence)
Say ('[run] canary   = ' + $canary.Substring(0, 12) + '...(len ' + $canary.Length + ')')

# ---- 0. baseline -------------------------------------------------------------
$realStartMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\AgentSoul'
$realPrograms = Join-Path $env:LOCALAPPDATA 'Programs\AgentSoul'
$smBefore = Test-Path $realStartMenu
$prBefore = Test-Path $realPrograms
$portBefore = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) -ne $null
Say ('[run] baseline real-startmenu=' + $smBefore + ' real-programs=' + $prBefore + ' port=' + $Port + ' listening=' + $portBefore)
T 'port free before test' ((-not $portBefore)) ('listening=' + $portBefore)
T 'setup exe exists' ((Test-Path $setupExe)) $setupExe

# ---- 1. silent install (no key on the command line, ever) ---------------------
$sw = [Diagnostics.Stopwatch]::StartNew()
Start-Process -FilePath $setupExe -ArgumentList ('/D=' + $install), ('/StartMenuRoot=' + $startmenu), '/S' -Wait -NoNewWindow
$sw.Stop()
Say ('[run] silent install ms=' + $sw.ElapsedMilliseconds)
$cur = (Get-Content (Join-Path $install 'app\current.txt')).Trim()
T ('current.txt == ' + $Version) (($cur -eq $Version)) $cur
T 'app\1.0.0 still present' ((Test-Path (Join-Path $install 'app\1.0.0')))
T 'app\1.0.1 still present' ((Test-Path (Join-Path $install 'app\1.0.1')))
T 'app\1.0.2 still present' ((Test-Path (Join-Path $install 'app\1.0.2')))
T 'app\1.0.3 still present' ((Test-Path (Join-Path $install 'app\1.0.3')))
T 'install-log.txt written' ((Test-Path (Join-Path $install 'install-log.txt')))
$cfgRaw = Get-Content (Join-Path $install 'config.json') -Raw -Encoding UTF8
Save '01-config.json' $cfgRaw
$cfg = $cfgRaw | ConvertFrom-Json
T 'config.llm.apiKeyRef = dpapi:deepseek-official' (($cfg.llm.apiKeyRef -eq 'dpapi:deepseek-official')) ([string]$cfg.llm.apiKeyRef)
T 'config.llm.apiKey is empty' (([string]::IsNullOrEmpty($cfg.llm.apiKey))) ('[' + [string]$cfg.llm.apiKey + ']')
T 'config.llm.protocol present' (([string]$cfg.llm.protocol -eq 'openai')) ([string]$cfg.llm.protocol)
T 'SecretStore.exe shipped in runtime' ((Test-Path (Join-Path $install 'runtime\SecretStore.exe')))
T 'no secret file right after a silent install' ((-not (Test-Path (Join-Path $install 'data\secrets'))))

$lnk = Join-Path $startmenu 'AgentSoul\AgentSoul.lnk'
T 'shortcut created under temp StartMenuRoot' ((Test-Path $lnk)) $lnk
if (Test-Path $lnk) {
  $sh = New-Object -ComObject WScript.Shell
  $sc = $sh.CreateShortcut($lnk)
  Save '02-shortcut.txt' (@(('target = ' + $sc.TargetPath), ('workdir = ' + $sc.WorkingDirectory)) -join $NL)
  T 'shortcut target = temp install root' (($sc.TargetPath -eq (Join-Path $install 'AgentSoul.exe'))) $sc.TargetPath
}

# ---- 2. store the canary through the INSTALLED helper (stdin) -----------------
$ss = Join-Path $install 'runtime\SecretStore.exe'
$canary | & $ss @('set', '--provider', 'deepseek-official', '--root', $install) | Out-Null
$setExit = $LASTEXITCODE
$got = & $ss @('get', '--provider', 'deepseek-official', '--root', $install)
$secretFile = Join-Path $install 'data\secrets\deepseek-official.dpapi'
T 'SecretStore set exit=0' (($setExit -eq 0)) ('exit=' + $setExit)
T 'DPAPI roundtrip returns the canary' (($got -ceq $canary)) ('len=' + $got.Length)
T 'ciphertext file exists' ((Test-Path $secretFile)) $secretFile
$blobTxt = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($secretFile))
T 'canary not readable in the ciphertext' ((-not $blobTxt.Contains($canary))) ('bytes=' + (Get-Item $secretFile).Length)

# ---- 3. first run ------------------------------------------------------------
$script:eventName = 'AgentSoul105Exit' + $ts
$env:AGENT_SOUL_SHELL_HOME = $shellhome
$env:AGENT_SOUL_HUB_PORT = [string]$Port
$env:AGENT_SOUL_SYNC = 'off'
$env:AGENT_SOUL_CHAT = 'off'
$env:AGENT_SOUL_TEST_EXIT_EVENT = $script:eventName
$script:shell = Start-Process -FilePath (Join-Path $install 'AgentSoul.exe') -PassThru
Say ('[run] shell pid=' + $script:shell.Id)
$health = Wait-Health ('http://127.0.0.1:' + $Port + '/api/health') 90
T 'first run /api/health == 200' (($null -ne $health))
if ($health) {
  $hb = [System.Text.Encoding]::UTF8.GetString($health.RawContentStream.ToArray())
  Save '03-health.json' $hb
  Say ('[run] health=' + $hb)
  $hj = $hb | ConvertFrom-Json
  T 'health.service == agent-soul-core' (($hj.service -eq 'agent-soul-core'))
  T 'health.llmReady == true (dpapi secret resolved)' (($hj.llmReady -eq $true))
  T 'health.protocol == openai' (($hj.protocol -eq 'openai')) ([string]$hj.protocol)
  T 'health.keySource == dpapi:deepseek-official' (($hj.keySource -eq 'dpapi:deepseek-official')) ([string]$hj.keySource)
  T 'health.apiKeyRef stays dpapi:deepseek-official (1.0.2 compatibility)' (($hj.apiKeyRef -eq 'dpapi:deepseek-official')) ([string]$hj.apiKeyRef)
  T 'health.apiKeyRef is allow-listed (valid)' (($hj.apiKeyRefValid -eq $true))
  T 'health.baseUrl == https://api.deepseek.com' (($hj.baseUrl -eq 'https://api.deepseek.com')) ([string]$hj.baseUrl)
  T 'health body carries no canary' ((-not $hb.Contains($canary)))
}

$page = Get-Text ('http://127.0.0.1:' + $Port + '/')
Save '04-page.html' $page
T ('page build marker == ' + $Version) (($page -match ("agentsoul-build'\s+content='" + [regex]::Escape($Version) + "'")))
T 'page has no old marker' (($page -notmatch "content='1\.0\.[123]'"))

$cfgView = Get-Text ('http://127.0.0.1:' + $Port + '/api/config')
Save '05-config-view.json' $cfgView
$cv = $cfgView | ConvertFrom-Json
$keyField = $null
foreach ($g in $cv.groups) { foreach ($f in $g.fields) { if ($f.key -eq 'llm.apiKey') { $keyField = $f } } }
T 'GET /api/config has llm.apiKey field' (($null -ne $keyField))
if ($keyField) {
  T 'apiKey field hasKey == true' (($keyField.hasKey -eq $true))
  # NOTE: compare against the ASCII-safe facts only. The server's display text is Chinese, and a
  # CJK literal in a BOM-less UTF-8 .ps1 gets decoded as GBK by PowerShell 5.1 (it broke this
  # script once: a quote byte inside the literal ended the string). hasKey is the real judgement.
  T 'apiKey field display is non-empty' (([string]$keyField.display).Length -gt 0) ('len=' + ([string]$keyField.display).Length)
  T 'apiKey field exposes keySource' (($keyField.keySource -eq 'dpapi:deepseek-official')) ([string]$keyField.keySource)
  T 'apiKey field has no value/prefix/length' (($null -eq $keyField.value) -and ($null -eq $keyField.fileValue))
  T 'apiKey field has NO value property at all' (($keyField.PSObject.Properties.Name -notcontains 'value'))
  T 'apiKey keyRef stays dpapi:deepseek-official' (([string]$keyField.keyRef -eq 'dpapi:deepseek-official')) ([string]$keyField.keyRef)
}
T 'GET /api/config body carries no canary' ((-not $cfgView.Contains($canary)))

# ---- 3b. 1.0.4 (F-1): the POST /api/config receipt is redacted --------------
# 1.0.3 fixed GET but the WRITE receipt still echoed the OLD raw apiKeyRef twice
# (changed[].before and restartRequired[].before), and the settings page printed it.
# Here: put a raw key-shaped value into apiKeyRef on disk (disposable TEMP install
# root), then fix it through the same endpoint the settings page uses.
$cfgPath = Join-Path $install 'config.json'
$cfgObj = (Get-Content $cfgPath -Raw -Encoding UTF8) | ConvertFrom-Json
$cfgObj.llm.apiKeyRef = $canary
$rawFixed = ($cfgObj | ConvertTo-Json -Depth 12)
[System.IO.File]::WriteAllText($cfgPath, $rawFixed, (New-Object System.Text.UTF8Encoding($false)))
$postBody = '{"patch":{"llm.apiKeyRef":"dpapi:deepseek-official"}}'
$post = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $Port + '/api/config') -Method POST -UseBasicParsing -TimeoutSec 20 -ContentType 'application/json' -Body $postBody
$postTxt = [System.Text.Encoding]::UTF8.GetString($post.RawContentStream.ToArray())
Save '05b-post-receipt.json' $postTxt
$pj = $postTxt | ConvertFrom-Json
$pchg = $null
foreach ($c in $pj.changed) { if ($c.key -eq 'llm.apiKeyRef') { $pchg = $c } }
$prst = $null
foreach ($c in $pj.restartRequired) { if ($c.key -eq 'llm.apiKeyRef') { $prst = $c } }
T 'POST /api/config status 200' ($post.StatusCode -eq 200) ([string]$post.StatusCode)
T 'POST receipt body carries no canary' ((-not $postTxt.Contains($canary)))
T 'POST receipt has no 12-char canary slice' ((-not $postTxt.Contains($canary.Substring(0, 12))))
T 'POST receipt changed.before == unknown' (($null -ne $pchg) -and ([string]$pchg.before -eq 'unknown')) $(if ($pchg) { [string]$pchg.before } else { '(no entry)' })
T 'POST receipt changed.after == dpapi:deepseek-official' (($null -ne $pchg) -and ([string]$pchg.after -eq 'dpapi:deepseek-official')) $(if ($pchg) { [string]$pchg.after } else { '(no entry)' })
T 'POST receipt changed.sensitive == true' (($null -ne $pchg) -and ($pchg.sensitive -eq $true))
T 'POST receipt restartRequired.before == unknown' (($null -ne $prst) -and ([string]$prst.before -eq 'unknown')) $(if ($prst) { [string]$prst.before } else { '(no entry)' })
$cfgBack = Get-Content $cfgPath -Raw -Encoding UTF8
$cfgBackObj = $cfgBack | ConvertFrom-Json
T 'config.json back to the dpapi ref after the fix' ([string]$cfgBackObj.llm.apiKeyRef -eq 'dpapi:deepseek-official') ([string]$cfgBackObj.llm.apiKeyRef)
T 'config.json carries no canary after the fix' ((-not $cfgBack.Contains($canary)))
$status = Get-Text ('http://127.0.0.1:' + $Port + '/api/status')
Save '06-status.json' $status
T '/api/status has no dev soul path' (($status -notmatch 'D:[\\/]AI[\\/]yanqing-soul'))
T '/api/status has no dev repo path' (($status -notmatch 'D:[\\/]AI[\\/]agent-soul'))

Start-Sleep -Milliseconds 700
$slog = Find-ShellLog $shellhome
if ($slog) {
  Copy-Item $slog (Join-Path $evidence '07-shell.log') -Force
  $shTxt = Get-Content $slog -Raw -Encoding UTF8
  T ('shell.log core path == app\' + $Version) (($shTxt -match ('app\\' + [regex]::Escape($Version) + '\\src\\index.mjs')))
  T 'shell.log carries no canary' ((-not $shTxt.Contains($canary)))
} else {
  T 'shell.log exists' ($false) ('not found under ' + $shellhome)
}

Stop-ShellGracefully
T 'shell exited gracefully' ($script:shell.HasExited)
$portAfter = $true
for ($i = 0; $i -lt 12; $i++) {
  $portAfter = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) -ne $null
  if (-not $portAfter) { break }
  Start-Sleep -Milliseconds 500
}
T 'port released' ((-not $portAfter))

# ---- 4. canary scan ----------------------------------------------------------
$hits = Scan-Tree $install
Save '08-canary-scan-install.txt' (($hits -join $NL) + $NL + 'hits=' + @($hits).Count)
T 'canary hits inside the install tree == 0' ((@($hits).Count -eq 0)) ('hits=' + @($hits).Count)
foreach ($artifact in @($setupExe, $portable, $patch)) {
  if (-not (Test-Path $artifact)) { T ('artifact exists: ' + (Split-Path $artifact -Leaf)) ($false); continue }
  $bytes = [System.IO.File]::ReadAllBytes($artifact)
  $txt = [System.Text.Encoding]::UTF8.GetString($bytes)
  T ('canary not inside ' + (Split-Path $artifact -Leaf)) ((-not $txt.Contains($canary)))
}

# ---- 5. uninstall keeps the secret, /Purge deletes it ------------------------
Start-Process -FilePath $setupExe -ArgumentList ('/D=' + $install), ('/StartMenuRoot=' + $startmenu), '/Uninstall', '/S' -Wait -NoNewWindow
T 'uninstall removed AgentSoul.exe' ((-not (Test-Path (Join-Path $install 'AgentSoul.exe'))))
T 'uninstall KEPT the secret (needs /Purge)' ((Test-Path $secretFile)) $secretFile
T 'uninstall kept config.json' ((Test-Path (Join-Path $install 'config.json')))
T 'uninstall removed the shortcut' ((-not (Test-Path $lnk)))

Start-Process -FilePath $setupExe -ArgumentList ('/D=' + $install), ('/StartMenuRoot=' + $startmenu), '/S' -Wait -NoNewWindow
T 'reinstall brought the runtime back' ((Test-Path $ss))
$canary | & $ss @('set', '--provider', 'deepseek-official', '--root', $install) | Out-Null
T 'secret present before purge' ((Test-Path $secretFile))
Start-Process -FilePath $setupExe -ArgumentList ('/D=' + $install), ('/StartMenuRoot=' + $startmenu), '/Uninstall', '/Purge', '/S' -Wait -NoNewWindow
T '/Purge deleted the secret' ((-not (Test-Path $secretFile))) $secretFile
T '/Purge left other data alone (data dir still there)' ((Test-Path (Join-Path $install 'data')))

# ---- 6. leftovers / real machine untouched -----------------------------------
$left = Get-Process -Name AgentSoul -ErrorAction SilentlyContinue
T 'no AgentSoul process left' ((-not $left)) ('count=' + @($left).Count)
$smAfter = Test-Path $realStartMenu
$prAfter = Test-Path $realPrograms
T 'real Start Menu untouched' (($smAfter -eq $smBefore)) ('before=' + $smBefore + ' after=' + $smAfter)
T 'real install dir untouched' (($prAfter -eq $prBefore)) ('before=' + $prBefore + ' after=' + $prAfter)
T 'production port 7310 not listening' ((-not (Get-NetTCPConnection -LocalPort 7310 -State Listen -ErrorAction SilentlyContinue)))

# ---- 7. cleanup --------------------------------------------------------------
foreach ($v in 'AGENT_SOUL_SHELL_HOME', 'AGENT_SOUL_HUB_PORT', 'AGENT_SOUL_SYNC', 'AGENT_SOUL_CHAT', 'AGENT_SOUL_TEST_EXIT_EVENT') {
  Remove-Item ('Env:' + $v) -ErrorAction SilentlyContinue
}
for ($i = 0; $i -lt 3; $i++) {
  try { Remove-Item $base -Recurse -Force -ErrorAction Stop; break }
  catch { Start-Sleep -Milliseconds 1500 }
}
T 'temp root removed' ((-not (Test-Path $base))) $base
T 'evidence root kept' ((Test-Path $evidence)) $evidence

Say '---'
Say ('fails=' + $fails.Count)
if ($fails.Count) { foreach ($f in $fails) { Say ('  FAILED: ' + $f) } }
Save '99-acceptance.log' ($log -join $NL)
if ($fails.Count) { exit 1 }
exit 0
