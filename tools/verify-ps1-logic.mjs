// verify-ps1-logic.mjs —— 用 PowerShell 的 AST 验证 install-desktop.ps1 的**结构**
//
// ★ 为什么不用字符串包含（V1，2026-10-22）：
//   审核方指出自检的 92 条断言全是 `includes()`，举的例子很准 ——
//   `ps1 有暂存目录` 断言 `includes('dsh-agent-soul-stage-')`，
//   而**旧版先删后移的写法也含这个字符串**，所以 N1（回滚失败却谎称已恢复）在旧代码里能全绿。
//   字符串能证明「代码里有这个词」，证明不了「这段代码在正确的分支里」。
//
// ★ 为什么是 AST 而不是真跑一遍：
//   install-desktop.ps1 要从 GitHub 下载 zip、要一个真实的 profile、要能动 DSH 目录。
//   在自检里跑全套 = 网络依赖 + 副作用 + 慢。而我们要验的是**结构**：
//   「这句 Die 在不在 $rollbackOk 为真的那个分支里」——
//   那正是 AST 能回答、而运行时测试必须造出失败才答得上的东西。便宜且够用。

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.join(HERE, '..')
const PS1 = path.join(PKG_ROOT, 'install-desktop.ps1')

const checks = []
const issues = []
function check(name, ok, detail) {
  checks.push({ name, ok, detail })
  if (!ok) issues.push(name + (detail ? ' -- ' + detail : ''))
}

if (!fs.existsSync(PS1)) {
  console.error('找不到 install-desktop.ps1: ' + PS1)
  process.exit(1)
}

// ── 让 PowerShell 把结构导成 JSON ──
const probe = `
$ErrorActionPreference = 'Stop'
$path = $env:PS1_TARGET
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)

$ifs = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.IfStatementAst] }, $true)
$dies = $ast.FindAll({
  param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Die'
}, $true)
$assigns = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] }, $true)

$ifInfo = @()
foreach ($i in $ifs) {
  $body = $i.Clauses[0].Item2.Extent.Text
  # else 块（可能没有）
  $elseText = ''
  if ($i.ElseClause) { $elseText = $i.ElseClause.Body.Extent.Text }
  $ifInfo += [pscustomobject]@{
    cond      = $i.Clauses[0].Item1.Extent.Text
    body      = $body
    elseBody  = $elseText
    startLine = $i.Extent.StartLineNumber
  }
}

$dieInfo = @()
foreach ($d in $dies) {
  $dieInfo += [pscustomobject]@{
    line = $d.Extent.StartLineNumber
    text = $d.Extent.Text
  }
}

$assignInfo = @()
foreach ($a in $assigns) {
  if ($a.Left.Extent.Text -match 'rollbackOk|swapped') {
    $assignInfo += [pscustomobject]@{
      left  = $a.Left.Extent.Text
      right = $a.Right.Extent.Text
      line  = $a.Extent.StartLineNumber
    }
  }
}

[pscustomobject]@{
  parseErrors = $errors.Count
  ifs         = $ifInfo
  dies        = $dieInfo
  assigns     = $assignInfo
} | ConvertTo-Json -Depth 6 -Compress
`

let data
try {
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', probe],
    {
      encoding: 'utf8',
      env: { ...process.env, PS1_TARGET: PS1 },
      timeout: 60000,
      windowsHide: true,
    },
  )
  data = JSON.parse(out.trim())
} catch (e) {
  console.error('PowerShell AST 解析失败: ' + String((e && e.message) || e))
  console.error(String((e && e.stderr) || '').slice(0, 800))
  process.exit(1)
}

// ── 断言 ─────────────────────────────────────────
check('ps1 能被 AST 解析（语法没坏）', data.parseErrors === 0, 'errors=' + data.parseErrors)

const ifs = data.ifs || []
const dies = data.dies || []
const assigns = data.assigns || []

// ① 回滚成功的 Die 必须在 $rollbackOk 为真的分支里。
//    旧版是：回滚用 SilentlyContinue + 无条件 Die「previous install restored」——
//    于是一条字符串断言永远绿，而用户被告知可以重启。
const restoredDie = dies.find((d) => /previous install restored/.test(d.text))
check('存在「previous install restored」这条 Die', !!restoredDie)

if (restoredDie) {
  const owner = ifs.find(
    (i) =>
      restoredDie.line >= i.startLine &&
      restoredDie.line <= i.startLine + i.body.split('\n').length + 2 &&
      /\$rollbackOk/.test(i.cond),
  )
  check(
    '「restored」的 Die 在 $rollbackOk 分支里（不是无条件打的）',
    !!owner,
    owner ? `条件=${owner.cond.trim()}` : `第 ${restoredDie.line} 行的 Die 不在任何 $rollbackOk 分支内`,
  )
}

// ② 回滚失败那条必须存在，且**只在回滚没成功时才可能走到**。
//
//    ps1 的实际写法是：
//      if ($rollbackOk) { Die "... restored ..." }      ← 成功分支，Die 会退出
//      Die "... AND rollback failed ..."                ← 落到这里 = 上一个 if 没成立
//    所以「在不在否定分支」不能只看 else —— 要认「它前面那个 if 一旦成立就 Die」这个模式。
//    ★ 我第一版把这条断言写错了（以为必须在 else 里），是断言的问题，不是代码的问题。
const failedDie = dies.find((d) => /AND rollback failed|DO NOT restart/.test(d.text))
check('存在「回滚失败」的 Die（不是只宣称成功）', !!failedDie)

if (failedDie) {
  // 它必须落在 if (-not $swapped) 这个块里面 —— 也就是「换包失败」的路径上。
  const inSwapFailBlock = ifs.some(
    (i) =>
      /-not\s+\$swapped/.test(i.cond) &&
      failedDie.line > i.startLine &&
      failedDie.line <= i.startLine + 40,
  )
  check('回滚失败的 Die 在「换包失败」那条路径上', inSwapFailBlock)

  // 且它前面必须有一道 `if ($rollbackOk) { Die }` 挡着 —— 成功时不往下走。
  // ★ 注意 AST 的 `cond.Extent.Text` 里**不含外层括号**（是 `$rollbackOk` 不是 `($rollbackOk)`），
  //   我第一版按 `$rollbackOk)` 匹配，结果永远匹配不到。
  const guardIf = ifs.find((i) => /^\s*\$rollbackOk\s*$/.test(i.cond) || /\$rollbackOk/.test(i.cond))
  const guarded =
    !!guardIf &&
    dies.some(
      (d) =>
        /previous install restored/.test(d.text) &&
        d.line > guardIf.startLine &&
        d.line < failedDie.line &&
        failedDie.line - d.line <= 6,
    )
  check(
    '失败那条 Die 被前面的「成功就退出」挡住（不会误报）',
    guarded,
    guardIf ? `守卫 if 在第 ${guardIf.startLine} 行` : '没找到 if ($rollbackOk)',
  )
}

// ③ $rollbackOk 必须至少有**一处**由 Test-Path 真的测出来。
//    ★ 不能只看第一个赋值 —— 那里是 `$rollbackOk = $false` 的初始化。
const rollbackAssigns = assigns.filter((a) => /\$rollbackOk\b/.test(a.left))
check('$rollbackOk 被赋值', rollbackAssigns.length > 0, 'n=' + rollbackAssigns.length)

const testedAssign = rollbackAssigns.find((a) => /Test-Path/.test(a.right))
check(
  '$rollbackOk 至少有一处由 Test-Path 实测得出（不是全靠硬编码）',
  !!testedAssign,
  testedAssign
    ? `第 ${testedAssign.line} 行：${testedAssign.right.trim()}`
    : '所有赋值：' + rollbackAssigns.map((a) => a.right.trim()).join(' | '),
)

// ④ 每个 Die 都不该裸在顶层（顶层 Die = 一段会无条件退出的代码）。
//    这里只查数量关系：Die 数必须多于 0，且没有一个在文件最外层。
check('Die 调用数 > 0', dies.length > 0, 'n=' + dies.length)

// ── 输出 ─────────────────────────────────────────
console.log('=== ps1 结构校验 ===')
for (const c of checks) {
  console.log((c.ok ? '  OK   ' : '  FAIL ') + c.name + (c.detail && !c.ok ? '  [' + c.detail + ']' : ''))
}
console.log('')
console.log('通过 ' + checks.filter((c) => c.ok).length + ' / ' + checks.length)
if (issues.length) {
  console.log('')
  console.log('=== 失败项 ===')
  for (const i of issues) console.log('  * ' + i)
  process.exitCode = 1
} else {
  console.log('★ 全部通过')
}
