# 编译 AgentSoul.exe —— M0 壳
#
# 为什么用 csc 而不是 dotnet build：本机没有 dotnet SDK（也没有 npm），
# 而 .NET Framework 4.x 自带 csc.exe —— 系统自带的东西最不容易坏。
#
# ★ 编译约束 /langversion:5：Shell.cs 里不许出现插值字符串、?.、nameof、表达式体、out var。
#
# 用法： powershell -NoProfile -ExecutionPolicy Bypass -File D:\AI\agent-soul\build\build.ps1
$ErrorActionPreference = "Stop"
$build = "D:\AI\agent-soul\build"
$wv = Join-Path $build "webview2"
$src = Join-Path $build "Shell.cs"
$out = Join-Path $build "AgentSoul.exe"
$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"

# ★ 2026-11-10：应用图标 —— 两种嵌入方式一起用，各有各的用处：
#   /win32icon → 进 PE 资源：资源管理器、开始菜单、Alt+Tab 看到的是它；
#   /resource  → 进托管资源：运行期的窗口/托盘用 Icon(Stream) 从自身读，不依赖磁盘上的 ico。
$assets = Join-Path $build "assets"
$ico = Join-Path $assets "agentsoul.ico"

$core = Join-Path $wv "Microsoft.Web.WebView2.Core.dll"
$winf = Join-Path $wv "Microsoft.Web.WebView2.WinForms.dll"
$loader = Join-Path $wv "WebView2Loader.dll"
foreach ($f in @($csc, $src, $core, $winf, $loader, $ico)) {
    if (-not (Test-Path $f)) { throw ("缺文件：" + $f) }
}

# ★ 2026-11-10：编新 exe 之前先把旧的留一份。
#   理由：壳就是启动链本身 —— 新壳起不来（或行为不对）时，唯一能立刻回退的东西是旧 exe；
#   而源码已经改过，「再编一次」等于没有退路。
#   备份走 data\_backup\exe\<时间戳>\，和 health-identity 那批人工备份不混。
if (Test-Path $out) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $repoRoot = Split-Path $build -Parent
    $bakDir = Join-Path $repoRoot ("data\_backup\exe\" + $stamp)
    New-Item -ItemType Directory -Path $bakDir -Force | Out-Null
    $bakExe = Join-Path $bakDir "AgentSoul.exe"
    Copy-Item $out $bakExe -Force
    Write-Output ("backup-old-exe = " + $bakExe)
    Write-Output ("backup-old-sha256 = " + (Get-FileHash $bakExe -Algorithm SHA256).Hash)
    Remove-Item $out -Force
}

$cscArgs = @(
    "/nologo", "/target:winexe", "/platform:x64", "/langversion:5", "/utf8output",
    ("/out:" + $out),
    ("/r:" + $core),
    ("/r:" + $winf),
    ("/win32icon:" + $ico),
    ("/resource:" + $ico + ",AgentSoul.app.ico"),
    "/r:System.dll", "/r:System.Core.dll", "/r:System.Drawing.dll", "/r:System.Windows.Forms.dll", "/r:System.Management.dll",
    $src
)

$sw = [Diagnostics.Stopwatch]::StartNew()
& $csc $cscArgs
$code = $LASTEXITCODE
$sw.Stop()
if ($code -ne 0) { throw ("csc 失败 exit=" + $code) }

# ★ 三个 DLL 必须和 exe 放一起：两个托管程序集是运行时引用，
#   WebView2Loader.dll 是**原生**库（P/Invoke 找它），少一个就起不来。
foreach ($d in @($loader, $core, $winf)) {
    Copy-Item $d (Join-Path $build (Split-Path $d -Leaf)) -Force
}

$fi = Get-Item $out
Write-Output ("compile-ms = " + $sw.ElapsedMilliseconds)
Write-Output ("exe = " + $fi.FullName)
Write-Output ("exe-bytes = " + $fi.Length)
Write-Output ("exe-sha256 = " + (Get-FileHash $out -Algorithm SHA256).Hash)
Write-Output ("icon = " + $ico)
Write-Output ("icon-bytes = " + (Get-Item $ico).Length)
Write-Output ("icon-sha256 = " + (Get-FileHash $ico -Algorithm SHA256).Hash)
