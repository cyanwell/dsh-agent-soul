#!/usr/bin/env node
/**
 * soul-doctor.mjs —— 分三层体检：L0 地基 / L1 能力 / L2 装配
 *
 * 为什么分三层
 * ------------
 * 26 条用户反馈里最贵的一条教训是：「装完了、体检全绿、就是不工作」。
 * 那些绿是因为检查项只查了「文件在不在」，没查「上游认不认它」。
 *
 * 所以这个脚本按**依赖顺序**分层，每层只查一件事：
 *
 *   L0 地基   DSH 装没装对、profile 存在不存在、package.json 能不能解析
 *             ★ 这一层错，后面两层全白查
 *   L1 能力   零件包能不能 resolve —— 不是「目录在不在」，是 node 能不能 require 到
 *             ★ 这一层错，UI 上会显示红标，或者零件静默不加载
 *   L2 装配   preset 块在不在、三件套齐不齐、registry 指向对不对
 *             ★ 这一层错，picker 里看不到 preset
 *
 * 用法
 * ----
 *   node tools/soul-doctor.mjs                 # 三层全查，人看
 *   node tools/soul-doctor.mjs --json          # 机器读（给 agent 用）
 *   node tools/soul-doctor.mjs --layer L1      # 只查一层
 *   node tools/soul-doctor.mjs --profile web   # 换 profile（默认 desktop）
 *
 * 退出码：0 全过 / 1 有错 / 2 连 profile 都找不到
 *
 * 铁律
 * ----
 * 1. **只读。** 本脚本不写任何文件、不改任何配置 —— doctor 的职责是「说清现状」
 * 2. **每项必须能真跑。** 写进这里的检查，都是在本机实测过会成立/会失败的
 * 3. **失败必须给下一步。** 只说「错了」不给方向的体检，用户照样卡住
 * 4. 不解析 YAML —— 同 soul-preset.mjs，文件里有 !!js 这种 loader 专有写法
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

// ★ 不猜 home 在哪（AGENTS 里的铁律：不知道就报，不拿默认值顶）。
//   原来这里兜底成 'D:/AI/dsh/home' —— 那是本机路径。别人机器上会去读一个
//   不存在的目录，于是 doctor 报「全是红的」，而真实原因只是工具指错了地方。
//   ★ 这种错不是崩溃，是「报出假的缺失」—— 比崩溃更难查。
const HOME = process.env.DSH_HOME || argOf('--home')
if (!HOME) {
  console.error('\n\u2717 \u627e\u4e0d\u5230 DSH home\u3002\u8bf7\u4e8c\u9009\u4e00\uff1a\n' +
    '  1) export DSH_HOME=<\u4f60\u7684 dsh home \u8def\u5f84>\n' +
    '  2) \u52a0\u53c2\u6570 --home <\u8def\u5f84>\n' +
    '  \uff08\u4e0d\u731c\uff0c\u662f\u56e0\u4e3a\u731c\u9519\u4f1a\u62a5\u51fa\u5047\u7684\u7f3a\u5931\uff09\n')
  process.exit(2)
}
const argOf = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null }
const PROFILE = argOf('--profile') || 'desktop'
const JSON_OUT = process.argv.includes('--json')
const ONLY = argOf('--layer')          // L0 / L1 / L2
const CMD = process.argv[2] || ''

if (CMD === '--help' || CMD === '-h') {
  console.log('node tools/soul-doctor.mjs [--json] [--profile desktop] [--layer L0|L1|L2]')
  process.exit(0)
}

const profileDir = join(HOME, 'profiles', PROFILE)
const patchPath = join(profileDir, 'cordis.patch.yml')
const pkgPath = join(profileDir, 'package.json')
const nmDir = join(profileDir, 'node_modules')

// ── 结果收集 ────────────────────────────────────────────────────
const results = []
function check(layer, id, name, fn) {
  if (ONLY && layer !== ONLY) return
  let r
  try { r = fn() } catch (e) { r = { ok: false, detail: `检查本身抛错：${e.message}`, hint: '这是 doctor 的 bug，不是你的环境问题' } }
  results.push({ layer, id, name, ...r })
}

// ═══════════════════════════════════════════════════════════════
// L0 地基 —— 错了后面全白查
// ═══════════════════════════════════════════════════════════════

check('L0', 'home', 'DSH_HOME 存在', () => {
  if (!existsSync(HOME)) return { ok: false, detail: `没有 ${HOME}`, hint: '设环境变量 DSH_HOME 指向 DSH 的 home 目录（默认安装位置在 %LOCALAPPDATA%\\Programs\\DeepSeek Harness）' }
  return { ok: true, detail: HOME }
})

check('L0', 'profile', 'profile 目录存在', () => {
  if (!existsSync(profileDir)) {
    const all = existsSync(join(HOME, 'profiles')) ? readdirSync(join(HOME, 'profiles')).join(', ') : '（profiles 目录都没有）'
    return { ok: false, detail: `没有 ${profileDir}；现有 profile: ${all}`, hint: `如果你的 profile 叫别的名字，用 --profile <名字> 重跑` }
  }
  return { ok: true, detail: profileDir }
})

check('L0', 'patch', 'cordis.patch.yml 存在', () => {
  if (!existsSync(patchPath)) return { ok: false, detail: `没有 ${patchPath}`, hint: '这个文件是 profile 的配置本体。全新 profile 可能还没生成 —— 先启动一次 DSH' }
  return { ok: true, detail: `${readFileSync(patchPath, 'utf8').length} 字符` }
})

check('L0', 'pkgjson', 'package.json 能 JSON.parse', () => {
  if (!existsSync(pkgPath)) return { ok: false, detail: `没有 ${pkgPath}`, hint: 'profile 缺少依赖清单' }
  const txt = readFileSync(pkgPath, 'utf8')
  // ★ 这条是实测过的：带 BOM 会让宿主 JSON.parse 直接崩，而桌面端表现是「启动即闪退」
  if (txt.charCodeAt(0) === 0xFEFF) return { ok: false, detail: '文件带 BOM', hint: '宿主 JSON.parse 会崩。用无 BOM UTF-8 重写这个文件' }
  try { JSON.parse(txt) } catch (e) { return { ok: false, detail: `JSON 解析失败：${e.message}`, hint: '手改过 package.json？补一个尾逗号或引号就能修' } }
  return { ok: true, detail: 'OK，无 BOM' }
})

check('L0', 'bundles', 'dsh.profile.bundles 是纯字符串数组', () => {
  if (!existsSync(pkgPath)) return { ok: false, detail: '跳过（没有 package.json）', hint: '' }
  let j
  try { j = JSON.parse(readFileSync(pkgPath, 'utf8')) } catch { return { ok: false, detail: '跳过（JSON 解析失败）', hint: '' } }
  const b = j?.dsh?.profile?.bundles
  // ★ 实测过的静默杀手：写成 {name:...,enabled:true} 会被**完全静默跳过** ——
  //   不报错、不日志、界面什么都没。所以这条必须专门查。
  if (!Array.isArray(b)) return { ok: false, detail: `不是数组（${typeof b}）`, hint: '必须是 ["dsh-riji"] 这种纯字符串数组；对象形式会被静默忽略' }
  const bad = b.filter((x) => typeof x !== 'string')
  if (bad.length) return { ok: false, detail: `${bad.length} 项不是字符串`, hint: '把对象改成包名字符串' }
  return { ok: true, detail: `${b.length} 个：${b.slice(0, 6).join(', ')}${b.length > 6 ? ' …' : ''}` }
})

// ═══════════════════════════════════════════════════════════════
// L1 能力 —— 零件能不能被解析到
// ═══════════════════════════════════════════════════════════════

// ★★ 双命名兼容（2026-10-30）：本机装的是 dsh-yanqing-*（专属命名空间），
//   发布版装的是 dsh-agent-*。两套都必须认，否则换一台机器就报「缺件」。
//   ★ 只列前缀、不拼全名 —— huanqi 的真名是 dsh-huanqi（没有 agent），
//   拼出来的 dsh-agent-huanqi 既不是它、也不在 bundles 里。
const SOUL_PARTS = ['compaction', 'compact-region', 'pruner', 'memory']
const PART_PREFIXES = ['dsh-agent-', 'dsh-yanqing-']
const partNames = (dir) => PART_PREFIXES.map((p) => p + dir)
const resolve = (name) => {
  // 和 soul-preset.mjs 保持同一口径：pnpm 的 @a/b 可能落成 @a+b
  const cands = [join(nmDir, name), join(nmDir, name.replace(/^@([^/]+)\/(.*)$/, '@$1+$2'))]
  return cands.find((p) => existsSync(p)) || null
}

check('L1', 'parts', '四个砚青零件都能 resolve', () => {
  if (!existsSync(nmDir)) return { ok: false, detail: `没有 node_modules（${nmDir}）`, hint: '先 `dsh plugin add` 装零件，或检查 profile 是否初始化过' }
  // ★ 每个目录只要有**任一前缀**的版本就够 —— 不要求两个前缀同时存在。
  const miss = SOUL_PARTS.filter((n) => !partNames(n).some((full) => resolve(full)))
  if (miss.length) return { ok: false, detail: `解析不到：${miss.map((m) => partNames(m).join(' / ')).join(', ')}`, hint: '这些包没装进这个 profile。装法见 AGENT-INSTALL.md 的 L1 一节' }
  return { ok: true, detail: `4/4 都在 ${nmDir}` }
})

check('L1', 'official', '地基层官方包在 profile 里可见（仅提示）', () => {
  // ★★ 2026-10-28 实测纠正：这一条**不能算失败**。
  //
  // 事实：dsh-yanqing-compaction/index.js 确实写了
  //   import { ... } from '@deepseek-ai/dsh-compaction-basic'
  // 而 profile 的 node_modules 里没有这个包（实测 @deepseek-ai 只有 9 个包，无 compaction 系列）。
  //
  // 但它一直在工作 —— 因为**宿主加载插件时用的是宿主自己的 resolve 上下文**
  // （app.asar 里有官方包），不是 profile 的 node_modules。
  //
  // 所以文件系统看不到它，是正常的。这一条只做**提示**：
  // 装上、UI 上零件却是红标，才说明宿主那边也没拿到。
  const want = ['@deepseek-ai/dsh-compaction-basic']
  const found = want.filter((n) => resolve(n))
  return {
    ok: true,
    detail: found.length
      ? `${found.length}/${want.length} 在 profile 里可见`
      : `${want[0]} 不在 profile 里 —— 正常。宿主从 app.asar 提供它，插件靠宿主解析`,
    hint: found.length ? '' : '如果 UI 上砚青零件显示红标，那才是真问题：说明宿主也没提供，需要等上游或改继承方式',
  }
})

check('L1', 'pkgintegrity', '已装插件的 package.json 自洽（files 覆盖相对 import）', () => {
  // ★★ 这条来自用户反馈（此胡桃 2026-10-24）的第一次「白名单漏一项静默失效」：
  //   npm 的 `files` 是「只发这些」不是「排除这些」—— 入口 import 了 './lib/x.js'
  //   而 files 没列 lib，装机后目录里就没有它，import 失败。
  //   症状：插件静默不生效，长得和「cordis 服务空窗」一模一样，查半天。
  if (!existsSync(nmDir)) return { ok: false, detail: `跳过（没有 node_modules）`, hint: '' }

  const broken = []
  let scanned = 0
  let dirs = []
  try { dirs = readdirSync(nmDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch { return { ok: false, detail: '读不了 node_modules', hint: '' } }

  for (const d of dirs) {
    const pkgFile = join(nmDir, d, 'package.json')
    if (!existsSync(pkgFile)) continue
    let j
    try { j = JSON.parse(readFileSync(pkgFile, 'utf8')) } catch { continue }
    const name = String(j.name || '')
    // ★★ 2026-10-28 实测纠正：第一版只过滤 `includes('dsh-')`，把 plugins-market / free-search
    //   这些**第三方包**也扫了，报出 51 处 —— 那些是「用 exports 字段而不是 main」的正常包，
    //   或者本来就靠构建产物发布的包。**它们不是我们的责任，报了只会淹没真问题。**
    //   现在只扫我们自己的零件。
    if (!name.startsWith('dsh-yanqing-') && !name.startsWith('dsh-agent-')) continue
    // ★ 同理：优先认 exports["."]，认不到才退回 main —— 现代包普遍用 exports。
    const exp = j.exports
    const expMain = typeof exp === 'string' ? exp : (exp && typeof exp === 'object' ? (exp['.'] || exp.default) : null)
    const main = (typeof expMain === 'string' ? expMain : null) || j.main || 'index.js'
    const entry = join(nmDir, d, main)
    if (!existsSync(entry)) { broken.push(`${name}: 入口 ${main} 不存在`); continue }
    scanned++

    // 找出入口里所有 './...' 相对 import，逐个确认文件在
    let src = ''
    try { src = readFileSync(entry, 'utf8') } catch { continue }
    const rels = [...new Set([...src.matchAll(/from\s+['"](\.\/[^'"]+)['"]/g)].map((m) => m[1]))]
    for (const r of rels) {
      const target = join(nmDir, d, r.replace(/^\.\//, ''))
      if (!existsSync(target)) {
        // ★ 关键判断：files 里有没有可能漏了它所在的目录
        const dirOfRel = r.replace(/^\.\//, '').split('/')[0]
        const filesField = Array.isArray(j.files) ? j.files : null
        const listed = !filesField || filesField.some((f) => f === dirOfRel || f.startsWith(dirOfRel + '/') || f === '*' )
        broken.push(`${j.name}: 入口 import '${r}' 但文件不存在${listed ? '' : `（files 里也没列 "${dirOfRel}" → 装机必丢）`}`)
      }
    }
  }

  if (broken.length) {
    return {
      ok: false,
      detail: `${broken.length} 处：${broken.slice(0, 4).join('；')}${broken.length > 4 ? ' …' : ''}`,
      hint: '这是「装机时不报错、运行时不加载」的典型。修法：在该包 package.json 的 files 里补上缺的目录，重装。',
    }
  }
  return { ok: true, detail: `扫描 ${scanned} 个包，入口与 files 自洽` }
})

check('L1', 'peerdeps', '插件包的 peerDependencies 覆盖了宿主包', () => {
  // ★★ 这条来自同一个反馈的第二次「白名单漏一项」。
  //   ★ 2026-10-31 更正：原来这里写「缺声明 ⇒ 插件不加载、且无 crash 日志」——
  //     外部实测把它推翻了：缺 peer 声明的 compaction **照常加载、而且接管成功了**
  //     （探针 ctor: YanqingCompaction）。所以后果不是「装不上」，
  //     而是「**装上了、直到某个分支真要 resolve 那个模块时才炸**」——
  //     这更隐蔽，所以才更值得查。这条用来防回归。
  if (!existsSync(nmDir)) return { ok: false, detail: '跳过（没有 node_modules）', hint: '' }

  const problems = []
  let scanned = 0
  let dirs = []
  try { dirs = readdirSync(nmDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch { return { ok: false, detail: '读不了 node_modules', hint: '' } }

  for (const d of dirs) {
    const pkgFile = join(nmDir, d, 'package.json')
    if (!existsSync(pkgFile)) continue
    let j
    try { j = JSON.parse(readFileSync(pkgFile, 'utf8')) } catch { continue }
    const name = String(j.name || '')
    if (!name.startsWith('dsh-yanqing-') && !name.startsWith('dsh-agent-')) continue
    scanned++

    // 源码里 import 了 @deepseek-ai/* 却没在 peerDependencies 里声明
    const main = j.main || 'index.js'
    const entry = join(nmDir, d, main)
    if (!existsSync(entry)) continue
    let src = ''
    try { src = readFileSync(entry, 'utf8') } catch { continue }
    const hostImports = [...new Set([...src.matchAll(/from\s+['"](@deepseek-ai\/[^'"]+)['"]/g)].map((m) => m[1]))]
    if (!hostImports.length) continue
    const peer = j.peerDependencies || {}
    const missing = hostImports.filter((h) => !(h in peer))
    if (missing.length) problems.push(`${name} 未声明 ${missing.join(', ')}`)
  }

  if (problems.length) {
    return {
      ok: false,
      detail: problems.join('；'),
      hint: '缺 peer 声明**不会**让插件装不上 —— 它会照常加载，直到某条分支真要 resolve 那个模块时才炸（更隐蔽）。补进该包的 peerDependencies。',
    }
  }
  return { ok: true, detail: `扫描 ${scanned} 个零件，peerDependencies 齐全` }
})

check('L1', 'nodever', 'node 版本够', () => {
  const m = process.versions.node.match(/^(\d+)\.(\d+)/)
  const major = Number(m?.[1] || 0)
  if (major < 20) return { ok: false, detail: `v${process.versions.node}`, hint: '这些脚本用了 node: 前缀的 ESM import，需要 18+；建议 20 或 22' }
  return { ok: true, detail: `v${process.versions.node}` }
})

// ═══════════════════════════════════════════════════════════════
// L2 装配 —— preset 装对了没
// ═══════════════════════════════════════════════════════════════

// ★ 三件套指的是**三个目录**，不是六个包名 —— 和 L1/parts 同口径：任一前缀即可。
//   原来这里是 `.flatMap(partNames)` 展开成 6 个名字、下游用 `includes` 要求【全部】出现，
//   而一个 preset 只会装一套命名空间（要么 dsh-agent-* 要么 dsh-yanqing-*），
//   于是这条路按设计**永远红**。（2026-10-31 外部实测报告指出，核实属实。）
const REQUIRED = ['compaction', 'compact-region', 'pruner']

function scanPresets(lines) {
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)-\s+id:\s*(preset-[\w.-]+)\s*$/)
    if (!m) continue
    const indent = m[1].length
    let end = lines.length
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*-\s+/.test(lines[j]) && lines[j].match(/^\s*/)[0].length <= indent) { end = j; break }
    }
    out.push({ id: m[2], start: i, end, body: lines.slice(i, end) })
  }
  return out
}

let presets = []
let patchRaw = ''
check('L2', 'presets', 'patch 里有 preset 块', () => {
  if (!existsSync(patchPath)) return { ok: false, detail: '跳过（没有 cordis.patch.yml）', hint: '' }
  patchRaw = readFileSync(patchPath, 'utf8')
  presets = scanPresets(patchRaw.split(/\r?\n/))
  if (!presets.length) {
    return {
      ok: false,
      detail: '0 个',
      hint: '0.2.0-rc.2 起 preset 是 profile 层声明，不再扫描 .agent-presets/ 目录。用 soul-preset.mjs export/build 装进去',
    }
  }
  return { ok: true, detail: `${presets.length} 个：${presets.map((p) => p.id).join(', ')}` }
})

check('L2', 'threeparts', '每个 preset 的三件套齐', () => {
  if (!presets.length) return { ok: false, detail: '跳过（没有 preset）', hint: '' }
  const namesIn = (body) => [...new Set([...body.join('\n').matchAll(/name:\s*['"]?(dsh-[\w.@/-]+)['"]?/g)].map((m) => m[1]))]
  const bad = []
  for (const p of presets) {
    const have = namesIn(p.body)
    const miss = REQUIRED.filter((dir) => !partNames(dir).some((full) => have.includes(full)))
    if (miss.length) bad.push(`${p.id} 缺 ${miss.join('+')}`)
  }
  if (bad.length) return { ok: false, detail: bad.join('；'), hint: '缺 compact-region 时压缩仍可用（L1/L2），但换气救不回思考（L3）。用 soul-preset.mjs build --write 补' }
  return { ok: true, detail: `${presets.length}/${presets.length} 全齐` }
})

check('L2', 'presetresolve', 'preset 里引用的包都能 resolve', () => {
  if (!presets.length) return { ok: false, detail: '跳过（没有 preset）', hint: '' }
  const namesIn = (body) => [...new Set([...body.join('\n').matchAll(/name:\s*['"]?(dsh-[\w.@/-]+)['"]?/g)].map((m) => m[1]))]
  const dead = new Set()
  for (const p of presets) for (const n of namesIn(p.body)) if (!resolve(n)) dead.add(n)
  if (dead.size) return { ok: false, detail: `resolve 不到：${[...dead].join(', ')}`, hint: '这些包在这个 profile 里没有。UI 上它们会显示红标 —— 或者更糟：静默不加载' }
  return { ok: true, detail: '全部可解析' }
})

check('L2', 'registry', 'agent-preset-registry 有 default/selectedDefault', () => {
  if (!patchRaw) return { ok: false, detail: '跳过', hint: '' }
  const lines = patchRaw.split(/\r?\n/)
  const ri = lines.findIndex((l) => /id:\s*agent-preset-registry/.test(l))
  if (ri < 0) return { ok: false, detail: '没找到 agent-preset-registry 块', hint: 'preset 装上了但没人指向它 —— picker 里不会出现' }
  const near = lines.slice(ri, Math.min(ri + 12, lines.length)).filter((l) => /default:|selectedDefault:/.test(l)).map((l) => l.trim())
  if (!near.length) return { ok: false, detail: '找到了块，但没有 default/selectedDefault', hint: '补上 selectedDefault 指向你要的 preset id' }
  return { ok: true, detail: near.join(' · ') }
})

check('L2', 'deadpresets', '.agent-presets/ 里没有残留（F1）', () => {
  const d = join(HOME, '.agent-presets')
  if (!existsSync(d)) return { ok: true, detail: '没有这个目录' }
  const n = readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).length
  if (!n) return { ok: true, detail: '目录存在但是空的' }
  return { ok: false, detail: `有 ${n} 个目录`, hint: '0.2.0-rc.2 起不再扫描它们 —— 文件在，但永远不生效（2026-09-30 那次全绿然后一起消失就是它）' }
})

// ═══════════════════════════════════════════════════════════════
// 输出
// ═══════════════════════════════════════════════════════════════

const bad = results.filter((r) => !r.ok)
const byLayer = { L0: [], L1: [], L2: [] }
for (const r of results) byLayer[r.layer].push(r)

if (JSON_OUT) {
  console.log(JSON.stringify({
    ok: bad.length === 0,
    profile: PROFILE,
    home: HOME,
    layers: Object.fromEntries(Object.entries(byLayer).map(([k, v]) => [k, {
      ok: v.every((r) => r.ok),
      checks: v.map((r) => ({ id: r.id, name: r.name, ok: r.ok, detail: r.detail, hint: r.ok ? undefined : r.hint })),
    }])),
    failed: bad.map((r) => `${r.layer}/${r.id}`),
  }, null, 2))
  process.exit(bad.length === 0 ? 0 : 1)
}

const title = { L0: 'L0 地基（这一层错，后面全白查）', L1: 'L1 能力（零件能不能被解析到）', L2: 'L2 装配（preset 装对了没）' }
console.log(`\ndoctor · profile = ${PROFILE}\n`)
for (const [layer, rows] of Object.entries(byLayer)) {
  if (!rows.length) continue
  console.log(title[layer])
  for (const r of rows) {
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}`)
    if (r.detail) console.log(`     ${r.detail}`)
    if (!r.ok && r.hint) console.log(`     → ${r.hint}`)
  }
  console.log('')
}
console.log('='.repeat(60))
if (!bad.length) console.log('✅ 三层全过')
else {
  console.log(`❌ ${bad.length} 项不过：${bad.map((r) => `${r.layer}/${r.id}`).join(', ')}`)
  // ★ 只报最底层的那一条建议 —— 底层错了，上层建议都是噪音
  const first = bad[0]
  console.log(`\n先修这个：${first.name}\n  ${first.hint}`)
}
console.log('')
process.exit(bad.length === 0 ? 0 : 1)
