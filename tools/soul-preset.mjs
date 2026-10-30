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
// ★ 双前缀兼容（2026-10-30）：本机是 dsh-yanqing-*、发布版是 dsh-agent-*。
const REQUIRED = ['compaction', 'compact-region', 'pruner']
  .flatMap((d) => ['dsh-agent-' + d, 'dsh-yanqing-' + d])
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
if (CMD === 'version') {
  // 生成 soul-version.json —— 「现在装的是哪一版」的唯一答案来源。
  // 现在 install.js 的已装判定只看「在不在」，完全不看版本，所以「更新」= 整目录覆盖、无 diff。
  const crypto = await import('node:crypto')
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
  const out = argOf('--out') || join(process.cwd(), 'soul-version.json')
  let pkgVersion = '0.0.0'
  try { pkgVersion = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version || pkgVersion } catch { /* 仓库根没有 package.json 就留默认 */ }

  const doc = {
    soulVersion: pkgVersion,
    generatedAt: new Date().toISOString(),
    profile: PROFILE,
    source: patchPath,
    presets: presets.map((p) => {
      const names = namesIn(p.body)
      const cfgAt = p.body.join('\n').search(/^\s+config:\s*$/m)
      const cfgText = cfgAt >= 0 ? p.body.join('\n').slice(cfgAt) : ''
      return {
        blockId: p.id,
        configId: cfgText.match(/^\s+id:\s*([\w.-]+)\s*$/m)?.[1] || p.id.replace(/^preset-/, ''),
        displayName: (cfgText.match(/^\s+name:\s*([^\n]+?)\s*$/m)?.[1] || '').replace(/^['"]|['"]$/g, ''),
        order: cfgText.match(/^\s+order:\s*(\d+)\s*$/m)?.[1] || null,
        lines: p.body.length,
        parts: names,
        missing: REQUIRED.filter((r) => !names.includes(r)),
        sha256: sha(p.body.join('\n')),
      };
    }),
    contracts: { doorplate: 1, recall: 1, record: 1 },
    note: 'contracts 变了 = 重大更新；零件版本怎么变，契约没变就不用迁移',
  }
  writeFileSync(out, JSON.stringify(doc, null, 2) + '\n', 'utf8')
  console.log(`\n写了 ${out}`)
  console.log(`  soulVersion = ${doc.soulVersion}  profile = ${doc.profile}`)
  for (const p of doc.presets) console.log(`  ${p.blockId.padEnd(26)} ${p.sha256.slice(0, 16)}  ${p.missing.length ? '缺 ' + p.missing.join(',') : '三件套齐'}`)
  process.exit(0)
}

// ═══════════════════════════════════════════════════════════════
if (CMD === 'split') {
  // 把四个 preset 里那段逐字相同的 compaction group 抽成 _shared/compaction.yml，
  // 原位留一行 @include 标记。前提已在 2026-10-28 验过：四份 raw hash 相同（5c8a546b…）。
  const dir = argOf('--from') || join(process.cwd(), 'presets')
  const sharedDir = join(dir, '_shared')
  mkdirSync(sharedDir, { recursive: true })
  const GROUP_ID = argOf('--group') || 'compaction'
  const MARK = `# @include $DIR/_shared/${GROUP_ID}.yml（源唯一，别在这里改）`

  function findGroup(lines) {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(\s*)-\s+id:\s*(\S+)\s*$/)
      if (!m || m[2] !== GROUP_ID) continue
      const indent = m[1].length
      let end = lines.length
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j]
        if (/^\s*-\s+/.test(t) && t.match(/^\s*/)[0].length <= indent) { end = j; break }
      }
      return { at: i, end, indent }
    }
    return null
  }

  const crypto = await import('node:crypto')
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16)

  const files = readdirSync(dir).filter((f) => f.endsWith('.yml') && f.startsWith('preset-')).sort()
  if (files.length === 0) die(`${dir} 里没有 preset-*.yml`)

  // 1) 确认四份相同，取第一份做源
  const infos = []
  for (const f of files) {
    const lines = readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n').split('\n')
    const g = findGroup(lines)
    if (!g) die(`${f} 里找不到 - id: ${GROUP_ID}`)
    const seg = lines.slice(g.at, g.end)
    infos.push({ f, lines, ...g, seg, hash: sha(seg.join('\n')), indent: g.indent })
  }
  const hashes = [...new Set(infos.map((x) => x.hash))]
  if (hashes.length !== 1) die(`四份不一致（${hashes.length} 种 hash），拒绝拆分：${hashes.join(' / ')}`)
  console.log(`\n四份 ${GROUP_ID} group 逐字相同（${infos[0].hash}，${infos[0].seg.length} 行，缩进 ${infos[0].indent}）`)

  // 2) 存共享源（去缩进，供任意缩进展开）
  const base = infos[0].indent
  const stripped = infos[0].seg.map((l) => (l.length >= base ? l.slice(base) : l))
  const header = [
    `# ${GROUP_ID} group —— 唯一的源`,
    `# ★ 这个文件被四个 preset 共享。改这里，然后跑 soul-preset build 重新展开。`,
    `# ★ 内容是从本机跑通的 preset 里原样抽出来的，没改一个字（抽的时候四份 hash 全是 ${infos[0].hash}）。`,
    `# ★ 缩进已去掉 ${base} 格；build 时按目标位置补回。`,
    '',
  ].join('\n')
  writeFileSync(join(sharedDir, `${GROUP_ID}.yml`), header + stripped.join('\n') + '\n', 'utf8')
  console.log(`写了 ${join(sharedDir, GROUP_ID + '.yml')}（去缩进后 ${stripped.length} 行）`)

  // 3) 四个 preset 原位替换成标记
  for (const x of infos) {
    const next = [...x.lines.slice(0, x.at), ' '.repeat(base) + MARK, ...x.lines.slice(x.end)]
    writeFileSync(join(dir, x.f), next.join('\n'), 'utf8')
    console.log(`  改 ${x.f}：${x.seg.length} 行 → 1 行标记（L${x.at + 1}）`)
  }
  console.log(`\n★ 现在跑 verify 会报「缺 ${GROUP_ID}」——因为还没展开。build 会认这行标记并展开。`)
  console.log(`★ 展开后必须能还原成 ${infos[0].hash}；还原不了就回滚。`)
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

  // 展开 `# @include <rel>/<name>.yml` —— 按标记行的缩进把共享片段补回去
  function expandIncludes(text, baseDir, depth = 0) {
    if (depth > 4) die('@include 嵌套超过 4 层，可能是循环')
    const out = []
    for (const line of text.split('\n')) {
      const m = line.match(/^(\s*)#\s*@include\s+(\S+?\.yml)/)
      if (!m) { out.push(line); continue }
      const [, pad, rel] = m
      const p = join(baseDir, rel.replace(/^\$DIR\//, ''))
      if (!existsSync(p)) die(`@include 找不到文件：${p}`)
      const rawInc = readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
      // 跳过共享文件**开头**的说明性注释（段内部的 # 注释要保留），
      // 否则 split 时加的 header 会被一起插进 preset，导致还原不一致。
      const incAll = rawInc.replace(/\n$/, '').split('\n')
      let i0 = 0
      while (i0 < incAll.length && /^\s*#/.test(incAll[i0])) i0++
      const incLines = incAll.slice(i0)
      for (const il of incLines) out.push(il === '' ? '' : pad + il)
    }
    return out.join('\n')
  }

  console.log(`\n源 = ${inDir}（${files.length} 个）  目标 = ${PROFILE}`)
  const toInsert = []
  for (const f of files) {
    const blockId = f.replace(/\.yml$/, '')
    const text = expandIncludes(readFileSync(join(inDir, f), 'utf8'), inDir).replace(/\r\n/g, '\n').replace(/\n$/, '')
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
