# 起 AgentSoul core，并把砚青号（3937956599）的 OneBot token 注入环境变量。
# ★ 2026-11-12：v4 统一听砚青号（3003）。1901372960 只用来做测试发送方。
#   token 只进环境变量，不打印、不落盘。
$root = "C:\Users\pc\Desktop\deepseek harness\agent soul"
$ob = Get-Content "D:\AI\SnowLuma\config\onebot_3937956599.json" -Raw -Encoding UTF8 | ConvertFrom-Json
$env:SOUL_ONEBOT_WS_TOKEN = [string]$ob.networks.wsServers[0].accessToken
Write-Host ('token 注入，长度 = ' + $env:SOUL_ONEBOT_WS_TOKEN.Length)
Stop-Process -Name AgentSoul -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Start-Process -FilePath (Join-Path $root "AgentSoul.exe") -WorkingDirectory $root
Write-Host 'core 已启动'