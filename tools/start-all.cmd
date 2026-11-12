@echo off
chcp 65001 >nul
rem 2026-11-12：真正的逻辑在 start-all.mjs 里（cmd 的 start + 含空格路径实测起不来）。
rem 这个文件只是个入口，方便双击或从 cmd 里跑。
& "D:\AI\dsh\home\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" "D:\AI\agent-soul\tools\start-all.mjs" %*
