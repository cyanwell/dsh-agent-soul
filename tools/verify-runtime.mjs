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
  // ★ 2026-11-05 查实的结论（读 dsh 源码，不是猜）：
  //
  //   dsh 的 `plugin` 子命令是**纯 pnpm 转发器**：
  //     lib/plugin-Ddi42qoW.js:109  spawnSync("pnpm", args, { cwd: profileDir })
  //     同一文件 :116  result.error.code === "ENOENT" → 打「pnpm not found on PATH」并 return 127
  //   **没有内部兜底、没有自带 pnpm** —— 不在 PATH 就是 127。
  //
  //   但**桌面端那条路完全不用 pnpm**：install-desktop.ps1 全文 0 处 pnpm 调用，
  //   它是 Copy-Item 直接拷文件进 <profile>/node_modules/dsh-agent-soul。
  //
  //   所以这条不是「全局阻塞」，是「**只挡 CLI 这条路**」。
  //   原来我把它降成 WARN 是因为「没查实」—— 现在查实了，它是真会坏，只是坏在一条路上。
  //   所以判 FAIL，但错误信息必须同时说清另一条路能走。
  check(
    'pnpm 可用（只影响 `dsh plugin add` 这条 CLI 路径）',
    false,
    '试过：' + tried.join(' / ') + '，都不在 PATH',
    '两条路：① 走 CLI（dsh plugin add）→ 必须先跑 `corepack enable pnpm`；' +
    '② 走桌面端（install-desktop.ps1）→ 不经过 pnpm，可以直接装',
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

// 在包目录里递归找客户端入口。深度限 3 层 —— 够用，且不会钻进 node_modules。
// 认 .js / .mjs / .cjs 三种后缀，文件名必须是 client。
function hasClientEntry(dir, depth) {
  const d = depth || 0
  if (d > 3) return false
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return false }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue
      if (hasClientEntry(path.join(dir, e.name), d + 1)) return true
    } else if (/^client\.(js|mjs|cjs)$/.test(e.name)) {
      return true
    }
  }
  return false
}

// ── 检查 4：声明了 client 的包，client.js 真的在吗（坑 6）──────────────────
// ★ 坑 6 是真实用户反馈（2026-10-22，第一个装这个插件的人踩的）：
//   装完 client.js 不在，整个 DSH 会「裸奔」—— 宿主半在跑，客户端半整个没有，
//   页面看着正常，但面板/槽位一个都不出来。
//
//   静态检查早就有了（verify-packaging 里有 6 条）。但它们只能查**仓库里的清单**：
//   files 里有 client.js、ps1 的 $files 里有 client.js。
//   而用户踩的那条是**装完之后**的事 —— 清单对了，副本里还是没有。
//
//   所以这里查的是：profile/node_modules 里每个声明了 dsh.client 的包，
//   它的 client.js 是不是真的躺在那个目录里。
function checkClientJs() {
  if (!profile) {
    check('声明了 client 的包，client.js 都在', false, '找不到 profile，无法检查', '用 --profile 指定')
    return
  }
  const nm = path.join(profile, "node_modules")
  if (!fs.existsSync(nm)) {
    check('声明了 client 的包，client.js 都在', true, 'profile 下没有 node_modules —— 还没装任何包，不适用')
    return
  }
  const declared = []
  const missing = []
  let scanned = 0
  const scanPkgDir = (dir, label) => {
    const pjPath = path.join(dir, "package.json")
    if (!fs.existsSync(pjPath)) return
    scanned++
    let pj
    try { pj = readJsonNoBom(pjPath) } catch { return }
    if (!pj || !pj.dsh || !pj.dsh.client) return
    const name = pj.name || label
    declared.push(name)
    // ★ 判据纠正（2026-11-05，实测 32 个包全报缺 —— 是假警报）：
    //   实测 dsh.client 里**没有 entry 字段**，只有 { inject, platform }。
    //   而客户端代码普遍在 **lib/client.js**（子目录），不是顶层 client.js。
    //   所以正确做法是：**在包内递归找 client.js / client.mjs**，找不到才报。
    //   只在顶层找会把 32 个正常包全判成坏 —— 那正是「假警报淹掉真问题」。
    const want = (typeof pj.dsh.client === "string" && pj.dsh.client)
      || (pj.dsh.client && typeof pj.dsh.client.entry === "string" && pj.dsh.client.entry)
      || null
    const found = want ? fs.existsSync(path.join(dir, want)) : hasClientEntry(dir)
    if (!found) missing.push(name)
  }
  for (const e of fs.readdirSync(nm, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    if (e.name.startsWith("@")) {
      const scopeDir = path.join(nm, e.name)
      try {
        for (const s of fs.readdirSync(scopeDir, { withFileTypes: true })) {
          if (s.isDirectory()) scanPkgDir(path.join(scopeDir, s.name), e.name + "/" + s.name)
        }
      } catch {}
    } else {
      scanPkgDir(path.join(nm, e.name), e.name)
    }
  }
  if (declared.length === 0) {
    check('声明了 client 的包，client.js 都在', true, '扫了 ' + scanned + ' 个包，没有一个声明 dsh.client')
    return
  }
  check('声明了 client 的包，client.js 都在', missing.length === 0,
    missing.length ? missing.join("; ") : declared.length + " 个包声明了 dsh.client，入口文件都在",
    missing.length
      ? '这是坑 6（真实用户踩过）：客户端半缺失 → 面板/槽位全不出来，而宿主半一切正常。重装并检查 package.json 的 files'
      : '')
}

// ── 检查 5：PowerShell 执行策略能不能直接跑 .ps1（INSTALL.md 补记 2）───────
// ★ 起因（2026-10-22 实机）：用户直接 & .\install-desktop.ps1，被拦：
//   「无法加载文件 ... 因为在此系统上禁止运行脚本」(PSSecurityException / UnauthorizedAccess)
//   **脚本一行都没跑**，而症状看起来像脚本坏了。
//
//   正确跑法：powershell -ExecutionPolicy Bypass -File .\install-desktop.ps1
//   ★ 所以这条**不是失败，是「怎么跑」**：Bypass 一定能过。报 FAIL 会吓人。
//
//   但也不能不报 —— 因为「直接 &」是绝大多数人的第一反应。
//   报 WARN，把正确跑法写在提示里。
function checkPsPolicy() {
  if (process.platform !== "win32") {
    check('PowerShell 执行策略（只影响 Windows 的 .ps1 安装脚本）', true, '非 Windows，不适用')
    return
  }
  let out = ""
  try {
    out = execFileSync("powershell", ["-NoProfile", "-Command", "Get-ExecutionPolicy"], {
      encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    check('PowerShell 执行策略（只影响 Windows 的 .ps1 安装脚本）', true, '查不到（PowerShell 不可用？），跳过')
    return
  }
  const ok = /^(Bypass|Unrestricted)$/i.test(out)
  const howto = "正确跑法：powershell -ExecutionPolicy Bypass -File .\\install-desktop.ps1  " +
    "（Bypass 只对这一条命令生效，不改系统设置）。" +
    "★ 判据：看输出里有没有「dsh-agent-soul - desktop install」这行标题 —— 没有就是没跑起来"
  check('PowerShell 执行策略允许直接跑 .ps1', ok,
    "当前：" + (out || "(空)") + (ok ? " — 可以直接 & .\\install-desktop.ps1" : " — 直接 & 会被拦，脚本一行都不会跑"),
    ok ? "" : howto,
    "warn")
}

// ── 跑 ─────────────────────────────────────────────────────────────────────
checkPnpm()
checkServiceCollision()
checkCopyFresh()
checkClientJs()
checkPsPolicy()

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
