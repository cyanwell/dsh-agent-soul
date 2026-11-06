' agent-soul 静默启动器 —— 不开黑窗，起完自动打开界面
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = root
sh.Run "node src\index.mjs", 0, False
WScript.Sleep 2500
sh.Run "http://127.0.0.1:7310", 1, False