@echo off
chcp 65001 >nul
rem 起 AgentSoul core。token 必须与 config 里 ingress.onebot.wsUrl 是同一个号：
rem   ws 3003 -> 3937956599（砚青号，主用）    ws 3001 -> 1901372960（备用）
setlocal
set "ROOT=C:\Users\pc\Desktop\deepseek harness\agent soul"
set "CFG=D:\AI\SnowLuma\config\onebot_3937956599.json"
for /f "usebackq delims=" %%a in (powershell -NoProfile -Command "=Get-Content '%CFG%' -Raw|ConvertFrom-Json; .networks.wsServers[0].accessToken") do set "SOUL_ONEBOT_WS_TOKEN=%%a"
if not defined SOUL_ONEBOT_WS_TOKEN (
  echo [x] 没读到 token
  exit /b 1
)
taskkill /IM AgentSoul.exe /F >nul 2>&1
timeout /t 3 /nobreak >nul
start "" "%ROOT%\AgentSoul.exe"
echo [ok] core 已启动（听砚青号 3003）
endlocal
