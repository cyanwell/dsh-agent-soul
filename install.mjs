#!/usr/bin/env node
/**
 * install.mjs —— 安装层入口（doctor 之上的一层）
 *
 * 它是什么
 * --------
 * 这个脚本**不重新实现任何业务逻辑**。它只做三件编排：
 *
 *   doctor    转调 soul-doctor.mjs，把三层结论翻译成「现在该做什么」
 *   apply     按 doctor 的结论去改 —— 目前只覆盖 L2 装配
 *   update    git pull + apply
 *   rollback  从最近的 .bak 恢复
 *
 * 为什么 apply 要先过 doctor 的 L0/L1
 * ------------------------------------
 * L0 是地基（DSH 装没装对、profile 在哪、配置能不能解析）。
 * **地基错了还去改配置，只会把环境搞得更乱，而且会掩盖真正的问题。**
 *
 * ★ L2 不在这个门槛里 —— 因为 apply 正是修 L2 的工具。
 *   要求「L2 全绿才允许修 L2」是循环依赖。
 *
 * 边界（诚实）
 * ------------
 * - **装不了零件包**：那四个 dsh-agent-* 从哪来，取决于发行方式，本机是别人装的。
 *   apply 只负责「preset 那一层」。L1 不过时它会拒绝并说清楚。
 * - **update 只是 git pull**：它不知道你怎么拿到这个仓库的（clone / 下载 / fork）。
 *
 * 用法
 * ----
 *   node install.mjs doctor [--json] [--profile desktop]
 *   node install.mjs apply  [--write] [--profile desktop]
 *   node install.mjs update [--write]
 *   node install.mjs rollback [--to <bak路径>]
 *
 * 铁律
 * ----
 * 1. **默认 dry-run。** 除 rollback（它本身就是恢复动作）外，都要显式 --write 才动手
 * 2. **写前备份**：交给 soul-preset.mjs，它已经会备份（bak-before-*）
 * 3. **不猜**：不知道的就报「不知道」，不拿默认值顶
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))   // ★ 本文件在仓库根，所以 HERE 就是根
const ROOT = HERE
const TOOLS = join(HERE, 'tools')                       // ★ 两个子脚本都在 tools/ 下
const NODE = process.execPath
const CMD = process.argv[2] || 'doctor'
const argOf = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null }
const WRITE = process.argv.includes('--write')
// ★ 不猜 home 在哪（AGENTS 里的铁律：不知道就报，不拿默认值顶）。
//   原来这里兜底成 'D:/AI/dsh/home' —— 那是本机路径。别人机器上会去读一个
//   不存在的目录，于是 doctor 报「全是红的」，而真实原因只是工具指错了地方。
//   ★ 这种错不是崩溃，是「报出假的缺失」—— 比崩溃更难查。
const HOME = process.env.DSH_HOME || argOf('--home')
if (!HOME) {
  console.error('\n\u2717 \u627e\u4e0d\u5230 DSH home\u3002\u8bf7\u4e8c\u9009\u4e00\uff1a\n' +
    '  1) export DSH_HOME=<\u4f60\u7684 dsh home \u8def\u5f84>\n' +
    '  2) \u52a0\u53c2\u6570 --home <\u8def\u5f84>\n' +
    '  \uff08\u4e0d\u731c\uff0c\u662f\u56e0\u4e3a\u731c\u9519\u4f1a\u62a5\u51fa\u5047\u7684\u7f3a\u5931\uff09\n')
  process.exit(2)
}
const PROFILE = argOf('--profile') || 'desktop'
const profileDir = join(HOME, 'profiles', PROFILE)

const say = (m = '') => console.log(m)
const die = (m) => { console.error(`\n✗ ${m}`); process.exit(2) }

function run(file, args, opts = {}) {
  const r = spawnSync(NODE, [file, ...args], { encoding: 'utf8', ...opts })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

/** 跑 doctor，拿结构化结果 */
function doctor() {
  const r = run(join(TOOLS, 'soul-doctor.mjs'), ['--json', '--profile', PROFILE])
  try { return JSON.parse(r.out) } catch { die(`doctor 输出不是 JSON：\n${r.out}`) }
}

// ═══════════════════════════════════════════════════════════════
if (CMD === 'doctor') {
  // 直接转调，不重复实现
  const args = [join(TOOLS, 'soul-doctor.mjs')]
  if (process.argv.includes('--json')) args.push('--json')
  args.push('--profile', PROFILE)
  const r = spawnSync(NODE, args, { stdio: 'inherit' })
  process.exit(r.status ?? 1)
}

// ═══════════════════════════════════════════════════════════════
if (CMD === 'apply') {
  say(`\napply · profile = ${PROFILE}`)
  say(WRITE ? '模式：真的写' : '模式：dry-run（加 --write 才动手）')

  const d = doctor()
  const fatal = d.failed.filter((f) => f.startsWith('L0/') || f.startsWith('L1/'))

  if (fatal.length) {
    say(`\n✗ L0/L1 有 ${fatal.length} 项不过 —— 不动手。`)
    say('  地基或零件有问题时改配置，只会把环境搞得更乱：')
    for (const f of fatal) say(`    · ${f}`)
    say('\n  先按 AGENT-INSTALL.md 对应章节修掉它们。')
    process.exit(1)
  }
  say('\n✅ L0 / L1 全过，可以修 L2')

  // L2 里 apply 能修的有哪些 —— 这里只做「装 preset」，其余给出人工指引
  const l2 = d.layers?.L2?.checks || []
  const fixable = new Set(['presets', 'threeparts', 'presetresolve'])
  const todo = l2.filter((c) => !c.ok)
  const auto = todo.filter((c) => fixable.has(c.id))
  const manual = todo.filter((c) => !fixable.has(c.id))

  if (!auto.length && !manual.length) { say('\n✅ L2 也没有要修的 —— 不用 apply。'); process.exit(0) }

  if (auto.length) {
    say(`\n将执行（soul-preset build）：${auto.map((c) => c.id).join(', ')}`)
    if (WRITE) {
      const r = run(join(TOOLS, 'soul-preset.mjs'), ['build', '--profile', PROFILE, '--write'])
      say(r.out.trim())
      if (r.code !== 0) die('build 失败，看上面输出')
    } else {
      const r = run(join(TOOLS, 'soul-preset.mjs'), ['build', '--profile', PROFILE])
      say(r.out.trim())
      say('\n（dry-run，没有写盘。确认没问题后加 --write）')
    }
  }

  if (manual.length) {
    say(`\n${WRITE ? '' : '\n'}需要人工处理（apply 不碰这些）：`)
    for (const c of manual) {
      say(`  · ${c.id}：${c.detail}`)
      if (c.hint) say(`    → ${c.hint}`)
    }
  }

  if (WRITE) {
    say('\n★ 写完请重启 DSH —— profile 配置只在启动时读一次，host 不热加载。')
    say('  重启后验：新建会话界面切 preset，敲 /compact-region，能被识别就算成。')
  }
  process.exit(0)
}

// ═══════════════════════════════════════════════════════════════
if (CMD === 'update') {
  say('\nupdate · git pull + apply')
  const git = process.env.GIT_EXE || 'git'
  const g = spawnSync(git, ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' })
  if (g.status !== 0) die(`这里不是 git 仓库，或者找不到 git（${git}）。\n  设 GIT_EXE 指向 git.exe，或手动下载新版覆盖。`)

  const before = (g.stdout || '').trim()
  say(`当前 HEAD：${before}`)

  const pull = spawnSync(git, ['-C', ROOT, 'pull', '--ff-only'], { encoding: 'utf8' })
  say(((pull.stdout || '') + (pull.stderr || '')).trim() || '（pull 无输出）')
  if (pull.status !== 0) die('git pull 失败 —— 可能有本地改动。先 git status 看清楚。')

  const after = (spawnSync(git, ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout || '').trim()
  say(before === after ? '\n已经是最新的。' : `\n已更新：${before} → ${after}`)

  // 更新完顺手 apply（默认 dry-run）
  const r = spawnSync(NODE, [join(HERE, 'install.mjs'), 'apply', '--profile', PROFILE, ...(WRITE ? ['--write'] : [])], { stdio: 'inherit' })
  process.exit(r.status ?? 0)
}

// ═══════════════════════════════════════════════════════════════
if (CMD === 'rollback') {
  say('\nrollback · 从备份恢复')
  const target = argOf('--to')
  const baks = existsSync(profileDir)
    ? readdirSync(profileDir).filter((f) => /\.bak-/.test(f)).sort()
    : []
  if (!baks.length) die(`profile 目录里没有 .bak-* 备份：${profileDir}`)

  if (!target) {
    say(`\n可用的备份（按名字排序，最后一个是最近的）：`)
    for (const b of baks) say(`  · ${b}`)
    say(`\n用法：node install.mjs rollback --to "<上面某一个>"`)
    say('★ 不指定就不动手 —— 恢复错的文件比不恢复更坏。')
    process.exit(0)
  }
  if (!baks.includes(target)) die(`"${target}" 不在备份列表里。先不加 --to 看有哪些。`)
  if (!/^(cordis\.patch\.yml|package\.json)\.bak-/.test(target)) die('只允许恢复 cordis.patch.yml / package.json 的备份')

  // 恢复前先把当前状态也备份一份 —— 否则「恢复」变成「单向丢失」
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const orig = target.replace(/\.bak-.*$/, '')
  const { copyFileSync } = await import('node:fs')
  const safety = `${orig}.bak-before-rollback-${stamp}`
  copyFileSync(join(profileDir, orig), join(profileDir, safety))
  copyFileSync(join(profileDir, target), join(profileDir, orig))
  say(`\n✅ 已恢复 ${target} → ${orig}`)
  say(`   （当前状态另存为 ${safety}，反悔时还能换回来）`)
  say('\n★ 重启 DSH 才生效。')
  process.exit(0)
}

die(`不认识的命令 "${CMD}"。可用：doctor / apply / update / rollback`)
