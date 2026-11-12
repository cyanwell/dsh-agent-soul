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
  [string]$Repo = "cyanwell/dsh-agent-soul"
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
  return $text
}

# 1. 取 release（没有就建）
$release = $null
try {
  $j = Invoke-Gh "GET" "https://api.github.com/repos/$Repo/releases/tags/$Tag" $null $null | ConvertFrom-Json
  $release = $j
  Write-Host ("找到已存在的 release: " + $j.name + " (id " + $j.id + ")")
} catch {
  Write-Host "release 不存在，创建中…"
  $payload = @{ tag_name = $Tag; name = $(if ($Title) { $Title } else { $Tag }); draft = $false; prerelease = $false } | ConvertTo-Json -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
  $release = Invoke-Gh "POST" "https://api.github.com/repos/$Repo/releases" $bytes "application/json" | ConvertFrom-Json
  Write-Host ("已创建 release id=" + $release.id)
}

# 2. 更新说明
if ($NotesFile -and (Test-Path $NotesFile)) {
  $notes = [System.IO.File]::ReadAllText((Resolve-Path $NotesFile), [System.Text.Encoding]::UTF8)
  $payload = @{ body = $notes } | ConvertTo-Json -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
  $null = Invoke-Gh "PATCH" ("https://api.github.com/repos/$Repo/releases/" + $release.id) $bytes "application/json"
  Write-Host ("已更新说明（" + $notes.Length + " 字符）")
}

# 3. 上传附件（同名跳过）
$existing = @{}
$assets = Invoke-Gh "GET" ("https://api.github.com/repos/$Repo/releases/" + $release.id + "/assets") $null $null | ConvertFrom-Json
foreach ($a in $assets) { $existing[$a.name] = $true }

foreach ($f in $Files) {
  if (-not (Test-Path $f)) { Write-Host ("跳过（不存在）: " + $f); continue }
  $name = Split-Path $f -Leaf
  if ($existing.ContainsKey($name)) { Write-Host ("已存在，跳过: " + $name); continue }
  $url = "https://uploads.github.com/repos/$Repo/releases/" + $release.id + "/assets?name=" + [uri]::EscapeDataString($name)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $stream = [System.IO.File]::OpenRead((Resolve-Path $f))
  $content = New-Object System.Net.Http.StreamContent($stream)
  $content.Headers.ContentType = New-Object System.Net.Http.Headers.MediaTypeHeaderValue("application/octet-stream")
  try {
    $resp = $client.PostAsync($url, $content).Result
    $text = [System.Text.Encoding]::UTF8.GetString($resp.Content.ReadAsByteArrayAsync().Result)
    if (-not $resp.IsSuccessStatusCode) { Write-Host ("上传失败 " + $name + ": " + [int]$resp.StatusCode + " " + $text) }
    else { Write-Host ("上传成功 " + $name + "  " + [math]::Round($sw.Elapsed.TotalSeconds,1) + "s") }
  } finally { $stream.Close() }
}

Write-Host ("完成: https://github.com/$Repo/releases/tag/$Tag")
$client.Dispose()
