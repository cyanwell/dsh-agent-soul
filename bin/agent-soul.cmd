@echo off
chcp 65001 >nul
title agent-soul
cd /d "%~dp0.."
echo.
echo   agent-soul 启动中...
echo.
node src\index.mjs
echo.
echo   已退出。按任意键关闭。
pause >nul