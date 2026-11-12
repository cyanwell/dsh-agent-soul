@echo off
set AGENT_SOUL_PORT=7310
cd /d D:\AI\agent-soul
"C:\Users\pc\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" src\index.mjs >> data\gui.log 2>&1
