#!/usr/bin/env node
/**
 * soul-preset.mjs —— 无脑注册 agent preset
 *
 * 为什么有这个文件
 * ----------------
 * 「注册 preset」这件事我们栽过太多回。2026-09-30 那次最狠：preset 文件完好、
 * 健康检查 24 行全绿，然后它们从 picker 里一起消失了 —— 因为 0.2.0-rc.2 起
 * 改成 profile 层声明，不再扫描 .agent-presets/ 目录。文件没丢，丢的是「认它的方式」。
 *
 * 失败模式清单（F1–F8）见 30-状态/调研-dsh-agent-soul-用户反馈-20261028/15-preset无脑注册设计.md
 *
 * 用法
 * ----
 *   node tools/soul-preset.mjs verify [--profile desktop]
 *      只读。查：preset 块在不在、三件套齐不齐、包能不能 resolve、registry 配置
 *
 *   node tools/soul-preset.mjs register --id <id> --name <显示名> [--from preset-yanqing] [--write]
 *      从现成 preset 复制一份，改 id/name。默认 dry-run。
 *
 *   node tools/soul-preset.mjs register-all [--write]
 *      检查四个砚青 preset 是否齐，缺的报出来（不自动补 —— 缺哪个由人定）
 *
 * 铁律
 * ----
 * 1. 只插入、不替换（用户可能改过现成的）
 * 2. 写前备份，写后立刻复核 dsh.profile.bundles 条数没变（防 sanitizeProfile 重置）
 * 3. 不碰 default / selectedDefault（一个坏 preset 当默认会让新会话起不来）
 * 4. UTF-8 无 BOM
 * 5. 不解析 YAML —— 文件里有 !!js process.platform 这种 loader 专有写法，
 *    普通解析器会炸。本脚本一律用文本扫描。
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const HOME = process.env.DSH_HOME || 'D:/AI/dsh/home'
const REQUIRED = ['dsh-yanqing-compaction', 'dsh-yanqing-compact-region', 'dsh-yanqing-pruner']
const argOf = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null }
const PROFILE = argOf('--profile') || 'desktop'
const WRITE = process.argv.includes('--write')
const CMD = process.argv[2] || 'verify'

const profileDir = join(HOME, 'profiles', PROFILE)
const patchPath = join(profileDir, 'cordis.patch.yml')
const pkgPath = join(profileDir, 'package.json')

let bad = 0
const ok = (m) => console.log(`  ✅ ${m}`)
const ng = (m) => { bad++; console.log(`  ❌ ${m}`) }
const info = (m) => console.log(`  ·  ${m}`)
const die = (m) => { console.error(`\n✗ ${m}`); process.exit(2) }

if (!existsSync(patchPath)) die(`profile "${PROFILE}" 没有 cordis.patch.yml（路径 ${patchPath}）`)

// ── 文本扫描：找所有 preset 块及范围 ────────────────────────────
function scan(lines) {
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)-\s+id:\s*(preset-[\w.-]+)\s*$/)
    if (!m) continue
    const indent = m[1].length
    let end = lines.length
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]
      if (/^\s*-\s+/.test(t) && t.match(/^\s*/)[0].length <= indent) { end = j; break }
    }
    out.push({ id: m[2], start: i, end, indent, body: lines.slice(i, end) })
  }
  return out
}

const raw = readFileSync(patchPath, 'utf8')
const lines = raw.split(/\r?\n/)
const presets = scan(lines)
const nmDir = join(profileDir, 'node_modules')
const resolvable = (n) => existsSync(join(nmDir, n)) || existsSync(join(nmDir, n.replace(/^@([^/]+)\/(.*)$/, '@$1+$2')))
const namesIn = (body) => [...new Set([...body.join('\n').matchAll(/name:\s*['"]?(dsh-[\w.@/-]+)['"]?/g)].map((m) => m[1]))]

// ═══════════════════════════════════════════════════════════════
if (CMD === 'verify') {
  console.log(`\nprofile = ${PROFILE}`)
  info(`patch = ${patchPath}  (${raw.length} 字符)`)
  if (presets.length === 0) die('一个 preset 块都没找到 —— 写法可能不是 `- id: preset-*`')

  console.log(`\n[preset 块] ${presets.length} 个`)
  for (const p of presets) console.log(`  · ${p.id}  L${p.start + 1}–L${p.end}`)

  console.log('\n[三件套]')
  for (const p of presets) {
    const names = namesIn(p.body)
    const miss = REQUIRED.filter((r) => !names.includes(r))
    const dead = names.filter((n) => !resolvable(n))
    if (miss.length) ng(`${p.id} 缺 ${miss.join(', ')}`)
    else if (dead.length) ng(`${p.id} resolve 不到 ${dead.join(', ')}`)
    else ok(`${p.id} 三件套齐全`)
  }

  console.log('\n[registry]')
  const ri = lines.findIndex((l) => /id:\s*agent-preset-registry/.test(l))
  if (ri < 0) info('没找到 agent-preset-registry')
  else for (let j = ri; j < Math.min(ri + 12, lines.length); j++) if (/default:|selectedDefault:/.test(lines[j])) info(lines[j].trim())

  // 目录扫描残留（F1）：如果 profile 配置里一个 preset 都没有、但目录版有，警告
  const dirPresets = join(HOME, '.agent-presets')
  if (existsSync(dirPresets)) {
    const n = readdirCount(dirPresets)
    if (n > 0) info(`提示：.agent-presets/ 里还有 ${n} 个目录 —— 0.2.0-rc.2 起不再扫描，它们是死的（F1）`)
  }

  console.log(`\n${'='.repeat(56)}`)
  console.log(bad === 0 ? '✅ 全部通过' : `❌ ${bad} 项不过`)
  process.exit(bad === 0 ? 0 : 1)
}

function readdirCount(d) {
  try { return require('node:fs').readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).length } catch { return 0 }
}

// ═══════════════════════════════════════════════════════════════
if (CMD === 'export') {
  // 把「本机能跑的 preset」导出成仓库里的模板。
  // 理由：preset 现在只活在部署现场，别人 clone 仓库拿不到 —— 这是「装不到别人机器上」的根因之一。
  // 本机跑通的这份就是黄金样本，先把它变成可版本化的东西。
  const outDir = argOf('--out') || join(process.cwd(), 'presets')
  mkdirSync(outDir, { recursive: true })
  console.log(`\n导出 ${presets.length} 个 preset → ${outDir}`)
  const manifest = { exportedAt: new Date().toISOString(), source: patchPath, presets: [] }
  for (const p of presets) {
    const body = p.body
    const text = body.join('\n')
    // config.id / config.name 在 `config:` 之下，比块头部的 name 更深一级 —— 别抓错
    const cfgAt = text.search(/^\s+config:\s*$/m)
    const cfgText = cfgAt >= 0 ? text.slice(cfgAt) : ''
    const cfgId = cfgText.match(/^\s+id:\s*([\w.-]+)\s*$/m)?.[1] || p.id.replace(/^preset-/, '')
    const cfgName = cfgText.match(/^\s+name:\s*([^\n]+?)\s*$/m)?.[1] || ''
    const order = cfgText.match(/^\s+order:\s*(\d+)\s*$/m)?.[1] || ''
    const file = join(outDir, `${p.id}.yml`)
    writeFileSync(file, body.join('\n') + '\n', 'utf8')
    const names = namesIn(body)
    const missing = REQUIRED.filter((r) => !names.includes(r))
    manifest.presets.push({ blockId: p.id, configId: cfgId, displayName: cfgName.replace(/^['"]|['"]$/g, ''), order: order || null, file: `${p.id}.yml`, lines: body.length, parts: names, missing })
    console.log(`  ${p.id}  ${body.length} 行  config.id=${cfgId}  name=${cfgName}${missing.length ? '  ⚠ 缺 ' + missing.join(',') : ''}`)
  }
  writeFileSync(join(outDir, '_manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  console.log(`\n还写了 _manifest.json（${manifest.presets.length} 条）`)
  console.log(`★ 这些是「本机能跑的形状」，进仓库后要能被 build 回插到任意 profile。`)
  process.exit(0)
}

// ═══════════════════════════════════════════════════════════════
if (CMD === 'build') {
  // 仓库 → profile。与 export 配对，闭合「导出的能装回去」这件事。
  // 默认比对模式（只报差异），--write 才真插。
  const inDir = argOf('--from') || join(process.cwd(), 'presets')
  if (!existsSync(inDir)) die(`找不到 ${inDir}（先跑 export）`)
  const files = readdirSync(inDir).filter((f) => f.endsWith('.yml') && f.startsWith('preset-')).sort()
  if (files.length === 0) die(`${inDir} 里没有 preset-*.yml`)

  const crypto = await import('node:crypto')
  const sha = (s) => crypto.createHash('sha256').update(s.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16)
  const inProfile = new Map(presets.map((p) => [p.id, sha(p.body.join('\n'))]))

  console.log(`\n源 = ${inDir}（${files.length} 个）  目标 = ${PROFILE}`)
  const toInsert = []
  for (const f of files) {
    const blockId = f.replace(/\.yml$/, '')
    const text = readFileSync(join(inDir, f), 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '')
    const body = text.split('\n')
    const mine = sha(text)
    const theirs = inProfile.get(blockId)
    if (!theirs) { console.log(`  ➕ ${blockId}  目标里没有 → 会插入（${body.length} 行）`); toInsert.push({ blockId, body }); }
    else if (mine !== theirs) { console.log(`  ⚠️  ${blockId}  存在但不一致  仓库 ${mine} / profile ${theirs}`); }
    else { console.log(`  ✅ ${blockId}  一致（${mine}）`); }
  }

  if (toInsert.length === 0) { console.log('\n无需插入。'); process.exit(bad === 0 ? 0 : 1) }
  if (!WRITE) { console.log(`\n[dry-run] 会插 ${toInsert.length} 个。加 --write 才真写。`); process.exit(0) }

  const lastEnd = Math.max(...presets.map((p) => p.end))
  const all = []
  for (const t of toInsert) all.push(...t.body)
  writeBack(lines, lastEnd, all, pkgPath, patchPath, raw)
}

// ═══════════════════════════════════════════════════════════════
if (CMD === 'register') {
  const id = argOf('--id')
  const displayName = argOf('--name')
  const from = argOf('--from') || 'preset-yanqing'
  if (!id || !displayName) die('用法：register --id <id> --name <显示名> [--from <源 preset>] [--write]')
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) die(`id "${id}" 不合法（只允许小写字母/数字/减号）`)
  if (presets.some((p) => p.id === `preset-${id}`)) die(`preset-${id} 已经存在，不重复注册`)

  const src = presets.find((p) => p.id === from)
  if (!src) die(`源 preset "${from}" 不存在。可用：${presets.map((p) => p.id).join(', ')}`)

  // 改 id / config.id / config.name
  const body = src.body.map((l) => {
    let s = l
    s = s.replace(new RegExp(`(\\s*-\\s+id:\\s*)${from}\\s*$`), `$1preset-${id}`)
    // config.id 是更深缩进的那一行 `id: <源id不带preset前缀>`
    const srcBare = from.replace(/^preset-/, '')
    s = s.replace(new RegExp(`^(\\s+)id:\\s*${srcBare}\\s*$`), `$1id: ${id}`)
    s = s.replace(/^(\s+)name:\s*.*$/, (m0, sp) => (sp.length > src.indent + 2 && /name:/.test(l) ? `${sp}name: ${displayName}` : m0))
    return s
  })

  console.log(`\n从 ${from} 复制 → preset-${id}（显示名：${displayName}）`)
  console.log(`  块长度 ${body.length} 行，缩进 ${src.indent}`)
  console.log(`  将插在 L${src.end + 1}（源块之后）`)

  if (!WRITE) {
    console.log('\n[dry-run] 前 8 行预览：')
    for (const l of body.slice(0, 8)) console.log('   | ' + l)
    console.log('\n加 --write 才真写。')
    process.exit(0)
  }
  writeBack(lines, src.end + 1, body, pkgPath, patchPath, raw)
}

// ═══════════════════════════════════════════════════════════════
if (CMD === 'register-all') {
  const want = { standard: 'yanqing', ptc: 'yanqing-ptc', creative: 'yanqing-cordis', distill: 'yanqing-distill' }
  console.log(`\n[四个砚青 preset]`)
  let missing = 0
  for (const [label, id] of Object.entries(want)) {
    if (presets.some((p) => p.id === `preset-${id}`)) ok(`${label.padEnd(9)} preset-${id}`)
    else { ng(`${label.padEnd(9)} preset-${id} 缺失`); missing++ }
  }
  console.log(missing === 0 ? '\n已齐，无需动作。' : `\n缺 ${missing} 个。用 register 子命令补，别自动猜内容。`)
  process.exit(missing === 0 ? 0 : 1)
}

// ═══════════════════════════════════════════════════════════════
function writeBack(lines, insertAt, body, pkgPath, patchPath, raw) {
  const pkg0 = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const b0 = (pkg0?.dsh?.profile?.bundles || []).length
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  copyFileSync(patchPath, `${patchPath}.bak-soulpreset-${stamp}`)
  copyFileSync(pkgPath, `${pkgPath}.bak-soulpreset-${stamp}`)

  lines.splice(insertAt, 0, ...body)
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  writeFileSync(patchPath, lines.join(eol), 'utf8')

  const b1 = (JSON.parse(readFileSync(pkgPath, 'utf8'))?.dsh?.profile?.bundles || []).length
  const head = readFileSync(patchPath).subarray(0, 3)
  const hasBom = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf
  console.log(`\n写回 ${lines.join(eol).length} 字符（原 ${raw.length}）`)
  console.log(`  bundles ${b0} → ${b1}  ${b0 === b1 ? '✅ 未变' : '❌ 变了！立刻回滚 ' + stamp}`)
  console.log(`  BOM: ${hasBom ? '❌ 有' : '✅ 无'}`)
  console.log(`\n★ profile 只在启动时读一次。要生效必须完全退出 DSH 再打开。`)
  process.exit(0)
}
