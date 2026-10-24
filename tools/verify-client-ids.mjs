#!/usr/bin/env node
/**
 * verify-client-ids.mjs —— 装之前 / 启动之前，先把「注册 id 撞车」查出来
 *
 * 为什么有这个东西
 * ----------------
 * 2026-10-22 一位用户两次启动都失败（两份 crash log，pid 与 rev 都变了、错误一字不差）：
 *
 *     Error: web boot: 1 entry did not activate
 *     dsh-agent-echo: import failed
 *     client-modules: duplicate factory registration for "dsh-yanqing-echo"
 *       (bundle executed twice without invalidate?)
 *
 * 根因不是「id 应该等于包名」这种审美问题 —— 是 **同一个 id 被注册了两次**。
 * 客户端半的 `__ModuleLoader__.load({ id })` 里那个 id 是 factory 的键，
 * 第二次注册直接抛异常 → 整个 entry 不激活 → web boot 报「1 entry did not activate」。
 *
 * 而 DSH 的错误只告诉你「撞了哪个 id」，**不告诉你「是哪两个撞的」** ——
 * 用户拿着那句话无从下手。这个脚本补的就是那半句。
 *
 * 用法
 * ----
 *   node verify-client-ids.mjs                      # 扫本机所有 profile
 *   node verify-client-ids.mjs <目录> [<目录> ...]   # 扫指定目录
 *   node verify-client-ids.mjs --json               # 机器可读
 *
 * 退出码：0 = 无重复；1 = 发现重复；2 = 用法错误
 *
 * 判据（三条，都来自实测）
 * ------------------------
 * ① **id 必须全局唯一。** 包名天然唯一，所以 id := 自己的 package.json name 是最省事的做法。
 * ② **「id ≠ 包名」本身不是错**（官方包就是这样：id 是 `@deepseek-ai/dsh-client-modules`，
 *    包名也是它——这类是一致的；而有些包故意用短 id）。**只有重复才是错。**
 * ③ **同一个包出现在两个 profile 里不算重复** —— 它们从不在同一个进程里同时加载。
 *    所以按 profile 分组比，不跨 profile 比。
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { homedir } from 'node:os'

const argv = process.argv.slice(2)
const JSON_OUT = argv.includes('--json')
const roots = argv.filter((a) => !a.startsWith('--'))

// id 这一行可能在 __ModuleLoader__.load({ ... }) 里，也可能缩进各异；
// 只认「独立成行、以 id: "..." 开头」的那一处，避免误抓组件里的同名字段。
const ID_RE = /^[ \t]*id[ \t]*:[ \t]*["']([^"']+)["']/m

/** 默认扫这些地方：所有 profile 的 node_modules（含插件自带 plugins/ 子目录）。 */
function defaultRoots() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const out = []
  const profiles = join(home, 'profiles')
  if (existsSync(profiles)) out.push(profiles)
  // 桌面端把 home 放在别处的情况：再试几个常见位置
  for (const guess of [join(homedir(), 'AppData', 'Roaming', 'DeepSeek Harness', 'profiles')]) {
    if (existsSync(guess)) out.push(guess)
  }
  return out
}

/** 递归找 client.js，但跳过明显无关的重目录。 */
async function* walkClientJs(dir, depth = 0) {
  if (depth > 8) return
  let ents
  try {
    ents = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of ents) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === '.git' || e.name === '.cache' || e.name.startsWith('.')) continue
      yield* walkClientJs(p, depth + 1)
    } else if (e.name === 'client.js') {
      yield p
    }
  }
}

async function readPkgName(dir) {
  const pj = join(dir, 'package.json')
  try {
    return JSON.parse(await readFile(pj, 'utf8')).name || ''
  } catch {
    return ''
  }
}

async function scan(root) {
  const found = []
  for await (const cli of walkClientJs(root)) {
    const size = (await stat(cli).catch(() => ({ size: 0 }))).size
    if (size === 0) continue
    const text = await readFile(cli, 'utf8').catch(() => '')
    const m = ID_RE.exec(text)
    if (!m) continue // 不是 ModuleLoader 形态的 client.js，跳过（例如被压缩过的）
    found.push({
      id: m[1],
      pkg: await readPkgName(join(cli, '..')),
      dir: resolve(cli, '..'),
      path: resolve(cli),
    })
  }
  return found
}

const groups = new Map() // root -> entries
for (const r of roots.length ? roots : defaultRoots()) {
  const abs = resolve(r)
  if (!existsSync(abs)) continue
  groups.set(abs, await scan(abs))
}

const problems = []
for (const [root, entries] of groups) {
  // 只有「真正可能同时加载」的才算撞：同一个 node_modules 树里的包
  const byId = new Map()
  for (const e of entries) {
    // 同一个包可能被 pnpm 硬链接出多份路径 —— 用「id + 包名」去重，
    // 真正要抓的是「不同包用了同一个 id」
    const key = e.id
    const prev = byId.get(key)
    if (!prev) byId.set(key, [e])
    else if (!prev.some((x) => x.pkg === e.pkg)) prev.push(e)
    else prev.push(e) // 同包多路径，也记着，后面按 pkg 去重判断
  }
  for (const [id, list] of byId) {
    const uniqPkgs = [...new Set(list.map((x) => x.pkg || '(无包名)'))]
    if (uniqPkgs.length > 1) {
      problems.push({ root, id, pkgs: uniqPkgs, entries: list })
    }
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: problems.length === 0, problems }, null, 2))
} else {
  console.log('client.js 注册 id 自检\n')
  if (groups.size === 0) {
    console.log('  ★ 没找到任何 profile 目录。手动指定：')
    console.log('    node verify-client-ids.mjs <DSH home>/profiles')
    process.exit(2)
  }

  for (const [root, entries] of groups) {
    const ids = new Set(entries.map((e) => e.id))
    console.log(`  ${root}`)
    console.log(`    ${entries.length} 个 client.js，${ids.size} 个不同 id`)
  }

  console.log('')
  if (problems.length === 0) {
    console.log('  ✓ 没有重复注册。')
  } else {
    console.log(`  ★ 发现 ${problems.length} 处重复注册 —— 这就是 "duplicate factory registration" 的来源：\n`)
    for (const p of problems) {
      console.log(`    id = "${p.id}"`)
      console.log(`      被 ${p.pkgs.length} 个不同的包同时占用：`)
      for (const e of p.entries) {
        console.log(`        pkg=${e.pkg || '(无包名)'}`)
        console.log(`          ${e.path}`)
      }
      console.log('')
    }
    console.log('  修法：让每个包的 client.js 用自己的 package.json name 当 id（包名天然唯一）。')
    console.log('        改完必须重启 DSH —— 客户端入口图是启动时一次性组合的。')
  }
}

process.exit(problems.length === 0 ? 0 : 1)
