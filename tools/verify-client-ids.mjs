#!/usr/bin/env node
/**
 * verify-client-ids.mjs —— 装之前 / 启动之前，把「客户端半会炸」的两种情况一次查完
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
 * 而 DSH 的错误只告诉你「撞了哪个 id」，**不告诉你「是哪两个撞的」** ——
 * 用户拿着那句话无从下手。这个脚本补的就是那半句。
 *
 * ★★★ 2026-10-26 补上第二半：id 必须等于包名
 * --------------------------------------------
 * 那天换气升级部署后，桌面端直接弹「应用无法启动」，全界面进不去。错误是：
 *
 *     loaded without registering ... via __ModuleLoader__.load
 *
 * 根因：client-modules 拿 **package.json 的 name** 当 key 去对注册表，
 * 而那个包的 client.js 里 id 写的是别的值 → 宿主按 name 找不到它 → 整个 web boot 批次不激活。
 *
 * ★ 所以原来那句注释「id ≠ 包名本身不是错」是**错的**，已删。正确的判据是两条：
 *   ① id 必须全局唯一（否则 duplicate factory registration）
 *   ② id 必须等于自己 package.json 的 name（否则 loaded without registering）
 *
 * ★ 这个错最阴的地方：**仓库里 id 与 name 各自都对**，本地怎么查都没事；
 *   错只发生在「把仓库文件拷进一个名字不同的部署目录」那一步。
 *   而 `node --check` 也查不出来 —— 它是语法检查，不是配对检查。
 *
 * 用法
 * ----
 *   node verify-client-ids.mjs                      # 扫本机所有 profile
 *   node verify-client-ids.mjs <目录> [<目录> ...]   # 扫指定目录
 *   node verify-client-ids.mjs --json               # 机器可读
 *   node verify-client-ids.mjs --strict             # 把「别人的包 id ≠ 包名」也当失败
 *
 * 退出码：0 = 通过；1 = 发现问题；2 = 用法错误
 *
 * 三档判据（按严重程度）
 * ----------------------
 * ① **error · id 重复**：同一个 id 被两个不同包占用 → duplicate factory registration。
 * ② **error · 我们的包 id ≠ 包名**：包名以 `dsh-yanqing-` / `dsh-agent-` 开头（我们自己的件）
 *    → 一律算错。2026-10-26 崩的就是这两个。
 * ③ **warn · 别人的包 id ≠ 包名**：可能是官方包用了短 id。
 *    这类只报出来让人看，不判失败 —— 除非加 `--strict`。
 *
 * 为什么 ② 和 ③ 分开：我们无法确知所有第三方包的真实加载语义，
 * 误报会让人开始无视这个脚本。但**我们自己的件没有这个借口**。
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

const argv = process.argv.slice(2)
const JSON_OUT = argv.includes('--json')
const STRICT = argv.includes('--strict')
const roots = argv.filter((a) => !a.startsWith('--'))

/** 我们自己的包名前缀 —— 这些件的 id 必须严格等于包名。 */
const OURS = ['dsh-yanqing-', 'dsh-agent-']

// id 这一行可能在 __ModuleLoader__.load({ ... }) 里，也可能缩进各异；
// 只认「独立成行、以 id: "..." 开头」的那一处，避免误抓组件里的同名字段。
const ID_RE = /^[ \t]*id[ \t]*:[ \t]*["']([^"']+)["']/m

/** 默认扫这些地方：所有 profile 的 node_modules（含插件自带 plugins/ 子目录）。 */
function defaultRoots() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const out = []
  const profiles = join(home, 'profiles')
  if (existsSync(profiles)) out.push(profiles)
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

const dupes = []
const mismatch = []

for (const [root, entries] of groups) {
  // 只有「真正可能同时加载」的才算撞：同一个 node_modules 树里的包
  const byId = new Map()
  for (const e of entries) {
    const prev = byId.get(e.id)
    if (!prev) byId.set(e.id, [e])
    else prev.push(e)
  }
  for (const [id, list] of byId) {
    const uniqPkgs = [...new Set(list.map((x) => x.pkg || '(无包名)'))]
    if (uniqPkgs.length > 1) {
      dupes.push({ root, id, pkgs: uniqPkgs, entries: list })
    }
  }

  for (const e of entries) {
    if (!e.pkg) continue         // 没有 package.json，无从比，跳过
    if (e.id === e.pkg) continue // ✓ 一致
    mismatch.push({
      root,
      id: e.id,
      pkg: e.pkg,
      path: e.path,
      ours: OURS.some((p) => e.pkg.startsWith(p)),
    })
  }
}

const hardMismatch = mismatch.filter((m) => m.ours || STRICT)
const softMismatch = mismatch.filter((m) => !m.ours && !STRICT)

const failed = dupes.length > 0 || hardMismatch.length > 0

if (JSON_OUT) {
  console.log(JSON.stringify({
    ok: !failed,
    duplicates: dupes,
    idNotEqualPkg: { hard: hardMismatch, warn: softMismatch },
  }, null, 2))
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
  if (dupes.length === 0) {
    console.log('  ✓ ① 没有重复注册。')
  } else {
    console.log(`  ✗ ① 发现 ${dupes.length} 处重复注册 —— "duplicate factory registration" 的来源：\n`)
    for (const p of dupes) {
      console.log(`    id = "${p.id}"`)
      console.log(`      被 ${p.pkgs.length} 个不同的包同时占用：`)
      for (const e of p.entries) {
        console.log(`        pkg=${e.pkg || '(无包名)'}`)
        console.log(`          ${e.path}`)
      }
      console.log('')
    }
  }

  if (hardMismatch.length === 0) {
    console.log('  ✓ ② 我们自己的包，id 都等于包名。')
  } else {
    console.log(`  ✗ ② 我们自己的包里有 ${hardMismatch.length} 个 id ≠ 包名：\n`)
    for (const m of hardMismatch) {
      console.log(`    id  = "${m.id}"`)
      console.log(`    pkg = "${m.pkg}"`)
      console.log(`          ${m.path}`)
      console.log('      → 这会让 web boot 报 "loaded without registering"，界面弹「应用无法启动」')
      console.log('')
    }
  }

  if (softMismatch.length > 0) {
    console.log(`  ⚠ ③ 别人的包里有 ${softMismatch.length} 个 id ≠ 包名（可能是官方短 id，仅供参考）：`)
    for (const m of softMismatch.slice(0, 12)) {
      console.log(`    id="${m.id}"  pkg="${m.pkg}"`)
      console.log(`      ${m.path}`)
    }
    if (softMismatch.length > 12) console.log(`    … 还有 ${softMismatch.length - 12} 个`)
    console.log('    （想把这些也当失败，加 --strict）')
  }

  if (failed) {
    console.log('')
    console.log('  修法：让每个包的 client.js 用自己的 package.json name 当 id。')
    console.log('        ★ 两边是一对，改一边必须改另一边 —— 只拷 client.js 会造成 id≠name。')
    console.log('        改完必须重启 DSH —— 客户端入口图是启动时一次性组合的。')
  }
}

process.exit(failed ? 1 : 0)
