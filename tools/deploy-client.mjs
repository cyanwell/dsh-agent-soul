#!/usr/bin/env node
/**
 * deploy-client.mjs —— 把一个包的 client.js 部署到 profile，**部署完立刻验 id**
 *
 * 为什么有这个脚本
 * ----------------
 * 2026-11-01：我把 `dsh-agent-soul/plugins/echo/client.js`（发布版，id 是 `dsh-agent-echo`）
 * 用 `cp` 覆盖进 `node_modules/dsh-yanqing-echo/`（本机部署包，entry 名是 `dsh-yanqing-echo`）。
 *
 * 两个包名字不同 —— 那不是「同一个包的两份副本」，是**两个不同的包**。
 * 一个 cp 就把 `load({ id })` 带成了错的值，而 client-modules 拿 entry 名去查注册表，
 * 查不到 → 整批 web boot 不激活 → 桌面端弹「应用无法启动」，**全界面进不去**。
 *
 * 更难看的是：`tools/verify-client-ids.mjs` 10-26 就写好了，能查出这个问题。
 * 但**没有任何一个时机强制它跑** —— pre-commit 只管提交，而这次我没提交。
 *
 * 所以这个脚本存在的唯一理由：**把「cp」和「验」绑成同一个动作**，
 * 让「部署了但没验」这种状态根本不存在。
 *
 * 用法
 * ----
 *   node tools/deploy-client.mjs --pkg dsh-yanqing-echo
 *   node tools/deploy-client.mjs --pkg dsh-yanqing-echo --src D:/AI/dsh-tools/dsh-yanqing-echo
 *   node tools/deploy-client.mjs --pkg dsh-yanqing-echo --dry-run
 *
 * 默认源目录：`D:/AI/dsh-tools/<pkg>`（本机部署包的源）
 * 默认目标：profile 的 node_modules/<pkg>
 *
 * 退出码：0 = 部署并验证通过；1 = 拒绝部署 / 验证失败（已自动回滚）
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, copyFileSync, unlinkSync, renameSync } from 'node:fs'
import { join, dirname, basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name)
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1]
  return fallback
}
const has = (name) => process.argv.includes('--' + name)

const PKG = arg('pkg', 'dsh-yanqing-echo')
const SRC = arg('src', `D:/AI/dsh-tools/${PKG}`)
const DRY = has('dry-run')

// profile 目录：优先环境变量，否则用本机默认
const PROFILE = process.env.DSH_PROFILE_DIR || 'D:/AI/dsh/home/profiles/desktop'
const DEST = join(PROFILE, 'node_modules', PKG)

const srcFile = join(SRC, 'client.js')
const dstFile = join(DEST, 'client.js')
const srcPkgJson = join(SRC, 'package.json')
const dstPkgJson = join(DEST, 'package.json')

console.log(`\n  deploy-client  ${PKG}`)
console.log(`    源   ${srcFile}`)
console.log(`    目标 ${dstFile}`)
if (DRY) console.log('    （--dry-run，只检查不写）\n')

/* ── 1. 前置：两边都得在 ─────────────────────────────────────────── */
for (const [label, p] of [['源 client.js', srcFile], ['目标目录', DEST], ['源 package.json', srcPkgJson], ['目标 package.json', dstPkgJson]]) {
  if (!existsSync(p)) {
    console.error(`\n  ✗ 找不到${label}：${p}\n`)
    process.exit(1)
  }
}

/* ── 2. 核心断言：**两个包必须是同一个包** ───────────────────────────
 *
 * 这是本次事故的根因 —— 我跨包 cp 了。
 * 判据：源和目标的 package.json.name 必须相等。
 * 不相等就不是「同一包的两份副本」，而是「两个不同的包」—— 这种 cp 必然把 id 带错。
 */
function pkgName(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')).name || '' } catch { return '' }
}
const srcName = pkgName(srcPkgJson)
const dstName = pkgName(dstPkgJson)

if (srcName !== dstName) {
  console.error('')
  console.error(`  ✗ 源和目标是**两个不同的包** —— 拒绝部署。`)
  console.error(`      src  package.json.name = ${srcName || '(读不到)'}`)
  console.error(`      dest package.json.name = ${dstName || '(读不到)'}`)
  console.error('')
  console.error('    跨包 cp client.js 会把 load({ id }) 一起带错，')
  console.error('    而 client-modules 拿 entry 名查注册表 —— 查不到就整批 web boot 不激活，')
  console.error('    桌面端弹「应用无法启动」，全界面进不去。2026-11-01 就是这么崩的。')
  console.error('')
  console.error('    如果你确实想改的是另一个包，用 --src 指向它自己的源目录。')
  console.error('')
  process.exit(1)
}

/* ── 3. 源文件自身的 id == 包名？（部署前就拦掉一半） ──────────────── */
const srcText = readFileSync(srcFile, 'utf8')
const m = srcText.match(/__ModuleLoader__\.load\(\{[\s\S]*?\bid:\s*["']([^"']+)["']/)
const srcId = m ? m[1] : null
if (!srcId) {
  console.error('\n  ✗ 源 client.js 里找不到 `__ModuleLoader__.load({ id: "..." })`\n')
  process.exit(1)
}
if (srcId !== srcName) {
  console.error('')
  console.error(`  ✗ 源的 client.js id ≠ package.json.name —— 拒绝部署。`)
  console.error(`      load({ id })      = ${srcId}`)
  console.error(`      package.json.name = ${srcName}`)
  console.error('')
  process.exit(1)
}
console.log(`    ✓ 同包，且 id 自洽（${srcName}）`)

if (DRY) {
  console.log('\n  （dry-run 到此为止，没有写任何文件）\n')
  process.exit(0)
}

/* ── 3.5 渲染冒烟闸（2026-11-01 加）──────────────────────────────
 * ★ 为什么要有这一关：
 *   `node --check` 只验**语法**。2026-11-01 我把面板弄空了一次 ——
 *   语法全过、id 全对、部署「成功」，浏览器里整块空白。
 *   根因是 `toggleGlass` 被插进了 `toggleMotion` 的函数体里（成了局部变量），
 *   运行时 ReferenceError，而语法完全合法。
 *
 * 这一关跑 tools/echo-smoke.mjs：mock 掉 react 和宿主，
 * 真把组件树展开两遍，能抓 ReferenceError / TypeError。
 *
 * 跳过用 --skip-smoke —— 只在明确知道原因时才用。 */
if (!has('skip-smoke')) {
  const smokePath = join(REPO, 'tools', 'echo-smoke.mjs')
  if (!existsSync(smokePath)) {
    console.error('\n  ✗ 找不到 tools/echo-smoke.mjs —— 拒绝部署\n')
    process.exit(1)
  }
  console.log('    · 跑渲染冒烟…')
  const r = spawnSync(process.execPath, [smokePath, srcFile], { encoding: 'utf8' })
  const out = String((r.stdout || '') + (r.stderr || '')).trim()
  if (r.status !== 0) {
    console.error('')
    console.error('  ✗ 渲染冒烟没通过 —— 拒绝部署。')
    console.error('    这大概率会造成「面板整块空白」，不是能随手修的小 bug。')
    console.error('')
    const tail = out.split('\n').slice(-14)
    for (const line of tail) console.error('    ' + line)
    console.error('')
    console.error('    确认是误报时用 --skip-smoke（但先想清楚为什么）。')
    console.error('')
    process.exit(1)
  }
  const tail = out.split('\n').filter((l) => /✓|节点|组件/.test(l)).slice(-3)
  for (const line of tail) console.log('    ' + line.trim())
  console.log('    ✓ 渲染冒烟通过')
}

/* ── 4. 部署（备份 → 覆盖） ────────────────────────────────────────── */
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const backup = `${dstFile}.bak-deploy-${stamp}`
copyFileSync(dstFile, backup)
copyFileSync(srcFile, dstFile)
console.log(`    ✓ 已部署（备份 ${basename(backup)}）`)

/* ── 5. 部署后立刻验 —— 用现成的 verify-client-ids ──────────────────── */
const verifier = join(REPO, 'tools', 'verify-client-ids.mjs')
if (!existsSync(verifier)) {
  console.log('    ⚠ 找不到 verify-client-ids.mjs，跳过部署后验证')
  process.exit(0)
}

let ok = true
try {
  const out = execFileSync(process.execPath, [verifier], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  process.stdout.write(out.split('\n').filter((l) => l.trim()).slice(-4).map((l) => '    ' + l).join('\n') + '\n')
} catch (e) {
  ok = false
  const txt = String((e && (e.stdout || e.stderr || e.message)) || '')
  process.stdout.write(txt.split('\n').filter((l) => l.trim()).slice(-10).map((l) => '    ' + l).join('\n') + '\n')
}

if (!ok) {
  /* ── 6. 验证失败 → 自动回滚 ─────────────────────────────────────── */
  console.error('\n  ✗ 部署后 id 校验没过 —— **已回滚**。')
  try {
    copyFileSync(backup, dstFile)
    console.error('    回滚完成，客户端回到部署前的状态。')
  } catch (e) {
    console.error(`    ✗ 回滚失败：${e && e.message}`)
    console.error(`      手动恢复：cp "${backup}" "${dstFile}"`)
  }
  console.error('')
  process.exit(1)
}

console.log('\n  ✓ 部署完成，id 校验通过\n')
