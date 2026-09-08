' 静默启动 GitHub Star Tracker：无控制台窗口，后台常驻
Set WshShell = CreateObject("WScript.Shell")
NodeExe = "C:\Program Files\nodejs\node.exe"
ServerJs = "E:\Project\github-star-tracker\server.js"
WorkingDir = "E:\Project\github-star-tracker"

' 参数 0 = 隐藏窗口；False = 不等待
WshShell.CurrentDirectory = WorkingDir
WshShell.Run """" & NodeExe & """ """ & ServerJs & """", 0, False
