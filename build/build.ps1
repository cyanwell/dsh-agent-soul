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

# ★ 2026-11-21：DPI 两份配套文件（治「整窗被拉伸 1.5 倍所以字糊」）
#   · AgentSoul.manifest —— 进程感知级别（/win32manifest 编译进 PE）
#   · AgentSoul.exe.config —— WinForms 自己按 PerMonitorV2 布局（放 exe 旁边）
#   ★ 缺哪个都不完整：只给 manifest → 字不糊但控件按 96 DPI 排、偏小错位；
#     只给 config → WinForms 想缩放，可进程还是 DPI Unaware，白搭。
$manifest = Join-Path $build "AgentSoul.manifest"
$appConfig = Join-Path $build "AgentSoul.exe.config"

$core = Join-Path $wv "Microsoft.Web.WebView2.Core.dll"
$winf = Join-Path $wv "Microsoft.Web.WebView2.WinForms.dll"
$loader = Join-Path $wv "WebView2Loader.dll"
foreach ($f in @($csc, $src, $core, $winf, $loader, $ico, $manifest, $appConfig)) {
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
    # ★ 2026-11-21：哈希**不许挡住编译**。刚 Copy 完的 exe 常被杀软/索引器占住几秒，
    #   Get-FileHash 会抛 "being used by another process" —— 那只是备份的指纹读不到，
    #   旧 exe 本身已经复制成功。重试三次，还读不到就记一行 warning 继续。
    $bakHash = "(读不到)"
    for ($t = 0; $t -lt 3; $t++) {
        try { $bakHash = (Get-FileHash $bakExe -Algorithm SHA256).Hash; break }
        catch { Start-Sleep -Milliseconds 400 }
    }
    Write-Output ("backup-old-sha256 = " + $bakHash)
    Remove-Item $out -Force
}

$cscArgs = @(
    "/nologo", "/target:winexe", "/platform:x64", "/langversion:5", "/utf8output",
    ("/out:" + $out),
    ("/r:" + $core),
    ("/r:" + $winf),
    ("/win32icon:" + $ico),
    # ★ 2026-11-21：把 DPI 声明编进 PE。没有它，进程默认 DPI Unaware，整窗被位图拉伸。
    ("/win32manifest:" + $manifest),
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

# ★ 2026-11-21：exe.config 必须与 exe 同名同目录（CLR 按 <exe>.config 找）。
#   ★ 这里**不需要复制** —— config 源本身就叫 build\AgentSoul.exe.config，
#     与 $out + ".config" 是同一个文件。
#     （第一版写了 Copy-Item，PowerShell 报 "Cannot overwrite the item with itself"。）
#   ★ 改成断言：它在不在 exe 旁边。不在就停下 —— 少了它 WinForms 会按 96 DPI 排版。
$cfgOut = $out + ".config"
if (-not (Test-Path $cfgOut)) { throw ("缺 exe.config：" + $cfgOut + " —— 界面会偏小错位") }
Write-Output ("exe-config = " + $cfgOut)

$fi = Get-Item $out
Write-Output ("compile-ms = " + $sw.ElapsedMilliseconds)
Write-Output ("exe = " + $fi.FullName)
Write-Output ("exe-bytes = " + $fi.Length)
Write-Output ("exe-sha256 = " + (Get-FileHash $out -Algorithm SHA256).Hash)
Write-Output ("icon = " + $ico)
Write-Output ("icon-bytes = " + (Get-Item $ico).Length)
Write-Output ("icon-sha256 = " + (Get-FileHash $ico -Algorithm SHA256).Hash)
