# build-aux.ps1 —— 除了壳（AgentSoul.exe）之外，本项目用 csc 编的**辅助 exe**
#
# 为什么单独一个脚本：这些 exe 不是每次发版都变，但它们**必须能被任何人重编**。
# 2026-11-21 之前的实际情况是：SecretStore.exe 部署在 runtime/ 里，而它的源码
# （原来在 build/pack/SecretStore.cs）那条打包流水线已经退役 —— 于是 clone 下来的人
# 根本编不出它，只能拷现成的二进制。那是「能跑但不可重建」，比没有更危险。
#
# 用法： powershell -NoProfile -ExecutionPolicy Bypass -File build\build-aux.ps1
#
# ★ 编译约束与 build.ps1 相同：/langversion:5，禁插值字符串 / ?. / nameof / 表达式体 / out var。

$ErrorActionPreference = "Stop"
$build = "D:\AI\agent-soul\build"
$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { throw ("找不到 csc：" + $csc) }

function Build-One([string]$name, [string]$outName, [string[]]$refs) {
    $src = Join-Path $build ($name + ".cs")
    if (-not (Test-Path $src)) { throw ("缺源码：" + $src) }
    $out = Join-Path $build $outName
    $args = @("/nologo", "/target:exe", "/platform:x64", "/langversion:5", "/utf8output", ("/out:" + $out))
    foreach ($r in $refs) { $args += ("/r:" + $r) }
    $args += $src
    & $csc $args
    if ($LASTEXITCODE -ne 0) { throw ("csc 失败：" + $name + " exit=" + $LASTEXITCODE) }
    $fi = Get-Item $out
    # ★ 必须用 Write-Host：Write-Output 会被调用方的 `$ss = Build-One ...` 捕获成返回值，
    #   于是这些"编好了，多大，哈希多少"的行**永远不会出现在控制台上**（第一次跑就是这样）。
    Write-Host ("  {0,-20} {1,10} B  sha256={2}" -f $outName, $fi.Length, (Get-FileHash $out -Algorithm SHA256).Hash.Substring(0,16))
    return $out
}

Write-Output "编译辅助 exe（$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')）"

# ── SecretStore.exe —— 唯一读 DPAPI 秘密的组件 ───────────────────────────
# ★ 为什么它必须是独立 exe 而不是 core 的一个函数：apiKeyRef 是 dpapi: 密文，
#   只有「以当前用户身份」起的进程解得开；core 由壳拉起，壳本身不碰秘密。
#   它必须与安装根同处 runtime/，core 按 <安装根>/runtime/SecretStore.exe 找它。
Build-One "SecretStore" "SecretStore.exe" @("System.dll") | Out-Null

# ── setup-stub.exe —— 安装器的无载荷版本（make-dist 再拼载荷上去）──────
Build-One "Setup" "setup-stub.exe" @(
    "System.dll", "System.Drawing.dll", "System.Windows.Forms.dll",
    "System.IO.Compression.dll", "System.IO.Compression.FileSystem.dll"
)

Write-Output ""
Write-Output "完成。"
Write-Output "  SecretStore.exe → 复制到安装根的 runtime\（make-dist 会做）"
Write-Output "  setup-stub.exe  → make-dist 会拼 MAGIC + zip 生成 AgentSoul-Setup-<ver>.exe"
