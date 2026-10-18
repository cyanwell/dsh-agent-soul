# 装完之后：让 compaction / pruner 真正接管

> 这一页回答一个问题：**为什么我装了压缩插件，兜底压缩还是内置那套？**

## 一句话

**cordis 的服务注册是先到先得。** 谁先注册 compaction 这个名字，谁就占住它；
后来的同名 Service **不报错、不警告，就是静默不生效**。

实测（
ode tools/probe-service-order.mjs）：

    Builtin → Mine     ⇒ ctx.compaction.who() === "builtin"   ← 先注册的赢
    Mine → Builtin     ⇒ ctx.compaction.who() === "mine"      ← 先注册的赢

## 所以怎么装才对

**必须让本包排在 @deepseek-ai/dsh-base 之前。**

dsh plugin add 是往 undles 末尾追加的，所以装完要手动调一次顺序：

`powershell
$p = "<profile 目录>\package.json"
$pj = Get-Content $p -Raw -Encoding UTF8 | ConvertFrom-Json
$cur = @($pj.dsh.profile.bundles)
$move = @("dsh-agent-compaction", "dsh-agent-pruner")
$rest = $cur | Where-Object { $move -notcontains $_ }
$pj.dsh.profile.bundles = @() + ($move | Where-Object { $cur -contains $_ }) + $rest
($pj | ConvertTo-Json -Depth 20) | Set-Content $p -Encoding UTF8
`

然后重启，--dump-config 里应该看到：

`
- id: dsh-agent-compaction
- id: dsh-agent-pruner
- id: compaction-basic        ← 内置的排到后面去了
- id: tool-result-pruner
`

★ **DSH 尊重手写的 bundles 顺序**（2026-10-18 实测，--dump-config 原样保留）。

## 那 patch 是干什么的

cordis.patch.yml 让本包**被加载**（dsh.bundle.patch 指对了、包能 import）。
它**管不了**谁占住服务名 —— 那是层栈顺序的事。

★ 两个是分工，不是二选一：
  · dsh.bundle.patch → **能不能被加载**
  · profile 的 undles 顺序 → **加载之后谁生效**

## 还没验的一步

顺序对了、服务起来了、页面也在 —— 但**还没跑过一次真实压缩**。
终极判据仍然是那条：**跑一次兜底压缩，看 checkpoint 前面有没有 log:<会话>#seq=<n> 指针块。**

    · 有   → 全链路通了，可以写进「已验证」
    · 没有 → 顺序这个解释也不对，得回头看 summarize 到底有没有被调到
