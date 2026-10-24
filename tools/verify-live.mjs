#!/usr/bin/env node
/**
 * verify-live.mjs —— 「装完怎么知道它活了」的可执行版
 * ====================================================
 *
 * ★ 为什么要有这个脚本
 * --------------------
 * README 里那句话是判据：**「文件复制过去了」不是判据。**
 * 但「判据」如果只能靠人肉去翻日志、去制造一次压缩，那它就不会被执行。
 *
 * 这个脚本只做一件事：**对一个 profile 逐条回答「这个东西真的在干活吗」。**
 * 它不安装、不改任何东西，只读。
 *
 * ★ 用法
 * ------
 *   node tools/verify-live.mjs --profile <profile 目录>
 *   node tools/verify-live.mjs --profile D:/AI/dsh-demo/profiles/agent-soul-demo
 *
 * ★ 它查什么（每条都给「判据 / 怎么查 / 结论」三段）
 * --------------------------------------------------
 *  ① **层有没有进去** —— profile 的 package.json → dsh.profile.bundles
 *  ② **包有没有带 patch** —— 每个 bundle 包的 dsh.bundle.patch 指向的文件在不在
 *  ③ **替换成没成** —— patch 的内容是不是 insert（不是 update —— update 不存在）
 *  ④ **源码与副本一致吗** —— pnpm 的 file: 是复制不是链接，改了源要重装
 *  ⑤ **marker 是哪个** —— pruner 的证据在 marker 字符串里
 *
 * ★ 它**不查**什么（说清楚，免得当成万能）
 * --------------------------------------
 *  · 不查「兜底压缩到底用没用到你那个类」—— 那要跑一次真实压缩，
 *    判据是 checkpoint 前有没有 `log:<会话>#seq=<n>` 指针块。
 *    这一步**只能真跑**，脚本给不了。
 *  · 不查 UI 渲染 —— 那要开浏览器看。
 */

import { readFile, access, readdir } from 'node:fs/promises'
// ★ 2026-10-25：`statSync` 要显式导入。写漏了会被那一处的 try/catch 吞成「一律不命中」——
//   看着跑通了，其实新分支从未执行。**静默失效比报错更坏。**
import { statSync } from 'node:fs'
import { join, resolve, dirname, delimiter } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

const args = process.argv.slice(2)
const pIdx = args.indexOf('--profile')
const profileArg = pIdx >= 0 ? args[pIdx + 1] : null
if (!profileArg) {
  console.error('用法: node tools/verify-live.mjs --profile <profile 目录>')
  process.exit(2)
}
const profile = resolve(profileArg)

const ok = []
const warn = []
const fail = []

function pass(label, detail) {
  ok.push({ label, detail })
}
function caution(label, detail) {
  warn.push({ label, detail })
}
function bad(label, detail) {
  fail.push({ label, detail })
}

async function exists(p) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/**
 * ★ 找一个 bundle 包的实际位置 —— 要往**上层**找。
 *
 * 第一版只查 `<profile>/node_modules`，于是 `@deepseek-ai/dsh-base` 和
 * `dsh-web-app` 全报「找不到」—— 它们是**共享安装**的，住在
 * `<profiles>/node_modules`（profile 的上层），由 Node 的模块解析往上爬找到。
 * 这不是包缺失，是**我的判据漏了一层**。
 */
async function findBundleDir(name) {
  // ① profile 及其上 4 层 —— 局部安装和共享安装住这儿
  let dir = profile
  for (let i = 0; i < 4; i++) {
    const candidate = join(dir, 'node_modules', name)
    if (await exists(candidate)) return candidate
    const up = resolve(dir, '..')
    if (up === dir) break
    dir = up
  }

  // ② DSH 自己的安装目录 —— **全局安装时 shipped bundle 在这儿**。
  //
  // ★ 报告 v3 R5：`npm i -g @deepseek-ai/dsh` 之后，dsh-base / dsh-headless
  //   不在 profile 上层，于是这里报「找不到」—— 而包明明在，是我的搜索范围
  //   不包含它。**这条和 P1-13 是同一个坑的第二次**：上一次我加了「往上爬 4 层」
  //   治共享安装，这一次是全局安装。两次都错在「只想到一种装法」。
  const roots = []
  // ★ 2026-10-25 加（GitHub #4 第四节，yunchengyc 报）：把「可能的 app.asar 位置」单独记下来。
  //   桌面打包版把 @deepseek-ai/* 全封在 resources/app.asar 里，而**普通 node 的 fs
  //   读不进去**（只有 Electron 进程里的 fs 被补过 asar 支持）。所以那 4 个内置包
  //   （dsh-base / dsh-web-app 等）在搜索根里永远找不到 —— 旧版据此报「✗ 缺失」，
  //   而它们本来就在，只是住在一个 node 打不开的归档里。**「我找不到」≠「它不在」。**
  const asars = []
  try {
    // 进程可执行文件 -> 安装根（Electron 打包时 execPath 就是 DSH 的 exe）
    const exeDir = dirname(process.execPath)
    asars.push(join(exeDir, 'resources', 'app.asar'))
    // ★ 2026-10-25：跑本脚本的往往是**另一份** node（不是 DSH 的），execPath 就推不到安装根。
    //   桌面版 Windows 的标准安装位置再补一条；也可以用 DSH_APP_ASAR 显式指定。
    if (process.env.DSH_APP_ASAR) asars.push(process.env.DSH_APP_ASAR)
    if (process.env.LOCALAPPDATA) {
      asars.push(join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'))
    }
    roots.push(join(exeDir, 'node_modules'))
    roots.push(join(exeDir, 'resources', 'app.asar', 'node_modules'))
    roots.push(join(exeDir, 'resources', 'app.asar.unpacked', 'node_modules'))
    // POSIX 全局前缀：<prefix>/bin/node -> <prefix>/lib/node_modules
    roots.push(join(exeDir, '..', 'lib', 'node_modules'))
    // ★★ 再嵌一层（报告 v4 补的第 3 次同类错）：npm 全局装时
    //   shipped bundle 在 <prefix>/lib/node_modules/@deepseek-ai/dsh/node_modules/ 里。
    //   上面那条只到 lib/node_modules，下面只有 dsh 一个包，**还差一层**。
    roots.push(join(exeDir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'))
  } catch { /* 推不出来就跳过，别把验证搞挂 */ }
  try {
    // 让 Node 自己解析一次：能解析到就说明它真的可加载
    const req = createRequire(import.meta.url)
    const pj = req.resolve('@deepseek-ai/dsh/package.json')
    roots.push(join(dirname(pj), 'node_modules'))
    roots.push(join(dirname(pj), '..', 'node_modules'))
  } catch { /* 解析不到说明这条路不适用 */ }
  // ★★★ 2026-10-24 补：上面的根全部从 `process.execPath` 推 —— 这假设
  //   「跑本脚本的 node 就是 DSH 的 node」。用别的 node 跑就会推错。
  //   实测症状（本机）：明明装好的包，脚本报「所有搜索根里都没有这个目录」，
  //   并列出 22 个全是 <node 安装目录> 的路径 —— 和 echo 那个 execPath 同一个病。
  //   所以再从 **profile 位置**往上反推 DSH 安装根（profile 通常在 <DSH_ROOT>\home\profiles\<name>）。
  try {
    let cur = profile
    for (let i = 0; i < 6 && cur; i++) {
      roots.push(join(cur, 'node_modules'))
      asars.push(join(cur, 'resources', 'app.asar'))
      roots.push(join(cur, 'resources', 'app.asar', 'node_modules'))
      roots.push(join(cur, 'resources', 'app.asar.unpacked', 'node_modules'))
      const up = dirname(cur)
      if (!up || up === cur) break
      cur = up
    }
  } catch { /* 推不出来就跳过 */ }

  // ★ 允许外部补根（本机测特殊布局用；也给了给特殊安装兜底的口子）。
  //   POSIX 用 : 分隔，Windows 用 ; —— 两种都认。
  // ★ 用 path.delimiter，不要手写 /[;:]/ —— Windows 路径里本身就有冒号，
  //   写成 /[;:]/ 会把 C:\...\ 切成 'C' 和 '\...'，根全废。
  //   （这个 bug 是我自己刚踩的，测的时候才发现。）
  for (const r of String(process.env.DSH_LIVE_EXTRA_ROOTS || '').split(delimiter)) {
    if (r.trim()) roots.push(r.trim())
  }

  const tried = []
  // ★ 把 asar 候选挂到函数上，和 lastTried 同一个路子 —— ② 那段在模块顶层，
  //   拿不到函数里的局部变量。（第一版写成直接引用 `asars`，实测直接
  //   `ReferenceError: asars is not defined` 把整个脚本崩掉：宁可炸，也不要静默失效。）
  findBundleDir.asars = asars
  for (const r of roots) {
    const candidate = join(r, name)
    tried.push(candidate)
    if (await exists(candidate)) return candidate
    // ★★ 同一个包里**还嵌着一层 node_modules** 的情形（npm 全局装的常见形状）。
    //   不写死某一个包名 —— 把 root 下的一层包目录都探一遍，但要限个数，
    //   别把一个有几百个包的 node_modules 整个遍历。
    for (const inner of ['@deepseek-ai/dsh', 'dsh', '@deepseek-ai/dsh-cli']) {
      const nested = join(r, inner, 'node_modules', name)
      tried.push(nested)
      if (await exists(nested)) return nested
    }
  }
  // ★ 找不到时把**试过的路径**留着，让调用方能原样打出来。
  //   报告是要靠这个来指方向的 —— 只写「都没有」，读的人不知道我找过哪。
  findBundleDir.lastTried = tried
  return null
}

// ── ① profile 存在吗 ───────────────────────────────────────────
let pkg
try {
  pkg = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
} catch (e) {
  console.error('★ profile 读不到: ' + profile)
  console.error('   ' + (e && e.message))
  process.exit(2)
}

const bundles = pkg?.dsh?.profile?.bundles || []
const deps = pkg.dependencies || {}
console.log('profile : ' + profile)
console.log('bundles : ' + (bundles.length ? bundles.join(', ') : '(空)'))
console.log('')

// ── ② 每个 bundle：包装了没 / 带 patch 没 ─────────────────────
console.log('── ② 每个 bundle 的 patch 状态 ' + '─'.repeat(30))
for (const name of bundles) {
  const dir = await findBundleDir(name)
  if (!dir) {
    // ★ 2026-10-25 修假失败（GitHub #4 第四节）：内置包住在 app.asar 里，普通 node 读不到。
    //   旧版把它们报成「✗ 缺失 4 条」，而它们本来就在 —— 一个把人引去「重装内置包」的假失败。
    //   ★ 判据只写在能确证的那一半：「有 app.asar」+「名字是 @deepseek-ai/ 命名空间」
    //     ⇒ 归为内置、本项不验。**不假装验过，也不谎报缺失。**
    const isScoped = /^@deepseek-ai\//.test(name)
    const asarHit = (findBundleDir.asars || []).find((a) => { try { return statSync(a).isFile() } catch { return false } })
    if (isScoped && asarHit) {
      console.log(`  · ${name}  内置包（在 ${asarHit} 里）—— 普通 node 打不开 asar，此项跳过，不算缺失`)
      continue
    }
    bad(name, '在 bundles 里，但所有搜索根里都没有这个目录')
    console.log(`  ✗ ${name}  找不到。试过这些位置：`)
    for (const t of findBundleDir.lastTried || []) console.log('      ' + t)
    continue
  }
  let p
  try {
    p = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  } catch {
    bad(name, 'package.json 读不到')
    console.log(`  ✗ ${name}  package.json 读不到`)
    continue
  }
  const patchRel = p?.dsh?.bundle?.patch

  // ★★ `dsh.bundle.patch` 可能是**字符串**，也可能是**数组**
  //   （报告 P2-7：@deepseek-ai/dsh-web-app 就是 5 个文件）。
  //
  //   原来这里直接 join(dir, patchRel) —— 遇到数组抛：
  //     TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string.
  //     Received an instance of Array
  //   后果不是「这项没验」，是**整个脚本崩掉**：任何 web profile 都跑不了后面所有检查。
  //   而桌面端正是 web 形态 —— 等于这个工具在它最该有用的场合失效。
  //
  //   ★ 这也是我第二次栽在「字段的类型比我以为的宽」：上一次是 §8b 的
  //   `dsh.profile.bundles` 写成对象被静默跳过。同一个形状的错误，
  //   所以这次把它写成「一律先归一成数组」。
  const patchList = Array.isArray(patchRel) ? patchRel : patchRel ? [patchRel] : []
  if (patchList.length === 0) {
    // 不是错误：内置包（dsh-base 之类）本来就不带 patch
    console.log(`  · ${name}  没有 dsh.bundle.patch（正常，如果它是内置包或被别人 patch）`)
    continue
  }

  let missingOne = null
  let badKeyword = null
  let unknownShape = null
  let nonInsertWithName = null
  for (const rel of patchList) {
    const patchPath = join(dir, rel)
    if (!(await exists(patchPath))) {
      missingOne = rel
      break
    }
    const text = await readFile(patchPath, 'utf8')
    const body = text
      .split('\n')
      .filter((l) => !/^\s*#/.test(l) && l.trim() !== '')
      .join('\n')
    // ★ 判据 ③：只有 insert 是合法形状；update/remove 之类根本不存在
    if (/^\s*-\s*insert\s*:/m.test(body)) continue
    if (/^\s*-\s*(update|remove|replace)\s*:/m.test(body)) {
      badKeyword = rel
      break
    }
    unknownShape = rel
    // ★ 判据：非 insert 的 patch 里出现 name 会被一致性校验 skip。
    //   （这段原来写在外层、而且在 pass 之后 —— 永远跑不到。搬进来才真的判得到。）
    if (/name\s*:/.test(body)) nonInsertWithName = rel
  }

  const howMany = patchList.length > 1 ? `（共 ${patchList.length} 个 patch 文件）` : ''
  if (missingOne) {
    bad(name, `package.json 声明了 patch: ${missingOne}，但文件不存在`)
    console.log(`  ✗ ${name}  patch 文件不存在: ${missingOne}`)
    continue
  }
  if (badKeyword) {
    bad(
      name,
      `patch ${badKeyword} 用了 update/remove/replace —— **这些关键字不存在**，` +
        '会被当成 overrides 键，报 "id is required for non-insert patches"'
    )
    console.log(`  ✗ ${name}  patch 用了不存在的关键字: ${badKeyword}`)
    continue
  }
  if (unknownShape) {
    // ★ 如果里面还改了 name，后果更具体：会被 name 一致性校验直接 skip
    if (nonInsertWithName) {
      caution(
        name,
        `patch ${nonInsertWithName} 既不是 insert、又改了 name —— 会被 name 一致性校验 skip`,
      )
      console.log(`  ? ${name}  非 insert 且改了 name: ${nonInsertWithName}`)
    } else {
      caution(name, `patch ${unknownShape} 形状认不出来（既不是 insert 也不是已知的错法）`)
      console.log(`  ? ${name}  patch 形状认不出来: ${unknownShape}`)
    }
    continue
  }
  pass(name, `patch 用 insert（合法形状${howMany}）`)
  console.log(`  ✓ ${name}  patch = insert${howMany}`)
}

// ── ④ 源码 vs 副本 ────────────────────────────────────────────
console.log('')
console.log('── ④ 源码与 profile 副本是否一致 ' + '─'.repeat(26))
for (const name of deps ? Object.keys(deps) : []) {
  const spec = String(deps[name] || '')
  if (!spec.startsWith('file:')) continue
  const src = resolve(profile, spec.slice(5))
  const dst = await findBundleDir(name)
  if (!dst) {
    bad(name, '依赖声明了 ' + spec + '，但所有搜索根里都没有副本')
    console.log(`  ✗ ${name}  副本缺失`)
    continue
  }
  // 比 package.json 就够了 —— 它是每个包都有的锚点
  let same = null
  try {
    const a = await readFile(join(src, 'package.json'), 'utf8')
    const b = await readFile(join(dst, 'package.json'), 'utf8')
    same = a === b
  } catch {
    same = null
  }
  if (same === true) {
    pass(name, '副本与源一致')
    console.log(`  ✓ ${name}  副本与源一致`)
  } else if (same === false) {
    caution(
      name,
      '副本与源**不一致** —— pnpm 的 file: 是复制不是链接，' +
        '改了源必须重新 `dsh plugin add` 才会刷新'
    )
    console.log(`  ! ${name}  副本与源不一致（改了源要重装）`)
  } else {
    caution(name, '比对失败（源或副本读不到）')
    console.log(`  ? ${name}  比对失败`)
  }
}

// ── ⑤ pruner 的 marker ───────────────────────────────────────
console.log('')
console.log('── ⑤ pruner 的 marker 是哪一个 ' + '─'.repeat(28))
const basePruner = join(profile, '..', 'node_modules', '@deepseek-ai', 'dsh-compaction-tool-result-pruner', 'lib', 'index.js')
const OUR_STATIC = '[... tool result middle pruned ...]'
if (await exists(basePruner)) {
  const t = await readFile(basePruner, 'utf8')
  if (t.includes(OUR_STATIC)) {
    console.log('  内置 pruner 的 marker: "' + OUR_STATIC + '"')
    console.log('  → 判断本包是否生效：跑一次大工具输出，看被裁掉的那块用的是')
    console.log('     静态 marker（内置赢）还是带 log:<会话>#seq=<n> 的版本（本包赢）')
    caution(
      'pruner 生效与否',
      '只能靠一次真实裁剪来判：静态 marker = 内置赢；带 seq = 本包赢'
    )
  }
} else {
  console.log('  内置 pruner 不在预期位置，跳过')
}

// ── 汇总 ─────────────────────────────────────────────────────
console.log('')
console.log('═'.repeat(60))
console.log(`通过 ${ok.length}   需注意 ${warn.length}   失败 ${fail.length}`)
if (fail.length) {
  console.log('')
  console.log('★ 失败项:')
  for (const f of fail) console.log('  ✗ ' + f.label + ': ' + f.detail)
}
if (warn.length) {
  console.log('')
  console.log('★ 需注意:')
  for (const w of warn) console.log('  ! ' + w.label + ': ' + w.detail)
}
console.log('')
console.log('★ 这个脚本验不到、但可以另跑的：')
console.log('   ① 兜底压缩用的是不是本包的类')
console.log('      → 跑 tools/soul-probe（boot 后读 ctx.get("compaction")，看 ctor 是不是 YanqingCompaction）')
console.log('         ★ 判读看日志里有没有 [register]（报告 v3 R3）：')
console.log('           没有 [register] → compaction 服务不存在（探针声明了 inject，服务不在就不加载）')
console.log('           有 [register] 没有 [result] → 探针自己出错，不是压缩没接管')
console.log('           有 [result] → 看 ctor：Yanqing… 是接管了，Basic… 是没接管')
console.log('      ★ 别再写成「跑一次压缩看门牌」—— 那要 88 万 token 才触发，空会话造不出来')
console.log('   ② 客户端半的 UI 真渲染了没有 → 开浏览器看，不是看 Host 报 running')
console.log('   ③ pruner 生效与否 → 只能靠一次真实裁剪：静态 marker = 内置赢，带 seq = 本包赢')
console.log('')

process.exit(fail.length ? 1 : 0)
