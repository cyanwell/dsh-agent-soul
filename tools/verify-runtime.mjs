#!/usr/bin/env node
// verify-runtime.mjs —— 装完之后才知道的那几件事（2026-11-05）
//
// ============================================================================
// ★ 为什么要有它（和 verify-packaging 的分工）
//
//   verify-packaging 查的是**仓库**：files 清单、patch 形状、两份清单一致、
//   本机路径泄漏…… 全部是「不装也能查」的静态事实。
//
//   但 INSTALL.md 那 7 个坑里，有 3 个是**装完才知道**的：
//     坑 1  pnpm 不在 PATH          → 装到一半才炸
//     坑 4  同名服务先到先得        → 装完、没报错、就是不工作
//     坑 7  重装一遍、副本没变      → 改了源码、行为没变
//
//   它们共同点：**静态看全绿，跑起来不对**。所以需要一个对着**已安装的 profile**
//   跑的检查器。这就是本文件。
//
// ★ 用法
//     node tools/verify-runtime.mjs                    # 自动找 profile
//     node tools/verify-runtime.mjs --profile <路径>   # 指定
//     node tools/verify-runtime.mjs --json             # 给机器读
//
//   退出码：0 = 全过；1 = 有 FAIL；2 = 参数/环境错误
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.join(HERE, '..')

const argv = process.argv.slice(2)
const wantJson = argv.includes('--json')
const profileArg = (() => {
  const i = argv.indexOf('--profile')
  return i >= 0 ? argv[i + 1] : null
})()

const checks = []
// level: 'fail'（默认，会exit 1）| 'warn'（只提醒，不影响退出码）
function check(name, ok, detail, hint, level) {
  checks.push({ name, ok: Boolean(ok), detail: detail || '', hint: hint || '', level: level || 'fail' })
}

// ── 找到 profile ───────────────────────────────────────────────────────────
// 顺序：--profile → 本仓库被装在哪（<profile>/node_modules/dsh-agent-soul）→ 常见位置
function findProfile() {
  if (profileArg) return path.resolve(profileArg)
  // ① 从本文件位置推：<profile>/node_modules/dsh-agent-soul/tools/
  const up3 = path.resolve(HERE, '..', '..', '..')
  if (fs.existsSync(path.join(up3, 'package.json'))) {
    try {
      const pj = JSON.parse(fs.readFileSync(path.join(up3, 'package.json'), 'utf8').replace(/^\uFEFF/, ''))
      if (pj.dsh) return up3
    } catch {}
  }
  // ② 常见位置
  const home = os.homedir()
  const cands = [
    path.join(home, '.dsh', 'profiles', 'desktop'),
    path.join(home, '.dsh', 'profiles', 'web'),
    path.join(process.env.DSH_HOME || '', 'profiles', 'desktop'),
  ].filter(Boolean)
  for (const c of cands) {
    if (c && fs.existsSync(path.join(c, 'package.json'))) return c
  }
  return null
}

const profile = findProfile()

function readJsonNoBom(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
}

// ── 检查 1：pnpm 可用（坑 1）────────────────────────────────────────────────
// dsh plugin add 内部转发给 pnpm。不在 PATH 时，装到一半才炸，报错还长得像别的问题。
function checkPnpm() {
  const tried = []
  for (const cmd of process.platform === 'win32' ? ['pnpm.cmd', 'pnpm'] : ['pnpm']) {
    try {
      const v = execFileSync(cmd, ['--version'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      if (v) {
        check('pnpm 可用（dsh plugin add 依赖它）', true, cmd + ' → ' + v)
        return
      }
    } catch (e) {
      tried.push(cmd)
    }
  }
  // ★ 为什么是 warn 而不是 fail（2026-11-05）：
  //   本机实测 pnpm 不在 PATH，而 dsh plugin add 历史上**成功装过** —— 说明 dsh 可能有
  //   自己的解析路径（或装了 corepack shim），我没查实。**没证实会坏的事不该报红**，
  //   否则真正的问题会被这条假警报淹掉。
  check(
    'pnpm 可用（dsh plugin add 依赖它）',
    false,
    '试过：' + tried.join(' / ') + '，都不在 PATH —— 但 dsh plugin add 历史上成功过，可能不阻塞',
    '如果接下来装包报 pnpm 相关错，再跑 corepack enable pnpm',
    'warn'
  )
}

// ── 检查 2：我们自己的包之间有没有服务重名（坑 4 的**正确判据**）───────────
// ★ 坑 4 原文说「同名服务先到先得，后来者不报错、静默不生效」。
//   但**光看 bundles 里谁排在前面是错的判据** —— 那会把它变成假警报：
//   实测本机两个 profile 都是 @deepseek-ai/dsh-base 在索引 0、我们在 11/13，
//   而系统一直正常工作。原因：**这套插件根本不注册服务**，只 inject webServer。
//
//   所以正确判据是：**先把每个包真正 provide 什么服务读出来**，
//   只有真重名才报。读不到（内置包在 asar 里）就明说读不到，不假装查过。
function scanProvides(dir) {
  // 返回 { pkgName: [serviceName...] }
  const out = {}
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const pjPath = path.join(dir, e.name, 'package.json')
    const idxPath = path.join(dir, e.name, 'index.js')
    const idxMjs = path.join(dir, e.name, 'index.mjs')
    const entry = fs.existsSync(idxPath) ? idxPath : fs.existsSync(idxMjs) ? idxMjs : null
    if (!entry) continue
    let src = ''
    try {
      src = fs.readFileSync(entry, 'utf8')
    } catch {
      continue
    }
    const svc = new Set()
    // ctx.provide('x') / ctx.provide("x")
    for (const m of src.matchAll(/ctx\.provide\(\s*['"`]([\w.:-]+)['"`]/g)) svc.add(m[1])
    // ctx.set('x', ...) —— cordis 里也当服务名用
    for (const m of src.matchAll(/ctx\.set\(\s*['"`]([\w.:-]+)['"`]/g)) svc.add(m[1])
    // 静态 provide = [...]  / provide: [...]
    for (const m of src.matchAll(/provide\s*[:=]\s*\[([^\]]*)\]/g)) {
      for (const s of m[1].split(',')) {
        const t = s.trim().replace(/^['"`]|['"`]$/g, '')
        if (t) svc.add(t)
      }
    }
    if (svc.size) out[e.name] = [...svc]
  }
  return out
}

function checkServiceCollision() {
  const ours = path.join(PKG_ROOT, 'plugins')
  const mine = scanProvides(ours)
  const names = Object.keys(mine)
  if (!names.length) {
    check(
      '本仓库插件不注册服务（坑 4 对它不成立）',
      true,
      '扫了 plugins/ 下 ' + (fs.existsSync(ours) ? fs.readdirSync(ours).length : 0) + ' 个目录，没有 ctx.provide / provide= 声明'
    )
    return
  }
  // 找重名
  const seen = {}
  const dupes = []
  for (const pkg of names) {
    for (const s of mine[pkg]) {
      if (seen[s] && seen[s] !== pkg) dupes.push(s + ' ← ' + seen[s] + ' / ' + pkg)
      seen[s] = pkg
    }
  }
  check(
    '本仓库插件之间没有服务重名',
    dupes.length === 0,
    dupes.length ? dupes.join('; ') : names.length + ' 个包含服务声明，无重名',
    dupes.length ? 'cordis 里先注册的赢，后来的不报错、静默不生效 —— 改包名或改名' : ''
  )
}

// ── 检查 3：副本与源一致（坑 7）────────────────────────────────────────────
// dsh plugin add file: 走 pnpm 的 file: 依赖。**改了源、重装，pnpm 会说 Already up to date**
// 而副本一动不动。判据只能是：直接比两个 package.json 的 version，以及入口文件的 mtime。
function checkCopyFresh() {
  if (!profile) {
    check('副本与源一致（坑 7）', false, '找不到 profile，无法比较', '用 --profile 指定')
    return
  }
  const srcPj = path.join(PKG_ROOT, 'package.json')
  const copyDir = path.join(profile, 'node_modules', 'dsh-agent-soul')
  const copyPj = path.join(copyDir, 'package.json')
  if (!fs.existsSync(copyPj)) {
    check(
      '副本与源一致（坑 7）',
      true,
      '这个 profile 里没装 dsh-agent-soul（只装了 plugins/ 下的单个包）—— 不适用',
      ''
    )
    return
  }
  let a, b
  try {
    a = readJsonNoBom(srcPj)
    b = readJsonNoBom(copyPj)
  } catch (e) {
    check('副本与源一致（坑 7）', false, 'package.json 读不了：' + String(e && e.message ? e.message : e))
    return
  }
  if (a.version !== b.version) {
    check(
      '副本版本 == 源版本',
      false,
      '源 ' + a.version + ' / 副本 ' + b.version,
      'pnpm 对 file: 依赖会缓存 —— 重装要带 --force，或先删 ' + copyDir
    )
    return
  }
  // 版本相同，比入口文件 mtime —— 副本比源旧 = 装了旧的
  const probes = ['index.js', 'client.js', 'install.js']
  const stale = []
  for (const f of probes) {
    const sp = path.join(PKG_ROOT, f)
    const cp = path.join(copyDir, f)
    if (!fs.existsSync(sp) || !fs.existsSync(cp)) continue
    const sm = fs.statSync(sp).mtimeMs
    const cm = fs.statSync(cp).mtimeMs
    if (sm - cm > 2000) stale.push(f + '（源新 ' + Math.round((sm - cm) / 1000) + 's）')
  }
  check(
    '副本不比源旧',
    stale.length === 0,
    stale.length ? '落后的：' + stale.join(', ') : '版本 ' + a.version + '，三个入口文件都不比源旧',
    stale.length ? '删掉 ' + copyDir + ' 重新装，别信 pnpm 的 Already up to date' : ''
  )
}

// ── 跑 ─────────────────────────────────────────────────────────────────────
checkPnpm()
checkServiceCollision()
checkCopyFresh()

const failed = checks.filter((c) => !c.ok && c.level !== 'warn')
const warned = checks.filter((c) => !c.ok && c.level === 'warn')

if (wantJson) {
  console.log(JSON.stringify({ profile, checks, failed: failed.length }, null, 2))
} else {
  const lines = []
  lines.push('profile: ' + (profile || '(没找到)'))
  lines.push('')
  for (const c of checks) {
    const mark = c.ok ? 'OK   ' : c.level === 'warn' ? 'WARN ' : 'FAIL '
    lines.push(mark + c.name)
    if (c.detail) lines.push('       ' + c.detail)
    if (!c.ok && c.hint) lines.push('       → ' + c.hint)
  }
  lines.push('')
  const passed = checks.filter((c) => c.ok).length
  if (failed.length === 0 && warned.length === 0) lines.push('★ 全部通过')
  else if (failed.length === 0) lines.push('★ 通过（' + passed + ' 项），' + warned.length + ' 项提醒 —— 提醒不影响判定')
  else lines.push('通过 ' + passed + ' / ' + checks.length + '，失败 ' + failed.length + (warned.length ? '，提醒 ' + warned.length : ''))
  console.log(lines.join('\n'))
}

process.exit(failed.length === 0 ? 0 : 1)
