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
import { join, resolve, dirname } from 'node:path'
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
  let dir = profile
  for (let i = 0; i < 4; i++) {
    const candidate = join(dir, 'node_modules', name)
    if (await exists(candidate)) return candidate
    const up = resolve(dir, '..')
    if (up === dir) break
    dir = up
  }
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
    bad(name, '在 bundles 里，但往上找到 4 层都没找到这个目录')
    console.log(`  ✗ ${name}  找不到（profile 及其上 4 层 node_modules 都没有）`)
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
  if (!patchRel) {
    // 不是错误：内置包（dsh-base 之类）本来就不带 patch
    console.log(`  · ${name}  没有 dsh.bundle.patch（正常，如果它是内置包或被别人 patch）`)
    continue
  }
  const patchPath = join(dir, patchRel)
  if (!(await exists(patchPath))) {
    bad(name, `package.json 声明了 patch: ${patchRel}，但文件不存在`)
    console.log(`  ✗ ${name}  patch 文件不存在: ${patchRel}`)
    continue
  }
  const text = await readFile(patchPath, 'utf8')
  const body = text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l) && l.trim() !== '')
    .join('\n')

  // ★ 判据 ③：只有 insert 是合法形状；update/remove 之类根本不存在
  if (/^\s*-\s*insert\s*:/m.test(body)) {
    pass(name, 'patch 用 insert（合法形状）')
    console.log(`  ✓ ${name}  patch = insert`)
  } else if (/^\s*-\s*(update|remove|replace)\s*:/m.test(body)) {
    bad(
      name,
      'patch 用了 update/remove/replace —— **这些关键字不存在**，会被当成 overrides 键，' +
        '报 "id is required for non-insert patches"'
    )
    console.log(`  ✗ ${name}  patch 用了不存在的关键字`)
  } else {
    caution(name, 'patch 形状认不出来（既不是 insert 也不是已知的错法）')
    console.log(`  ? ${name}  patch 形状认不出来`)
  }

  // ★ 判据：patch 里改 name 会被一致性校验拒绝
  if (/name\s*:/.test(body) && !/^\s*-\s*insert\s*:/m.test(body)) {
    caution(name, '非 insert 的 patch 里出现了 name —— 会被 name 一致性校验 skip')
  }
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
    bad(name, '依赖声明了 ' + spec + '，但往上找到 4 层都没找到副本')
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
console.log('★ 这个脚本**验不到**两件事，必须真跑：')
console.log('   ① 兜底压缩用的是不是本包的类 → 跑一次压缩，看 checkpoint 前有没有 log:... 指针块')
console.log('   ② 客户端半的 UI 真渲染了没有 → 开浏览器看，不是看 Host 报 running')
console.log('')

process.exit(fail.length ? 1 : 0)
