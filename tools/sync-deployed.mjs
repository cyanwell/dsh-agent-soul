#!/usr/bin/env node
/**
 * sync-deployed.mjs —— 「发布版」与「本机部署版」的对账器
 * ========================================================
 *
 * ★ 为什么需要它
 * 同一个零件的两个住处，**部署端是权威** —— 我们先在本机跑通，才把改动传到仓库：
 *   A. <profile>/node_modules/<包名>/   ← 部署版（权威；包名 dsh-yanqing-* 等，可含本机路径）
 *   B. dsh-agent-soul/plugins/<目录>/   ← 发布版（镜像；包名 dsh-agent-*，不许含本机路径）
 * 2026-11-02 实测：两边在 15 个包上全部有差异，而没有任何工具会告诉你。
 * 原来的 sync-plugins.mjs 是 plugins → dsh-agent-organs，那个仓库 10-30 已弃用并删除。
 *
 * ★ 两边有差异时，默认读法是「仓库还没跟上」，不是「部署端落后」。
 * 唯一的例外：发布时在仓库声明了新版本号、却忘了改本机 package.json 的 version ——
 * 那种「本机是旧的」是真落后，要补。判据：比两边 package.json 的 version。
 *
 * ★ 它刻意不做的一件事
 * 不判断「谁该跟谁」。仓库文件的 mtime 会被 git checkout 刷新，拿它当判据会误报
 *（第一版就这么干过，报了 15 个假「部署落后」）。工具只让差异可见；
 * 方向按上面那条读法走。
 *
 * ★ 用法（永远只读，不写任何文件）
 *   node tools/sync-deployed.mjs
 *   node tools/sync-deployed.mjs --deployed "D:\\AI\\dsh\\home\\profiles\\desktop\\node_modules"
 *   node tools/sync-deployed.mjs --fail-on-diff   # 有差异时 exit 1（给 CI 用）
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PLUGINS = path.join(ROOT, 'plugins')

const args = process.argv.slice(2)
function getArg(name, dflt) {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}

const DEPLOYED = getArg('--deployed', process.env.SOUL_DEPLOYED
  || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', 'desktop', 'node_modules'))

const SKIP_DIR = new Set(['node_modules', '.git', '.turbo', 'test', 'tests', 'dist', 'coverage'])
const SKIP_FILE = /(^|\/)(\..*|.*\.bak.*|.*\.log)$/
const SKIP_EXT = new Set(['.mp4', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico'])

function keyOf(name) {
  if (!name) return null
  return name.replace(/^dsh-agent-/, '').replace(/^dsh-yanqing-/, '').replace(/^dsh-/, '')
}

function listFiles(root) {
  const out = []
  function walk(dir, rel) {
    let ents
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const r = rel ? rel + '/' + e.name : e.name
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIR.has(e.name)) continue
        walk(abs, r)
      } else if (e.isFile()) {
        if (SKIP_FILE.test(r)) continue
        if (SKIP_EXT.has(path.extname(e.name).toLowerCase())) continue
        out.push(r)
      }
    }
  }
  walk(root, '')
  return out.sort()
}

function readPkg(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) } catch { return null }
}

function sha(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') } catch { return '' }
}

if (!fs.existsSync(PLUGINS)) { console.error('找不到 plugins/：' + PLUGINS); process.exit(2) }
if (!fs.existsSync(DEPLOYED)) { console.error('找不到部署目录：' + DEPLOYED + '（用 --deployed 指一个 node_modules）'); process.exit(2) }

const repoMap = new Map()
for (const d of fs.readdirSync(PLUGINS, { withFileTypes: true })) {
  if (!d.isDirectory()) continue
  const p = readPkg(path.join(PLUGINS, d.name))
  if (!p || !p.name) continue
  repoMap.set(keyOf(p.name), { dir: d.name, name: p.name, abs: path.join(PLUGINS, d.name) })
}

const depMap = new Map()
for (const d of fs.readdirSync(DEPLOYED, { withFileTypes: true })) {
  if (!d.isDirectory() || !d.name.startsWith('dsh-')) continue
  const p = readPkg(path.join(DEPLOYED, d.name))
  if (!p || !p.name) continue
  if (p.name.startsWith('dsh-mnemon-')) continue
  const k = keyOf(p.name)
  if (!k) continue
  if (!depMap.has(k)) depMap.set(k, { dir: d.name, name: p.name, abs: path.join(DEPLOYED, d.name) })
}

const keys = Array.from(new Set(Array.from(repoMap.keys()).concat(Array.from(depMap.keys())))).sort()
const rows = []
for (const k of keys) {
  const r = repoMap.get(k)
  const d = depMap.get(k)
  if (!r || !d) { rows.push({ key: k, only: r ? 'repo' : 'deployed' }); continue }
  const rf = listFiles(r.abs)
  const df = listFiles(d.abs)
  const dSet = new Set(df)
  const rSet = new Set(rf)
  const both = rf.filter(function (f) { return dSet.has(f) })
  const diff = both.filter(function (f) { return sha(path.join(r.abs, f)) !== sha(path.join(d.abs, f)) })
  rows.push({
    key: k,
    repoFiles: rf.length,
    depFiles: df.length,
    same: both.length - diff.length,
    diff: diff.length,
    onlyRepo: rf.filter(function (f) { return !dSet.has(f) }).length,
    onlyDep: df.filter(function (f) { return !rSet.has(f) }).length,
    sample: diff.slice(0, 4),
  })
}

const paired = rows.filter(function (x) { return !x.only })
const onlyRepo = rows.filter(function (x) { return x.only === 'repo' })
const onlyDep = rows.filter(function (x) { return x.only === 'deployed' })
const differing = paired.filter(function (x) { return x.diff > 0 || x.onlyRepo > 0 || x.onlyDep > 0 })

console.log('发布版: ' + PLUGINS)
console.log('部署版: ' + DEPLOYED)
console.log('')
console.log('key                 repo  dep  same  diff')
for (const x of paired) {
  const pad = (x.key + '                    ').slice(0, 20)
  const mark = x.diff ? '  ← 有差异' : ''
  console.log(pad + String(x.repoFiles).padEnd(6) + String(x.depFiles).padEnd(5) + String(x.same).padEnd(6) + String(x.diff).padEnd(5) + mark)
}
if (onlyRepo.length) console.log('\n只在发布版: ' + onlyRepo.map(function (x) { return x.key }).join(', '))
if (onlyDep.length) console.log('\n只在部署端: ' + onlyDep.map(function (x) { return x.key }).join(', '))
console.log('')
console.log('★ 本工具不判断「谁该跟谁」——仓库 mtime 会被 git checkout 刷新，会误报。')
console.log('  要看仓库侧最后一次改动： git -C <仓库> log -1 --format=%cs -- plugins/<目录>')
console.log('  差异怎么处理： docs/两套代码-发布版与部署版.md')
console.log('')
console.log('共 ' + differing.length + ' / ' + paired.length + ' 个包存在差异。')
if (args.includes('--fail-on-diff') && differing.length) process.exit(1)
process.exit(0)
