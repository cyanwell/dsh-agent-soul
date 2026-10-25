#!/usr/bin/env node
/**
 * soul-one-shot.mjs —— 「装完了，它到底在跑吗？」
 * ================================================
 *
 * ★ 为什么要有这个（而不是让人去读 verify-live 的 62 行明细）
 * ------------------------------------------------------------
 * 2026-10-24 一整天的用户反馈，最扎人的一句是：
 *
 *   「插件安装好了，但根本不知道有没有在运行，设置面板有没有拉起来。」
 *
 * verify-live.mjs 回答的是**审计**问题（逐项 ①-⑤，62 行）。
 * 而人装完只想知道一件事：**哪些在跑，哪些没跑，没跑的怎么修。**
 *
 * 所以这个脚本只做三件事：
 *   ① 每个零件一行：✓ 在跑 / ✗ 没跑 / ! 装了但可能没接管
 *   ② 末尾列出「要修的有 N 项」，每项给**能直接照做**的步骤
 *   ③ 退出码：0 = 全绿；1 = 有没跑的；2 = 用法错
 *
 * ★ 它**只读**，不改任何东西。
 *
 * ★ 用法
 * ------
 *   node tools/soul-one-shot.mjs --profile <profile 目录>
 *   node tools/soul-one-shot.mjs --profile D:/AI/dsh/home/profiles/desktop
 *
 * ★ 它**查不到**什么（说清楚，免得当成万能）
 * ------------------------------------------
 *  · 不查「兜底压缩到底用没用我们的类」—— 那要 tools/soul-probe，真跑一次才知
 *  · 不查「pruner 真的裁过没有」—— 那要一次真实裁剪，看 marker 带不带 seq
 *  · 不查「界面真的渲染了」—— 那要开浏览器看。这里只能查「面板注册声明在不在」
 */

import { readFile, access, readdir } from 'node:fs/promises'
import { join, resolve, dirname, basename } from 'node:path'

const BT = '`'
const args = process.argv.slice(2)
const pIdx = args.indexOf('--profile')
const profileArg = pIdx >= 0 ? args[pIdx + 1] : null
if (!profileArg) {
  console.error('用法: node tools/soul-one-shot.mjs --profile <profile 目录>')
  process.exit(2)
}
const profile = resolve(profileArg)

async function exists(p) {
  try { await access(p); return true } catch { return false }
}
async function readJson(p) {
  try { return JSON.parse(await readFile(p, 'utf8')) } catch { return null }
}

// ── 14 个零件的清单：id / 显示名 / 是包还是替换件 ──────────────────────
// `replace: true` 的两个（compaction / pruner）在桌面端是**替换**官方实现，
// 判据不是「在 bundles 里」，而是「preset 里有没有把 name 换成我们的」。
const PARTS = [
  { pkg: 'dsh-agent-riji',            label: '日记 riji',          dir: 'riji' },
  { pkg: 'dsh-agent-clock',           label: '时钟 clock',          dir: 'clock' },
  { pkg: 'dsh-agent-model-statusbar', label: '状态栏 model-statusbar', dir: 'model-statusbar' },
  { pkg: 'dsh-agent-mobile-adapt',    label: '移动适配 mobile-adapt', dir: 'mobile-adapt' },
  { pkg: 'dsh-agent-splash',          label: '启动 splash',         dir: 'splash' },
  { pkg: 'dsh-agent-yantai',          label: '砚台 yantai',         dir: 'yantai' },
  { pkg: 'dsh-agent-echo',      label: '回声 echo',           dir: 'echo' },
  { pkg: 'dsh-huanqi',          label: '换气 huanqi',         dir: 'huanqi' },
  { pkg: 'dsh-agent-huanqi-panel', label: '换气面板 huanqi-panel', dir: 'huanqi-panel' },
  { pkg: 'dsh-agent-memory',    label: '热记忆 memory',       dir: 'memory' },
  { pkg: 'dsh-agent-mnemon-probe',    label: 'mnemon 探针',         dir: 'mnemon-probe' },
  { pkg: 'dsh-agent-compaction', label: '兜底压缩 compaction', dir: 'compaction', replace: true },
  { pkg: 'dsh-agent-pruner',    label: '工具结果裁剪 pruner',  dir: 'pruner',    replace: true },
  { pkg: 'dsh-agent-tools',     label: '工具集 tools',         dir: 'tools' },
]

console.log('')
console.log('  agent-soul 自诊 · 装完了它到底在跑吗')
console.log('  ' + '─'.repeat(58))
console.log('  profile : ' + profile)
console.log('')

// ── 0. profile 本身在不在 ───────────────────────────────────────────
const pkgJsonPath = join(profile, 'package.json')
const pkgJson = await readJson(pkgJsonPath)
if (!pkgJson) {
  console.log('  ✗ 这个目录下没有能读的 package.json —— profile 路径对吗？')
  console.log('    期望: <profile>/package.json')
  console.log('')
  process.exit(1)
}

const bundles = (pkgJson?.dsh?.profile?.bundles ?? []).filter(x => typeof x === 'string')
const deps = pkgJson?.dependencies ?? {}
const isDesktop = Array.isArray(bundles) && bundles.some(b => /dsh-web-app/.test(b)) === false

// ── 1. 本体包 ──────────────────────────────────────────────────────
const soulDir = join(profile, 'node_modules', 'dsh-agent-soul')
const soulPkg = await readJson(join(soulDir, 'package.json'))
const soulVer = soulPkg?.version ?? null

console.log('  本体包      ' + (soulPkg
  ? '✓ 已装' + (soulVer ? '（v' + soulVer + '）' : '')
  : '✗ 没找到（' + soulDir + '）'))

// ── 2. 逐零件判「在跑没有」 ─────────────────────────────────────────
// 一条零件「算在跑」要同时满足：
//   a) node_modules 里能解析到这个包（或包名映射到我们的目录）
//   b) 它在 dsh.profile.bundles 里（否则宿主根本不加载它）
// replace 件额外要求 c) preset 里把官方 name 换成了我们的
const rows = []
for (const part of PARTS) {
  const inBundles = [...new Set([part.pkg, 'dsh-' + part.dir, 'dsh-agent-' + part.dir, 'dsh-yanqing-' + part.dir])].some((n) => bundles.includes(n))
  const inDeps = [...new Set([part.pkg, 'dsh-' + part.dir, 'dsh-agent-' + part.dir, 'dsh-yanqing-' + part.dir])].some((n) => Object.prototype.hasOwnProperty.call(deps, n))
  // 包目录：先按包名找，再按「dsh-agent-X」实际落在 node_modules 下的名字找
  const candidates = [
    join(profile, 'node_modules', part.pkg),
    join(profile, 'node_modules', part.pkg.replace(/^@[^/]+\//, '')),
  ]
  let installed = false
  for (const c of candidates) { if (await exists(c)) { installed = true; break } }

  rows.push({ part, installed, inBundles, inDeps })
}

// ── 3. preset 里 compaction / pruner 换没换 name ────────────────────
// 桌面端必须走这条路（profile bundles 的 insert 解析不到 @deepseek-ai/*）
let presetInfo = { checked: false, files: [], compactionName: null, prunerName: null }
try {
  const presetRoot = join(dirname(profile), '..', '.agent-presets')
  if (await exists(presetRoot)) {
    const names = await readdir(presetRoot)
    for (const n of names) {
      const yml = join(presetRoot, n, 'agent.cordis.yml')
      if (!(await exists(yml))) continue
      const txt = await readFile(yml, 'utf8')
      presetInfo.checked = true
      presetInfo.files.push(yml)
      // 只找「id 是 compaction-basic / tool-result-pruner，紧跟的 name 是什么」
      const mC = txt.match(/id:\s*compaction-basic[\s\S]{0,400}?name:\s*['"]?([\w@/.-]+)/)
      const mP = txt.match(/id:\s*tool-result-pruner[\s\S]{0,400}?name:\s*['"]?([\w@/.-]+)/)
      if (mC) presetInfo.compactionName = mC[1]
      if (mP) presetInfo.prunerName = mP[1]
    }
  }
} catch { /* 没有 preset 目录就跳过 */ }

console.log('  ' + '─'.repeat(58))

let bad = 0
let warn = 0
for (const r of rows) {
  const { part, installed, inBundles } = r
  let mark, note

  if (part.replace) {
    // 替换件的判据完全不同
    const ourName = part.pkg
    const byPreset = (part.dir === 'compaction')
      ? (presetInfo.compactionName === ourName)
      : (presetInfo.prunerName === ourName)
    if (byPreset) {
      mark = '✓'; note = '已接管（preset 路 B）'
    } else if (!presetInfo.checked) {
      mark = '✗'; note = '没接管 —— 找不到 preset 目录'; bad++
    } else {
      mark = '✗'
      note = '没接管 —— preset 里 name 还是 ' +
        (part.dir === 'compaction' ? (presetInfo.compactionName ?? '（没找到这一项）')
                                   : (presetInfo.prunerName ?? '（没找到这一项）'))
      bad++
    }
  } else if (inBundles) {
    mark = '✓'; note = '在 bundles 里（宿主会加载）'
  } else if (installed || r.inDeps) {
    mark = '!'; note = '装了但**不在 bundles** —— 宿主不会加载它'; warn++
  } else {
    mark = '✗'; note = '没装'; bad++
  }

  const pad = part.label.padEnd(24, ' ')
  console.log('  ' + mark + ' ' + pad + note)
}

console.log('  ' + '─'.repeat(58))

// ── 4. 结论 + 怎么修 ───────────────────────────────────────────────
if (bad === 0 && warn === 0) {
  console.log('  ✓ 全部就位。')
  console.log('')
  console.log('  还想再确认深一点（可选）：')
  console.log('    压缩到底用没用我们的类 → node tools/soul-probe（要看 [result] 里的 ctor）')
  console.log('    裁剪到底生没生效     → 跑一次 >8192 字符的工具输出，看被挖掉那块带不带 seq')
  console.log('')
  process.exit(0)
}

console.log('  要修的有 ' + bad + ' 项没跑' + (warn ? '、' + warn + ' 项装了没加载' : '') + '。')
console.log('')

const needPreset = rows.some(r => r.part.replace && bad > 0 &&
  !((r.part.dir === 'compaction') ? presetInfo.compactionName === r.part.pkg
                                  : presetInfo.prunerName === r.part.pkg))
if (needPreset) {
  console.log('  ① 压缩 / 裁剪没接管（桌面端只能走 preset，不能走 profile insert）')
  console.log('     ★ 别在 profile 里装 —— 会报 ' + BT + 'Cannot find package @deepseek-ai/...' + BT)
  console.log('     打开你正在用的那个 preset 的 agent.cordis.yml，在 compaction 那个组**内部**改：')
  console.log('')
  console.log('       - id: compaction-basic          # ← id 保持不变')
  console.log("         name: 'dsh-agent-compaction'  # ← 只换 name")
  console.log('       - id: tool-result-pruner')
  console.log("         name: 'dsh-agent-pruner'")
  console.log('')
  console.log('     为什么行：id 已存在 ⇒ 是**替换**不是新增，不触发「先到先得」；')
  console.log('     而且包跑在宿主进程同一个 realm 里，@deepseek-ai/* 解析得到。')
  console.log('     改完重启 DSH，再跑一次本命令，那两行该变成 ✓。')
  console.log('')
}

const notInBundles = rows.filter(r => !r.part.replace && !r.inBundles && (r.installed || r.inDeps))
if (notInBundles.length) {
  console.log('  ② 这些装了但不在 bundles（宿主不会加载）：')
  for (const r of notInBundles) console.log('       · ' + r.part.pkg)
  console.log('     修法（桌面端不能用 dsh plugin add，宿主会拒）：')
  console.log('       node tools/add-bundle.cjs "' + join(profile, 'package.json') + '" <包名>')
  console.log('')
}

const notInstalled = rows.filter(r => !r.part.replace && !r.installed && !r.inDeps)
if (notInstalled.length) {
  console.log('  ③ 这些还没装：')
  for (const r of notInstalled) console.log('       · ' + r.part.pkg)
  console.log('     修法：按 INSTALL.md 的第 2 步逐个装（web profile 用 dsh plugin add，桌面端用 add-bundle）')
  console.log('')
}

// ── ④ huanqi 的 @deepseek-ai/schemastery（只报，不自动修）────────────
// ★ 2026-10-24 查清的事实，纠一个我差点做错的方案：
//   huanqi 的 dependencies 写的是 `@deepseek-ai/schemastery`（**带官方 scope**），
//   而 profile 的 node_modules 里常见的是 `schemastery`（**不带 scope**，npm 原名）。
//   **两者不是同一个包名** —— 把后者复制或改名过去，并不等于满足前者。
//   所以这里只报「有没有那个带 scope 的」，不做任何自动复制。
try {
  const wantScoped = join(profile, 'node_modules', '@deepseek-ai', 'schemastery')
  const plainName = join(profile, 'node_modules', 'schemastery')
  if (!(await exists(wantScoped))) {
    console.log('  ⚠ huanqi 依赖的 ' + BT + '@deepseek-ai/schemastery' + BT + ' 在 profile 里没有。')
    if (await exists(plainName)) {
      console.log('     node_modules 里有 ' + BT + 'schemastery' + BT + '（**没 scope**）—— 那不是同一个包名，')
      console.log('     复制过去也不会被解析到。别这么补。')
    }
    console.log('     通常不用管：huanqi 作为 bundle 由宿主加载时，宿主能解析到 app.asar 里那份。')
    console.log('     只有确认 huanqi 报 ' + BT + 'Cannot find package' + BT + ' 时才要处理。')
    console.log('')
  }
} catch { /* 查不了就跳过 */ }

// ── ⑤ --fix：只做确定安全的那一件（add-bundle）────────────────────
// ★ 为什么不顺手把 preset 也改了：改用户的启动配置，改坏会 sanitizeProfile 重置 bundles，
//   比不装更糟。那一步**只给教程，不自动做**（2026-10-24 定）。
if (args.includes('--fix')) {
  console.log('  ── --fix ────────────────────────────────────────────────')
  const toAdd = rows.filter(r => !r.part.replace && !r.inBundles && (r.installed || r.inDeps))
  if (!toAdd.length) {
    console.log('    没有需要进 bundles 的零件（都已在，或都还没装）。')
    console.log('')
  } else {
    // ★ 路径从 import.meta.url 现算，不引入新常量。
    const { fileURLToPath } = await import('node:url')
    const addScript = fileURLToPath(new URL('./add-bundle.cjs', import.meta.url))
    if (!(await exists(addScript))) {
      console.log('    ✗ 找不到 tools/add-bundle.cjs —— 跳过（不猜怎么写 package.json）')
      console.log('')
    } else {
      const { spawnSync } = await import('node:child_process')
      const pkgPath = join(profile, 'package.json')
      for (const r of toAdd) {
        // ★ 第三个参数（depValue）**故意不传**：
        //   file: 后面该写什么取决于包被拷到哪，这个脚本不知道，猜错更糟。
        const res = spawnSync(process.execPath, [addScript, pkgPath, r.part.pkg], { encoding: 'utf8' })
        const out = (res.stdout || '').trim()
        const errFirst = (res.stderr || '').trim().split('\n')[0]
        if (res.status === 0) {
          console.log('    ✓ ' + r.part.pkg + '  → ' + (out || 'ok'))
        } else {
          console.log('    ✗ ' + r.part.pkg + '  → 退出码 ' + res.status + (errFirst ? '：' + errFirst : ''))
        }
      }
      console.log('')
      console.log('    ★ 只写了 dsh.profile.bundles，**没动 dependencies** ——')
      console.log('      这是故意的：file: 后面该写什么取决于包被拷到哪，猜错会把 pnpm 引到错误路径。')
      console.log('      如果安装方式是把文件拷进 node_modules（桌面脚本就是），')
      console.log('      再自己补一条  "依赖名": "file:node_modules/<目录名>"  更稳。')
      console.log('    ★ 重启 DSH 后再跑一次本命令（不带 --fix），那几行应变 ✓。')
      console.log('')
    }
  }
}

process.exit(1)
