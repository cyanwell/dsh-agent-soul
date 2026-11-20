@echo off
chcp 65001 >nul
rem 起 AgentSoul core。token 必须与 config 里 ingress.onebot.wsUrl 是同一个号：
rem   ws 3003 -> 3937956599（砚青号，主用）    ws 3001 -> 1901372960（备用）
setlocal
set "ROOT=C:\Users\pc\Desktop\deepseek harness\agent soul"
set "CFG=D:\AI\SnowLuma\config\onebot_3937956599.json"
rem ★ 正确写法照抄 start-with-onebot.cmd：usebackq + 反引号 = 执行命令；
rem   (Get-Content ...).networks 直接取属性，不用 $ 变量（$ 在 cmd 里会被当变量吃掉）。
rem   旧的写成 in (powershell ... "=Get-Content ...; .networks...") —— 少了反引号、
rem   $ 被吃掉、还用了分号，三个错叠在一起，for /f 什么也取不到，
rem   于是下面 if not defined 直接 exit /b 1，**AgentSoul 根本起不来**。
for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "(Get-Content '%CFG%' -Raw -Encoding UTF8 | ConvertFrom-Json).networks.wsServers[0].accessToken"`) do set "SOUL_ONEBOT_WS_TOKEN=%%a"
if not defined SOUL_ONEBOT_WS_TOKEN (
  echo [x] 没读到 token
  exit /b 1
)
taskkill /IM AgentSoul.exe /F >nul 2>&1
timeout /t 3 /nobreak >nul
start "" "%ROOT%\AgentSoul.exe"
echo [ok] core 已启动（听砚青号 3003）
endlocal
