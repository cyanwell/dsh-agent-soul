# 一键拍三页（子 agent 改完视觉后用它验收）
# 用法：powershell -NoProfile -File D:\AI\agent-soul\tools\shoot-ui.ps1
$ErrorActionPreference = 'SilentlyContinue'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$out  = 'D:\AI\agent-soul\_verify\ui-sub'
New-Item -ItemType Directory -Path $out -Force | Out-Null
$tmp  = Join-Path $env:TEMP ('shoot-' + (Get-Date -Format 'HHmmss'))

$pages = @(
  @('sphere',    '/sphere'),
  @('chat',      '/'),
  @('dashboard', '/dashboard')
)
foreach ($p in $pages) {
  $file = Join-Path $out ($p[0] + '.png')
  Remove-Item $file -Force -ErrorAction SilentlyContinue
  & $edge --headless=new --disable-gpu --no-first-run --no-default-browser-check `
    --user-data-dir=$tmp --window-size=1400,900 --virtual-time-budget=6000 `
    --screenshot="$file" ("http://127.0.0.1:7310" + $p[1]) 2>&1 | Out-Null
  Start-Sleep -Milliseconds 700
  if (Test-Path $file) {
    "{0,-10} {1,8} KB  {2}" -f $p[0], [math]::Round((Get-Item $file).Length / 1KB), $file
  } else {
    "{0,-10} NOT CREATED" -f $p[0]
  }
}
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
