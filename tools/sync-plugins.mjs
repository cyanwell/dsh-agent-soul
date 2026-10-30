#!/usr/bin/env node
/**
 * sync-plugins.mjs —— plugins/ 与 organs 仓库的对账与同步
 * ========================================================
 *
 * ★ 为什么需要它
 * --------------
 * 同一套零件有两个住处：
 *   A. dsh-agent-soul/plugins/   ← 安装源（别人装 soul 时就地装零件）
 *   B. dsh-agent-organs/         ← 零件仓库（给人单独拿）
 *
 * 两个都自称是源，于是各自漂。2026-10-18 实测：14 个零件里只有 1 个一致，
 * echo-doctor.mjs 一边 35.9K 一边 26.7K —— 而没有人知道哪边是对的。
 *
 * 方向已定（2026-10-18）：**plugins/ 是权威**（它是最新的，也是别人真正会装的那份），
 * organs 向它对齐。
 *
 * ★ 两种运行方式
 * --------------
 *   node tools/sync-plugins.mjs --check    只报差异，不改文件。有差异时退出码 1。
 *   node tools/sync-plugins.mjs --apply    真同步：plugins/ → organs
 *
 * ★ 三条纪律
 * ----------
 *   1. **只覆盖，不删除。** organs 独有而 plugins 没有的文件（selftest.mjs、demo/ 之类）
 *      保留 —— 它们可能是 organs 那边的增量，删掉是丢东西。但会报出来让人判断。
 *   2. **跳过 node_modules / .git / lib（编译产物）。**
 *   3. **--check 永远安全**：它不写任何东西，可以挂在 check 里反复跑。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SOUL = path.resolve(HERE, '..')                 // dsh-agent-soul
const PLUGINS = path.join(SOUL, 'plugins')            // 权威
const ORGANS = path.resolve(SOUL, '..', 'dsh-agent-organs')  // 被同步方

const SKIP_DIR = new Set(['node_modules', '.git', 'lib', '.turbo'])
const SKIP_FILE = new Set(['.DS_Store', 'Thumbs.db'])

const apply = process.argv.includes('--apply')
const check = process.argv.includes('--check') || !apply

function hash(p) {
  try { return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex') } catch { return null }
}

function listFiles(root) {
  const out = []
  function walk(dir, rel) {
    let items
    try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const d of items) {
      if (SKIP_DIR.has(d.name) || SKIP_FILE.has(d.name) || d.name.startsWith('.')) continue
      const full = path.join(dir, d.name)
      const r = rel ? rel + '/' + d.name : d.name
      if (d.isDirectory()) walk(full, r)
      else out.push(r)
    }
  }
  walk(root, '')
  return out.sort()
}

if (!fs.existsSync(PLUGINS)) { console.error('✗ 找不到 plugins/：' + PLUGINS); process.exit(2) }
if (!fs.existsSync(ORGANS)) { console.error('✗ 找不到 organs 仓库：' + ORGANS); process.exit(2) }

console.log('权威（源）: ' + PLUGINS)
console.log('同步目标  : ' + ORGANS)
console.log('模式      : ' + (apply ? '--apply（会写文件）' : '--check（只报差异）'))
console.log('')

const dirs = fs.readdirSync(PLUGINS, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith('.') && !SKIP_DIR.has(d.name))
  .map(d => d.name).sort()

let nSame = 0, nDiff = 0, nOnlySrc = 0, nOnlyDst = 0
const diffs = [], onlySrc = [], onlyDst = []

for (const part of dirs) {
  const a = listFiles(path.join(PLUGINS, part))
  const b = new Set(listFiles(path.join(ORGANS, part)))
  const aSet = new Set(a)
  const differs = []
  for (const f of a) {
    const fa = path.join(PLUGINS, part, f)
    const fb = path.join(ORGANS, part, f)
    if (!b.has(f)) { onlySrc.push(part + '/' + f); continue }
    if (hash(fa) === hash(fb)) nSame++
    else differs.push(f)
  }
  if (differs.length) {
    nDiff += differs.length
    diffs.push({ part, files: differs })
  }
  for (const f of b) if (!aSet.has(f)) onlyDst.push(part + '/' + f)
}
nOnlySrc = onlySrc.length
nOnlyDst = onlyDst.length

// ── 报告 ──
if (!diffs.length && !onlySrc.length) {
  console.log('✓ 一致：' + nSame + ' 个文件，没有任何需要同步的。')
  if (nOnlyDst.length) {
    console.log('')
    console.log('  注意：organs 有 ' + nOnlyDst.length + ' 个 plugins 没有的文件（保留，不删）：')
    for (const f of onlyDst.slice(0, 12)) console.log('    · ' + f)
    if (nOnlyDst.length > 12) console.log('    … 还有 ' + (nOnlyDst.length - 12) + ' 个')
  }
  process.exit(0)
}

if (diffs.length) {
  console.log('【内容不同】' + nDiff + ' 个文件 —— organs 需要更新为 plugins 的版本：')
  for (const d of diffs) {
    console.log('  ' + d.part + '/')
    for (const f of d.files) {
      const sa = fs.statSync(path.join(PLUGINS, d.part, f)).size
      const sb = path.join(ORGANS, d.part, f)
      const ss = fs.existsSync(sb) ? fs.statSync(sb).size : 0
      console.log('    ' + f.padEnd(32) + 'plugins ' + String(sa).padStart(8) + 'B   organs ' + String(ss).padStart(8) + 'B')
    }
  }
}
if (onlySrc.length) {
  console.log('')
  console.log('【organs 缺】' + onlySrc.length + ' 个文件：')
  for (const f of onlySrc) console.log('  ' + f)
}
if (onlyDst.length) {
  console.log('')
  console.log('【organs 独有】' + onlyDst.length + ' 个文件（同步不会删它们）：')
  for (const f of onlyDst) console.log('  ' + f)
}

// ── 执行同步 ──
if (apply) {
  console.log('')
  console.log('── 同步中 ──')
  let copied = 0, skipped = 0
  const doCopy = (part, f) => {
    const src = path.join(PLUGINS, part, f)
    const dst = path.join(ORGANS, part, f)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
    copied++
  }
  for (const d of diffs) for (const f of d.files) doCopy(d.part, f)
  for (const f of onlySrc) {
    const i = f.indexOf('/')
    doCopy(f.slice(0, i), f.slice(i + 1))
  }
  console.log('  ✓ 复制 ' + copied + ' 个文件')
  console.log('  ✓ 保留 ' + onlyDst.length + ' 个 organs 独有文件')
  console.log('')
  console.log('  下一步：去 organs 仓库 git add / commit，然后用 --check 复查。')
  process.exit(0)
}

console.log('')
console.log('→ 要同步的话：node tools/sync-plugins.mjs --apply')
process.exit(1)
