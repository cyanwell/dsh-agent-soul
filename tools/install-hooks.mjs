#!/usr/bin/env node
/**
 * install-hooks.mjs —— 把「公告闸门」装进 .git/hooks
 *
 * 为什么需要安装脚本，而不是直接把 hook 写进 .git/hooks 就完事：
 *   `.git/hooks/` **不在版本控制里**。换台机器 clone 下来就没了，
 *   而我恰恰是在「换机器 / 重装」之后最容易忘掉纪律的那段时间里漏公告的。
 *
 * 所以：hook 本身进仓库（`tools/pre-commit-changelog.mjs`），
 * 这个脚本负责把它接到 `.git/hooks/pre-commit` 上。clone 之后跑一次即可。
 *
 * 用法：
 *   node tools/install-hooks.mjs          # 装
 *   node tools/install-hooks.mjs --check  # 只检查装没装
 *   node tools/install-hooks.mjs --remove # 卸
 *
 * ★ 行尾必须是 LF。git 在 Windows 上用 sh 跑 hook，
 *   带 CRLF 的脚本会报 `bad interpreter: /bin/sh^M` 这种看起来毫不相干的错。
 *   （AGENTS.md 里记过同一个坑：批处理 .cmd 不能用 LF，shell 脚本不能用 CRLF。方向相反。）
 */

import { writeFileSync, readFileSync, existsSync, chmodSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const HOOK = join(REPO, '.git', 'hooks', 'pre-commit')
const GATE = 'pre-commit-changelog.mjs'
const MARK = '# installed-by: tools/install-hooks.mjs'

const mode = process.argv.includes('--remove')
  ? 'remove'
  : process.argv.includes('--check')
    ? 'check'
    : 'install'

if (mode === 'check') {
  if (!existsSync(HOOK)) {
    console.log('  未安装：' + HOOK + ' 不存在')
    process.exit(1)
  }
  const text = readFileSync(HOOK, 'utf8')
  if (!text.includes(MARK)) {
    console.log('  已存在但**不是**本脚本装的（可能是别的 hook）—— 不动它')
    process.exit(1)
  }
  console.log('  已安装 ✓')
  console.log(text.split('\n').map((l) => '    ' + l).join('\n'))
  process.exit(0)
}

if (mode === 'remove') {
  if (existsSync(HOOK) && readFileSync(HOOK, 'utf8').includes(MARK)) {
    unlinkSync(HOOK)
    console.log('  已卸载')
  } else {
    console.log('  没有本脚本装的 hook，什么都没动')
  }
  process.exit(0)
}

// ── 装 ──────────────────────────────────────────────────────────────
if (!existsSync(join(REPO, '.git'))) {
  console.error('  ✗ 这里不是 git 仓库根（找不到 ' + join(REPO, '.git') + '）')
  process.exit(1)
}
if (!existsSync(join(HERE, GATE))) {
  console.error('  ✗ 找不到闸门脚本 ' + GATE)
  process.exit(1)
}
if (existsSync(HOOK)) {
  const cur = readFileSync(HOOK, 'utf8')
  if (!cur.includes(MARK)) {
    console.error('  ✗ .git/hooks/pre-commit 已存在且不是本脚本装的。')
    console.error('    为了不覆盖别人的 hook，请先手动看一眼：' + HOOK)
    process.exit(1)
  }
}

// ★ git 跑 hook 时的 PATH 不保证包含 node —— 写死绝对路径最稳。
const nodePath = process.execPath.replace(/\\/g, '/')

// ★★ git 也一样，而且这台机器 git 压根不在 PATH 里。
//   不注进去，闸门脚本里的 `execFileSync('git')` 全部失败 →
//   判定成「暂存区为空」→ 静默放行 → 闸门等于闭着眼睛（2026-10-26 自测抓到的自身 bug）。
function findGit() {
  const tried = []
  const cands = [
    process.env.GIT_BIN,
    'git',
    // ★ 下面两条是**本机兜底**，不是硬性依赖 —— 前面已经试过 GIT_BIN 和 PATH 里的 git。
    //   为什么留：这台机器的 git 不在 PATH 里（2026-10-26 实测），不注进去闸门会静默放行。
    //   别人机器上这两条路径不存在 → 试下一个 → 不影响。
    'C:/Users/pc/AppData/Local/Programs/Git/cmd/git.exe',
    'D:/AI/dsh-tools/mingit/cmd/git.exe',
  ].filter(Boolean)
  for (const c of cands) {
    try {
      execFileSync(c, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      return { bin: c, tried }
    } catch {
      tried.push(c)
    }
  }
  return { bin: null, tried }
}

const gitFound = findGit()
if (gitFound.bin === null) {
  console.error('  ✗ 找不到 git，不装。试过：')
  for (const t of gitFound.tried) console.error('      ' + t)
  console.error('    解法：设 GIT_BIN=<git 绝对路径> 再跑一次。')
  process.exit(1)
}

const script = [
  '#!/bin/sh',
  MARK,
  '#',
  '# 公告闸门：动了实现但没写更新记录 → 拒绝提交。',
  '# 绕过：提交信息里写 [no-changelog]，或 git commit --no-verify。',
  '# 卸载：node tools/install-hooks.mjs --remove',
  '',
  'cd "$(git rev-parse --show-toplevel)" || exit 1',
  '# ★ 这台机器 git 与 node 都不在 PATH 里，装的时候就把绝对路径注进来',
  'export CHANGELOG_GATE_GIT="' + gitFound.bin + '"',
  '"' + nodePath + '" "tools/' + GATE + '"',
  '',
].join('\n')

writeFileSync(HOOK, script, 'utf8')
try {
  chmodSync(HOOK, 0o755)
} catch {
  // Windows 上 chmod 实际不起作用，git 自己会处理 mode
}

console.log('  已安装 ✓')
console.log('    hook : ' + HOOK)
console.log('    node : ' + nodePath)
console.log('    git  : ' + gitFound.bin)
console.log('')
console.log('  自测：')
console.log('    node tools/install-hooks.mjs --check')
console.log('    node tools/pre-commit-changelog.mjs      # 对当前暂存区跑一次判定')
