# focus-app.ps1 -- if this exe is already running, bring its window to the front.
#
#   prints "OK <pid>"  when it activated an existing window
#   prints "NONE"      when nothing was running (caller should then launch it)
#
# ★ PURE ASCII on purpose. Windows PowerShell 5.1 reads .ps1 as ANSI (GBK on this box);
#   a UTF-8 .ps1 without BOM gets mangled and can even turn code into comments.
#   That bit us once tonight (scan-apps.ps1 reported 0 apps for exactly this reason).
#
# Run: powershell.exe -NoProfile -ExecutionPolicy Bypass -File focus-app.ps1 -ExePath "C:\...\foo.exe"
param([string]$ExePath)

$ErrorActionPreference = 'SilentlyContinue'

if (-not $ExePath) { Write-Output 'NONE'; exit 0 }

# process name = exe file name without extension
$name = [IO.Path]::GetFileNameWithoutExtension($ExePath)
if (-not $name) { Write-Output 'NONE'; exit 0 }

$procs = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
if ($procs.Count -eq 0) { Write-Output 'NONE'; exit 0 }

$wsh = New-Object -ComObject WScript.Shell
foreach ($p in $procs) {
  # AppActivate takes a PID; returns $true when it managed to activate a window
  if ($wsh.AppActivate($p.Id)) {
    Write-Output ('OK ' + $p.Id)
    exit 0
  }
}

# the process is alive but has no window we can activate (tray-only, or no main window)
Write-Output ('ALIVE ' + $procs[0].Id)
exit 0
