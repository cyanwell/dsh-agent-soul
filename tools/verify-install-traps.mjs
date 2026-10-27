#!/usr/bin/env node
/**
 * verify-install-traps.mjs —— 把「装上了但没生效」的四种静默失败钉成 CI 检查
 *
 * 为什么有这个东西
 * ----------------
 * 2026-10-26 在一台真机上从零装了一遍这个仓库，撞到 5 个问题，其中 4 个的共同点是：
 * **命令成功、文件在、bundles 里有、体检绿 —— 就是不工作，而且不报错。**
 *
 * 它们各自绕过了不同的判据：
 *   · failed to import 只出现在启动日志，而且是 warning 级
 *   · 示例文件不是代码，没人会去对键名
 *   · 模板不会自己报错，它只是和磁盘对不上
 *
 * 所以这里把「绕过判据」这件事本身变成判据。四条检查，对应四个真实事故：
 *
 *   ① insert.name 必须是真实包名或相对路径
 *      事故：plugins/echo、plugins/huanqi-panel 在改名后留着旧 name（dsh-agent-* vs dsh-yanqing-*），
 *            宿主只留一行 "failed to import"，路由恒 404。
 *
 *   ② 示例配置的键名必须是 echo-config.mjs 真的会读的键
 *      事故：echo.config.example.json 写 "mem"，代码读 "memory"。
 *            照示例配的人会以为路径写错了，其实是键名。
 *
 *   ③ 地图模板的分区表必须和 scaffold.mjs 实建的目录一致
 *      事故：模板写 60-声音/70-形象/90-历代，scaffold 实建 60-工具/65-声音/70-收到/75-形象/90-历代根会话。
 *            「权威源」第一天就和磁盘对不上。
 *
 *   ④ 能跑的东西至少得能解析
 *      事故：JSON 带 BOM、YAML 缩进出错、.mjs 语法坏 —— 全都是启动时才炸。
 *
 * 用法：node tools/verify-install-traps.mjs        （从任意目录调用都行）
 *       node tools/verify-install-traps.mjs --verbose
 * 退出码：0 = 全过；1 = 有失败（CI 直接用它）
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const VERBOSE = process.argv.includes('--verbose')

let pass = 0
const failures = []
let group = ''

function section(name) {
  group = name
  if (VERBOSE) console.log(`\n── ${name} ──`)
}
function ok(msg) {
  pass++
  if (VERBOSE) console.log(`  ✓ ${msg}`)
}
function fail(msg, hint) {
  failures.push({ group, msg, hint })
  console.log(`  ✗ ${msg}${hint ? `\n      → ${hint}` : ''}`)
}

const read = (p) => fs.readFileSync(p, 'utf8')
const exists = (p) => fs.existsSync(p)
const json = (p) => JSON.parse(read(p).replace(/^\uFEFF/, ''))

/** 仓库里的包目录：plugins/<x>/package.json 与根 package.json */
function pluginDirs() {
  const dir = path.join(ROOT, 'plugins')
  if (!exists(dir)) return []
  return fs.readdirSync(dir)
    .map((n) => path.join(dir, n))
    .filter((p) => fs.statSync(p).isDirectory() && exists(path.join(p, 'package.json')))
}

/** 极简 patch 读取：只认本仓库用到的形状（- insert: / id: / name: / disabled:） */
function parsePatch(text) {
  const rows = []
  let cur = null
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue
    const mId = line.match(/^\s*-\s*id:\s*(.+?)\s*$/)
    const mName = line.match(/^\s*name:\s*(.+?)\s*$/)
    const mIns = /^\s*-\s*insert:\s*$/.test(line)
    if (mIns) continue
    if (mId) {
      cur = { id: unquote(mId[1]), name: null, disabled: false }
      rows.push(cur)
      continue
    }
    if (mName && cur) { cur.name = unquote(mName[1]); continue }
    if (/^\s*disabled:\s*true\s*$/.test(line) && cur) cur.disabled = true
  }
  return rows
}
const unquote = (s) => s.trim().replace(/^['"]|['"]$/g, '')

// ─────────────────────────────────────────────────────────────
section('① insert.name 是真实包名（不是改名前的旧名）')

const knownNames = new Set()
for (const p of pluginDirs()) {
  try { knownNames.add(json(path.join(p, 'package.json')).name) } catch { /* ④ 会报 */ }
}
try { knownNames.add(json(path.join(ROOT, 'package.json')).name) } catch { /* ④ 会报 */ }
// 允许出现的、不在本仓库里的包（如内置注入点、mnemon 之类的运行时包），用白名单说明其来源
const EXTERNAL_ALLOW = new Set([
  'dsh-mnemon',            // npm 包，不在本仓库
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
])

let patchCount = 0
for (const dir of pluginDirs()) {
  const patchPath = path.join(dir, 'cordis.patch.yml')
  if (!exists(patchPath)) continue
  patchCount++
  const pkgName = (() => { try { return json(path.join(dir, 'package.json')).name } catch { return null } })()
  for (const row of parsePatch(read(patchPath))) {
    if (!row.name) {
      fail(`${path.relative(ROOT, patchPath)} 的 ${row.id} 没有 name`, 'insert 必须带 name（模块名或相对路径）')
      continue
    }
    const isPath = row.name.startsWith('.') || row.name.startsWith('/')
    if (isPath) { ok(`${pkgName} ← ${row.name}（相对路径）`); continue }
    const isSelf = row.name === pkgName
    const isKnown = knownNames.has(row.name) || EXTERNAL_ALLOW.has(row.name)
    if (isSelf) { ok(`${pkgName} ← ${row.name}`); continue }
    if (isKnown) {
      // 这个名字能解析，但它不是本包自己 —— 明确说出来，别当静默通过
      fail(
        `${path.relative(ROOT, patchPath)} 的 name=${row.name} 不是本包（${pkgName}）`,
        '如果你想插的是别的包，把它写在那个包的 patch 里；同一文件夹插自己时 name 必须等于 package.json 的 name'
      )
      continue
    }
    fail(
      `${path.relative(ROOT, patchPath)} 的 name=${row.name} 解析不到任何包`,
      `真实包名是 ${pkgName}。名字写错时宿主只留一行 "failed to import"，不报错、不崩，路由恒 404`
    )
  }
}
if (patchCount === 0) fail('一个 cordis.patch.yml 都没扫到', '插件目录结构变了？')
else if (!failures.some((f) => f.group.includes('insert.name'))) ok(`${patchCount} 个 patch 的 name 全部对得上`)

// ─────────────────────────────────────────────────────────────
section('② 示例配置的键名 = 代码真的会读的键')

const KNOWN_CFG_KEYS = new Set(['hub', 'soul', 'memory', 'sessions', 'runtime', '_说明'])
for (const dir of [path.join(ROOT, 'plugins', 'echo'), path.join(ROOT, 'kit', 'echo')]) {
  const example = path.join(dir, 'echo.config.example.json')
  if (!exists(example)) continue
  let cfg
  try { cfg = json(example) } catch (e) {
    fail(`${path.relative(ROOT, example)} 不是合法 JSON`, e.message)
    continue
  }
  const keys = Object.keys(cfg).filter((k) => !k.startsWith('_'))
  for (const k of keys) {
    if (KNOWN_CFG_KEYS.has(k)) ok(`${path.relative(ROOT, example)} 键 ${k}`)
    else fail(
      `${path.relative(ROOT, example)} 里有 echo-config.mjs 不认识的键：${k}`,
      '代码只读 hub / soul / memory / sessions / runtime。写错键名时体检会报「没有配置 MEM」，看起来像路径错'
    )
  }
  for (const must of ['soul', 'memory']) {
    if (!keys.includes(must)) {
      fail(
        `${path.relative(ROOT, example)} 缺 ${must}`,
        `echo-config.mjs 用 pick('ECHO_${must.toUpperCase()}', '${must}') 读它`
      )
    }
  }
}

// ─────────────────────────────────────────────────────────────
section('③ 地图模板的分区表 = scaffold.mjs 实建的目录')

const scaffoldPath = path.join(ROOT, 'kit', 'echo', 'scaffold.mjs')
const tplPath = path.join(ROOT, 'kit', 'templates', '00-书房地图.src.md')
if (!exists(scaffoldPath) || !exists(tplPath)) {
  fail('找不到 scaffold.mjs 或 00-书房地图.src.md', '路径变了就同步改这个脚本')
} else {
  const scaffoldSrc = read(scaffoldPath)
  const dirsBlock = scaffoldSrc.match(/const DIRS\s*=\s*\[([\s\S]*?)\n\]/m)
  const realDirs = dirsBlock
    ? [...dirsBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((n) => /^\d\d-/.test(n))
    : []
  if (realDirs.length === 0) {
    fail('没能从 scaffold.mjs 里读出 DIRS', 'DIRS 的形状变了就同步改这里的正则')
  } else {
    const tplSrc = read(tplPath)
    // 只认目录名：00-灵魂.md / 02-墨.jsonl 这类根文件名不算（它们是文件，不建目录）
    const tplDirs = new Set(
      [...tplSrc.matchAll(/`(\d\d-[^`]+)`/g)]
        .map((m) => m[1].trim())
        .filter((n) => !n.includes('.'))
    )
    const missing = realDirs.filter((d) => !tplDirs.has(d))
    const extra = [...tplDirs].filter((d) => !realDirs.includes(d))
    if (missing.length) {
      fail(`地图模板缺 ${missing.length} 个实际会建的目录：${missing.join(', ')}`,
        '模板比骨架旧一代时，地图是「权威源」却第一天就和磁盘对不上')
    }
    if (extra.length) {
      fail(`地图模板里有 ${extra.length} 个不会建的目录：${extra.join(', ')}`,
        '照着找会找不到 —— 这正是事故里的 60-声音 / 70-形象 / 90-历代')
    }
    if (!missing.length && !extra.length) ok(`${realDirs.length} 个目录两边一致`)
  }
}

// ─────────────────────────────────────────────────────────────
section('④ 能跑的东西至少得能解析')

function walk(dir, out = []) {
  for (const n of fs.readdirSync(dir)) {
    if (n === 'node_modules' || n === '.git') continue
    const p = path.join(dir, n)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}
const allFiles = walk(ROOT)

let jsonCount = 0
for (const f of allFiles.filter((p) => p.endsWith('.json'))) {
  jsonCount++
  try { json(f) } catch (e) {
    const bom = read(f).startsWith('\uFEFF')
    fail(`${path.relative(ROOT, f)} 解析失败`, bom ? '★ 文件带 BOM —— DSH 会 JSON.parse 失败' : e.message)
  }
}
ok(`${jsonCount} 个 JSON 都能解析`)

const scripts = allFiles.filter((p) => /\.(mjs|js|cjs)$/.test(p))
let badSyntax = 0
for (const f of scripts) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }) } catch (e) {
    badSyntax++
    fail(`${path.relative(ROOT, f)} 语法错误`, String(e.stderr || e.message).split('\n').slice(0, 3).join('\n      '))
  }
}
if (!badSyntax) ok(`${scripts.length} 个 js/mjs 语法都过`)

// ─────────────────────────────────────────────────────────────
console.log('')
console.log('════════════════════════════════════════════════════════')
if (failures.length === 0) {
  console.log(`通过 ${pass}   失败 0   —— 四种静默失败都没复现`)
  process.exit(0)
}
console.log(`通过 ${pass}   失败 ${failures.length}`)
console.log('')
for (const f of failures) {
  console.log(`✗ [${f.group.replace(/^[①-④]\s*/, '')}] ${f.msg}`)
  if (f.hint) console.log(`   → ${f.hint}`)
}
console.log('')
console.log('这四条检查各对应一次真实事故 —— 修的时候按提示改，不要改这个脚本的判据。')
process.exit(1)
