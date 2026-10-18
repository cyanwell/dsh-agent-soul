# scan-apps.ps1 -- scan Start Menu and Desktop shortcuts to build the "Speed Dial" shelf.
#
#   apps\apps.json     [{ name, target, icon }]   read by the plugin host half
#   apps\icons\*.png   icons extracted from exe  shown by the client half
#
# Run (execution policy must be bypassed; this machine has no pwsh, only 5.1):
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scan-apps.ps1
#
# ==== WHY THIS FILE IS 100%% ASCII -- DO NOT PUT CJK IN HERE ====
# Windows PowerShell 5.1 reads .ps1 as ANSI (GBK on this box). A UTF-8 .ps1 without BOM
# gets mangled: some byte sequences eat quote characters and turn following code into
# comments. First run of this script reported 0 apps for exactly that reason.
# The fix is either a BOM or pure ASCII. This file is pure ASCII on purpose.
# (This is written down in skill `dsh-local-ops`, section 2; it was read and not applied.)
#
# ==== TWO OTHER TRAPS ALREADY PAID FOR ====
# 1) No global $ErrorActionPreference='SilentlyContinue'. That version swallowed the real
#    error and made a broken run look like an empty scan. Every failure is counted instead.
# 2) The list is written to disk BEFORE any System.Drawing work, so the icon step can fail
#    without taking the app list down with it.
# 3) JSON is written with .NET WriteAllText + UTF8Encoding($false): Set-Content -Encoding UTF8
#    emits a BOM, and Node cannot parse a BOM-prefixed JSON (that broke DSH startup before).

param([string]$OutDir = '.\apps')

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# ---- step 1: collect the list through COM only ----
$sh = $null
try {
  $sh = New-Object -ComObject WScript.Shell
} catch {
  Write-Output ("FATAL: cannot create WScript.Shell -> " + $_.Exception.Message)
  exit 1
}

$dirs = @(
  "$env:ProgramData\Microsoft\Windows\Start Menu\Programs",
  "$env:APPDATA\Microsoft\Windows\Start Menu\Programs",
  [Environment]::GetFolderPath('Desktop'),
  "$env:PUBLIC\Desktop"
)

$seen = @{}
$apps = @()
$nLnk = 0; $nNoTarget = 0; $nBadExt = 0; $nWin = 0; $nDup = 0; $nErr = 0

foreach ($d in $dirs) {
  if (-not (Test-Path $d)) { continue }
  $items = @(Get-ChildItem $d -Recurse -Filter *.lnk -Force -ErrorAction SilentlyContinue)
  foreach ($f in $items) {
    $nLnk++
    $t = $null
    try {
      $k = $sh.CreateShortcut($f.FullName)
      $t = $k.TargetPath
    } catch {
      $nErr++
      if ($nErr -le 3) { Write-Output ("  resolve failed: " + $f.Name + " :: " + $_.Exception.Message) }
      continue
    }
    if (-not $t) { $nNoTarget++; continue }

    $ext = [IO.Path]::GetExtension($t).ToLower()
    if ($ext -ne '.exe' -and $ext -ne '.bat' -and $ext -ne '.cmd') { $nBadExt++; continue }
    if ($t -like '*\Windows\system32\*') { $nWin++; continue }
    if ($t -like '*\Windows\SysWOW64\*') { $nWin++; continue }
    if ($t -like '*\Windows\Installer\*') { $nWin++; continue }
    if ($seen.ContainsKey($t)) { $nDup++; continue }

    $seen[$t] = $true
    $apps += [pscustomobject]@{ name = $f.BaseName; target = $t; icon = '' }
  }
}

Write-Output ("lnk " + $nLnk + " | no-target " + $nNoTarget + " | not-program " + $nBadExt + " | windows-tool " + $nWin + " | dup " + $nDup + " | resolve-err " + $nErr)
Write-Output ("==> kept " + $apps.Count)

# ---- step 2: write the list first (no BOM) ----
$sorted = @($apps | Sort-Object name)
$json = ConvertTo-Json -InputObject $sorted -Depth 3
if ($sorted.Count -eq 1) { $json = '[' + $json + ']' }
$jsonPath = Join-Path $OutDir 'apps.json'
[IO.File]::WriteAllText($jsonPath, $json, (New-Object Text.UTF8Encoding($false)))
Write-Output ("list written: " + $jsonPath + "  (" + (Get-Item $jsonPath).Length + " B)")

# ---- step 3: extract icons (a failure here must not touch step 2) ----
$iconDir = Join-Path $OutDir 'icons'
New-Item -ItemType Directory -Force -Path $iconDir | Out-Null
$made = 0; $have = 0
try {
  Add-Type -AssemblyName System.Drawing
  $md5 = [System.Security.Cryptography.MD5]::Create()
  for ($i = 0; $i -lt $sorted.Count; $i++) {
    $tgt = [string]$sorted[$i].target
    $bytes = [Text.Encoding]::UTF8.GetBytes($tgt)
    $hash = ([BitConverter]::ToString($md5.ComputeHash($bytes)) -replace '-', '').Substring(0, 12).ToLower()
    $png = Join-Path $iconDir ($hash + '.png')
    if (-not (Test-Path $png)) {
      try {
        $ico = [System.Drawing.Icon]::ExtractAssociatedIcon($tgt)
        if ($ico) {
          $bmp = $ico.ToBitmap()
          $bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
          $bmp.Dispose()
          $ico.Dispose()
          $made++
        }
      } catch { }
    }
    if (Test-Path $png) { $sorted[$i].icon = ($hash + '.png'); $have++ }
  }
  Write-Output ("icons: new " + $made + " | usable " + $have + " / " + $sorted.Count)
} catch {
  Write-Output ("icon step failed (list is safe): " + $_.Exception.Message)
}

# ---- step 4: rewrite the list with icon names ----
$json2 = ConvertTo-Json -InputObject $sorted -Depth 3
if ($sorted.Count -eq 1) { $json2 = '[' + $json2 + ']' }
[IO.File]::WriteAllText($jsonPath, $json2, (New-Object Text.UTF8Encoding($false)))

Write-Output "--- first 10 ---"
for ($i = 0; $i -lt [Math]::Min(10, $sorted.Count); $i++) {
  Write-Output ("  " + $sorted[$i].name + "   [" + $sorted[$i].icon + "]   ->   " + $sorted[$i].target)
}
