# probe.ps1 - local model status probe (read-only, no side effects)
# ★ Output is ASCII-only on purpose: this machine's powershell.exe is 5.1 and reads
#   .ps1 as GBK unless the file has a BOM. English output sidesteps the whole trap.
# Usage: powershell -NoProfile -File probe.ps1 [-Json]
param([switch]$Json)

$out = [ordered]@{}

$proc = Get-Process python -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*comfyui*' }
$api  = & curl.exe -s --max-time 2 "http://127.0.0.1:8188/system_stats" 2>$null
$out.comfyui = [ordered]@{
  running  = [bool]$proc
  pids     = @($proc | ForEach-Object { $_.Id })
  memMB    = [int](($proc | Measure-Object WorkingSet64 -Sum).Sum / 1MB)
  apiUp    = [bool]$api
  endpoint = 'http://127.0.0.1:8188'
}

$ck = "<ComfyUI 目录>\models\checkpoints"
$out.checkpoints = @()
if (Test-Path $ck) {
  $out.checkpoints = @(Get-ChildItem $ck -File | Where-Object { $_.Length -gt 0 } |
    Sort-Object Length -Descending |
    ForEach-Object { [ordered]@{ name = $_.Name; gb = [math]::Round($_.Length/1GB, 2) } })
}

# ── bundled models: multi-file pipelines that are NOT a single checkpoint ──
# ★ 0-11 added. Reason: 'checkpoints' only sees single-file models, so
#   Qwen-Image 2.1 -- a 3-part bundle (unet gguf + text encoder + vae) sitting in
#   three other folders -- showed up nowhere in the panel. One entry per bundle.
# ★ Patterns are deliberately exact: text_encoders also holds
#   Qwen3VL-8B-Instruct-Q4_K_M.gguf, which must NOT be counted (a GGUF text
#   encoder is known-bad for this pipeline).
$mdl = "<ComfyUI 目录>\models"
$bundleDefs = @(
  [ordered]@{
    name  = 'Qwen-Image 2.1 Turbo'
    parts = @(
      [ordered]@{ dir = 'unet';          pattern = 'qwen_image_2.1_turbo*' },
      [ordered]@{ dir = 'text_encoders'; pattern = 'qwen3vl_8b_w4a8.safetensors' },
      [ordered]@{ dir = 'vae';           pattern = 'qwen_image_2.1_vae_bf16.safetensors' }
    )
  }
)
$out.bundles = @()
foreach ($b in $bundleDefs) {
  $found = @(); $sum = 0.0
  foreach ($p in $b.parts) {
    $dir = Join-Path $mdl $p.dir
    $f = Get-ChildItem $dir -File -ErrorAction SilentlyContinue |
         Where-Object { $_.Name -like $p.pattern -and $_.Length -gt 0 } |
         Sort-Object Length -Descending | Select-Object -First 1
    if ($f) {
      $gb = [math]::Round($f.Length / 1GB, 2)
      $sum += $gb
      $found += [ordered]@{ part = $p.dir; name = $f.Name; gb = $gb }
    }
  }
  if ($found.Count -gt 0) {
    $out.bundles += [ordered]@{ name = $b.name; gb = [math]::Round($sum, 2); parts = $found }
  }
}

# ★ 0-11 fixed: the unquoted '--query-gpu=a,b,c' form is fragile under
#   PowerShell 5.1 -- the commas can be read as an array separator, splitting the
#   argument, and nvidia-smi then dies with "The command parameter was already
#   specified", leaving gpu = $null. Quoting each argument is what actually works.
$g = & nvidia-smi '--query-gpu=name,memory.used,memory.total,utilization.gpu' '--format=csv,noheader,nounits' 2>$null
if ($g) {
  $p = $g -split ',\s*'
  $out.gpu = [ordered]@{ name = $p[0]; usedMiB = [int]$p[1]; totalMiB = [int]$p[2]; utilPct = [int]$p[3] }
} else { $out.gpu = $null }

$out.ports = @()
foreach ($p in @(@{n='comfyui';p=8188}, @{n='qq-gw';p=3001}, @{n='qq-gw-alt';p=3100})) {
  $t = Test-NetConnection -ComputerName 127.0.0.1 -Port $p.p -InformationLevel Quiet -WarningAction SilentlyContinue -ErrorAction SilentlyContinue
  $out.ports += [ordered]@{ name = $p.n; port = $p.p; up = [bool]$t }
}

if ($Json) { $out | ConvertTo-Json -Depth 5 } else {
  "local-model status  $(Get-Date -Format 'HH:mm:ss')"
  "  comfyui   " + $(if ($out.comfyui.running) { 'running' } else { 'stopped' }) + "   api=" + $(if ($out.comfyui.apiUp) { 'up' } else { 'down' })
  if ($out.gpu) { "  vram      $($out.gpu.usedMiB) / $($out.gpu.totalMiB) MiB   util $($out.gpu.utilPct)%" }
  foreach ($c in $out.checkpoints) { "  ckpt      $($c.name)  $($c.gb) GB" }
  foreach ($p in $out.ports) { "  " + $p.name.PadRight(9) + " :$($p.port)  " + $(if ($p.up) { 'up' } else { 'down' }) }
}