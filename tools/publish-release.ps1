<#
  publish-release.ps1 — 一条命令发 GitHub Release（PAT 直连，不走 gh）

  为什么不用 gh：
    · gh 要求 token 带 read:org scope，我们只需要 repo
    · 这台机器 github.com 的 POST（device flow 换 token）不通；api.github.com 与 uploads.github.com 通

  用法：
    .\tools\publish-release.ps1 -Tag 1.0.64 -NotesFile .\notes.md -Title "AgentSoul v4 1.0.64" ^
      -Files @("dist\AgentSoul-Setup-1.0.64.exe","dist\AgentSoul-1.0.64-portable.zip")

  令牌：%USERPROFILE%\.config\yanqing\github-token（只当前用户可读，脚本内部不打印内容）
#>
param(
  [Parameter(Mandatory=$true)][string]$Tag,
  [Parameter(Mandatory=$true)][string[]]$Files,
  [string]$NotesFile,
  [string]$Title,
  [string]$Repo = "cyanwell/dsh-agent-soul",
  # ★ 覆盖模式：先删同名旧附件，再上传新的。默认 false（同名跳过），
  #   因为「重跑一次不该悄悄替换线上东西」——要替换得你明说。
  [switch]$Replace
)

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Net.Http

$tokenPath = Join-Path $env:USERPROFILE ".config\yanqing\github-token"
if (-not (Test-Path $tokenPath)) { throw "找不到令牌文件: $tokenPath" }
$token = [System.IO.File]::ReadAllText($tokenPath).Trim()
if ($token.Length -lt 20) { throw "令牌文件内容不像 token（长度 $($token.Length)）" }

$client = New-Object System.Net.Http.HttpClient
$client.Timeout = [TimeSpan]::FromMinutes(30)
$client.DefaultRequestHeaders.Add("Authorization", "token " + $token)
$client.DefaultRequestHeaders.Add("User-Agent", "agent-soul-release")
$client.DefaultRequestHeaders.Add("Accept", "application/vnd.github+json")

function Invoke-Gh([string]$Method, [string]$Url, [byte[]]$Body, [string]$ContentType) {
  $m = New-Object System.Net.Http.HttpMethod($Method)
  $req = New-Object System.Net.Http.HttpRequestMessage($m, $Url)
  if ($null -ne $Body -and $Body.Length -gt 0) {
    $c = New-Object System.Net.Http.ByteArrayContent($Body, 0, $Body.Length)
    $c.Headers.ContentType = New-Object System.Net.Http.Headers.MediaTypeHeaderValue($ContentType)
    $req.Content = $c
  }
  $resp = $client.SendAsync($req).Result
  $raw = $resp.Content.ReadAsByteArrayAsync().Result
  $text = if ($raw.Length -gt 0) { [System.Text.Encoding]::UTF8.GetString($raw) } else { "" }
  if (-not $resp.IsSuccessStatusCode) { throw ("$Method $Url -> " + [int]$resp.StatusCode + " " + $text) }
  # ★★★ 必须用 ,$text 包一层：PowerShell 会把**多行字符串按行展开成数组**。
  #   JSON 有换行，于是这个函数原来返回的是几百行文本组成的字符串数组，
  #   ConvertFrom-Json 只吃到第一行 → 解析出残破对象/空对象。
  #   症状不是报错，是「已存在的附件判断恒为假」→ 覆盖发布直接撞 already_exists（实测 422）。
  #   $existing.ContainsKey 因此永远是 false —— 我一开始怀疑 BOM、怀疑调用方式，
  #   真凶只是少了一个逗号。
  return ,$text
}

# 1. 取 release（没有就建）
$release = $null
try {
  $j = Invoke-Gh "GET" "https://api.github.com/repos/$Repo/releases/tags/$Tag" $null $null | ConvertFrom-Json
  $release = $j
  Write-Output ("找到已存在的 release: " + $j.name + " (id " + $j.id + ")")
} catch {
  Write-Output "release 不存在，创建中…"
  $payload = @{ tag_name = $Tag; name = $(if ($Title) { $Title } else { $Tag }); draft = $false; prerelease = $false } | ConvertTo-Json -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
  $release = Invoke-Gh "POST" "https://api.github.com/repos/$Repo/releases" $bytes "application/json" | ConvertFrom-Json
  Write-Output ("已创建 release id=" + $release.id)
}

# 2. 更新说明
if ($NotesFile -and (Test-Path $NotesFile)) {
  $notes = [System.IO.File]::ReadAllText((Resolve-Path $NotesFile), [System.Text.Encoding]::UTF8)
  $payload = @{ body = $notes } | ConvertTo-Json -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
  $null = Invoke-Gh "PATCH" ("https://api.github.com/repos/$Repo/releases/" + $release.id) $bytes "application/json"
  Write-Output ("已更新说明（" + $notes.Length + " 字符）")
}

# 3. 上传附件（同名跳过）
$existing = @{}
# ★★★ 这里绕了三圈才对，把弯路写下来：
#   ① 先怀疑 @() 包错了 → 加 @() 后 assets 计数=1、元素类型=Object[]（数组套数组），
#      $existing 里唯一的键是空串，匹配不上任何文件名；
#   ② 真因是 Invoke-Gh 的 return 少了一个逗号 —— 不写 'return ,$text' 时，
#      PowerShell 会把**多行 JSON 按行展开成字符串数组**，于是 '字符串数组 | ConvertFrom-Json'
#      逐行解析，再被 @() 一包就成了「数组里的数组」；
#   ③ 现在 return 已经修好，这里就**不能再包 @()**：ConvertFrom-Json 对数组本来就返回数组。
#   症状一直是「已存在判断恒为假」→ 覆盖发布直接撞 already_exists（422）。
$assetsRaw = Invoke-Gh "GET" ("https://api.github.com/repos/$Repo/releases/" + $release.id + "/assets") $null $null
$assets = ConvertFrom-Json -InputObject $assetsRaw
# 兜底：万一只有一个附件、ConvertFrom-Json 返回单对象，这里统一成数组再遍历。
if ($assets -isnot [array]) { $assets = @($assets) }
foreach ($a in $assets) { if ($a -and $a.name) { $existing[$a.name] = $true } }
Write-Output ("  现有附件 " + $existing.Count + " 个: " + (($existing.Keys) -join ', '))

foreach ($f in $Files) {
  if (-not (Test-Path $f)) { Write-Output ("跳过（不存在）: " + $f); continue }
  $name = Split-Path $f -Leaf
  if ($existing.ContainsKey($name)) {
    if (-not $Replace) {
      Write-Output ("已存在，跳过: " + $name + "（要覆盖请加 -Replace）")
      continue
    }
    # 覆盖：按名字找到旧附件 id，删掉再传
    $old = $assets | Where-Object { $_.name -eq $name } | Select-Object -First 1
    if ($old) {
      Write-Output ("  覆盖：先删旧附件 " + $name + " (" + $old.size + " B, id " + $old.id + ")")
      $null = Invoke-Gh "DELETE" ("https://api.github.com/repos/$Repo/releases/assets/" + $old.id) $null $null
      $existing.Remove($name)
    }
  }
  $url = "https://uploads.github.com/repos/$Repo/releases/" + $release.id + "/assets?name=" + [uri]::EscapeDataString($name)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $stream = [System.IO.File]::OpenRead((Resolve-Path $f))
  $content = New-Object System.Net.Http.StreamContent($stream)
  $content.Headers.ContentType = New-Object System.Net.Http.Headers.MediaTypeHeaderValue("application/octet-stream")
  try {
    $resp = $client.PostAsync($url, $content).Result
    $text = [System.Text.Encoding]::UTF8.GetString($resp.Content.ReadAsByteArrayAsync().Result)
    if (-not $resp.IsSuccessStatusCode) { Write-Output ("上传失败 " + $name + ": " + [int]$resp.StatusCode + " " + $text) }
    else { Write-Output ("上传成功 " + $name + "  " + [math]::Round($sw.Elapsed.TotalSeconds,1) + "s") }
  } finally { $stream.Close() }
}

Write-Output ("完成: https://github.com/$Repo/releases/tag/$Tag")
$client.Dispose()
