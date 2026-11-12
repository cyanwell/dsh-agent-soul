# make-shortcut.ps1 - create the AgentSoul Start Menu shortcut.
#
# SAFETY: this script never touches the real Start Menu unless you say so explicitly.
#   - test / CI   : pass -StartMenuRoot <temp dir>          (allowed, no extra flag needed)
#   - real install: pass -AllowRealStartMenu               (writes %APPDATA%\Microsoft\Windows\Start Menu\Programs)
#
# Usage (single line):
#   powershell -NoProfile -ExecutionPolicy Bypass -File build\pack\make-shortcut.ps1 -StartMenuRoot "C:\tmp\sm\Programs" -ExePath "D:\AI\agent-soul\dist\AgentSoul\AgentSoul.exe"
param(
  [string]$StartMenuRoot = "",
  [string]$ExePath = "D:\AI\agent-soul\dist\AgentSoul\AgentSoul.exe",
  [string]$Name = "AgentSoul",
  [string]$Description = "AgentSoul - soul layer runtime",
  [switch]$AllowRealStartMenu,
  [switch]$Quiet
)

$ErrorActionPreference = "Stop"

function Say($m) { if (-not $Quiet) { Write-Output $m } }

# ---- 1. which root -----------------------------------------------------------
$realRoot = [Environment]::GetFolderPath("Programs")
if ([string]::IsNullOrWhiteSpace($StartMenuRoot)) {
  if (-not $AllowRealStartMenu) {
    throw ("refusing to write the real Start Menu. For tests pass -StartMenuRoot <temp dir>; " +
           "to really install pass -AllowRealStartMenu. Real path is: $realRoot")
  }
  $root = $realRoot
  $isReal = $true
} else {
  $root = [System.IO.Path]::GetFullPath($StartMenuRoot)
  $isReal = ($root.TrimEnd('\') -ieq $realRoot.TrimEnd('\'))
}

# ---- 2. target exe must exist (fail before creating anything) ----------------
if (-not (Test-Path -LiteralPath $ExePath)) { throw "exe not found: $ExePath" }
$exe = (Get-Item -LiteralPath $ExePath).FullName
$workDir = Split-Path -Parent $exe

# ---- 3. create folder + .lnk -------------------------------------------------
$folder = Join-Path $root "AgentSoul"
New-Item -ItemType Directory -Path $folder -Force | Out-Null
$lnk = Join-Path $folder ($Name + ".lnk")

$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut($lnk)
$s.TargetPath       = $exe
$s.WorkingDirectory = $workDir
$s.IconLocation     = $exe + ",0"
$s.Description      = $Description
$s.WindowStyle      = 1
$s.Save()
[void][Runtime.InteropServices.Marshal]::ReleaseComObject($s)
[void][Runtime.InteropServices.Marshal]::ReleaseComObject($ws)

# ---- 4. read it back and prove what got written ------------------------------
$ws2 = New-Object -ComObject WScript.Shell
$b = $ws2.CreateShortcut($lnk)
$back = [ordered]@{
  lnk              = $lnk
  startMenuRoot    = $root
  isRealStartMenu  = $isReal
  target           = $b.TargetPath
  workingDirectory = $b.WorkingDirectory
  iconLocation     = $b.IconLocation
  description      = $b.Description
  bytes            = (Get-Item -LiteralPath $lnk).Length
}
[void][Runtime.InteropServices.Marshal]::ReleaseComObject($b)
[void][Runtime.InteropServices.Marshal]::ReleaseComObject($ws2)

Say "shortcut-created"
foreach ($k in $back.Keys) { Say ("  {0,-16} = {1}" -f $k, $back[$k]) }

if ($back.target -ne $exe) { throw "shortcut target mismatch: $($back.target) != $exe" }
