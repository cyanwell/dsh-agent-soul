# diag-scan.ps1 —— 为什么 scan-apps.ps1 扫出 0 个？
# 只回答四件事：shell 版本 / COM 能不能建 / 四个目录各有多少 lnk / 第一条能不能解析出 target
$ErrorActionPreference = 'Continue'

Write-Output ("PSVersion = " + $PSVersionTable.PSVersion.ToString())

$sh = $null
try {
  $sh = New-Object -ComObject WScript.Shell
  Write-Output "COM WScript.Shell = OK"
} catch {
  Write-Output ("COM FAIL: " + $_.Exception.Message)
}

$dirs = @(
  "$env:ProgramData\Microsoft\Windows\Start Menu\Programs",
  "$env:APPDATA\Microsoft\Windows\Start Menu\Programs",
  [Environment]::GetFolderPath('Desktop'),
  "$env:PUBLIC\Desktop"
)

foreach ($d in $dirs) {
  $exists = Test-Path $d
  $lnks = @()
  if ($exists) {
    $lnks = @(Get-ChildItem $d -Recurse -Filter *.lnk -Force -ErrorAction SilentlyContinue)
  }
  Write-Output ("dir exists=" + $exists + "  lnk=" + $lnks.Count + "   " + $d)
  if (($lnks.Count -gt 0) -and ($sh -ne $null)) {
    $f = $lnks[0]
    try {
      $k = $sh.CreateShortcut($f.FullName)
      Write-Output ("   first: " + $f.BaseName + "  ->  " + $k.TargetPath)
    } catch {
      Write-Output ("   first ERR: " + $_.Exception.Message)
    }
  }
}
