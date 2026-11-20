/**
 * packaging-smoke.mjs —— 打包契约的**真实不变量**（2026-11-21 重写）
 *
 * 为什么重写：原版把「0.1.4 / stubCaps: ['huanqi','pruner'] / prunerLive: false」
 * 这些**当时的值**写死成断言。版本一升、能力一接真，它就整片红 ——
 * 但它红的时候，真正该守的那条（**index.js import 的模块必须都在 files 里**）反而没被守住：
 * 2026-11-20 就出现过 process-inspector.mjs / manager-proof-client.mjs / lifecycle-inspect.mjs
 * 被 import 却没发布的情况，包能装上、一跑就 MODULE_NOT_FOUND。
 *
 * 所以改成断言语义而不是断言值：
 *   ① 版本只有一处真相 —— package.json；index.js 的 VERSION 必须与它一致
 *   ② files 必须覆盖 index.js 的**每一个相对模块 import**（这条才是发布事故的那条）
 *   ③ files 里每一项都真的存在、无重复
 *   ④ stubCaps / prunerLive 在 index.js 与 patch 两边一致（两边不一致时 patch 覆盖 DEFAULTS，
 *      历史上踩过五次「只改了 index.js，hello 里还是旧 caps」）
 *   ⑤ caps 十项一条不少（不许用缩减 caps 掩盖问题）
 */
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const fail = (m) => { throw new Error(m) }
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8')

const pkg = JSON.parse(read('package.json'))
const files = Array.isArray(pkg.files) ? pkg.files : fail('package.json.files 缺失')
const source = read('index.js')
const patch = read('cordis.patch.yml')

// ① 版本单一真相
const mVer = /const VERSION = '([^']+)'/.exec(source)
if (!mVer) fail('index.js 里找不到 const VERSION')
if (mVer[1] !== pkg.version) fail('index.js VERSION=' + mVer[1] + ' 与 package.json version=' + pkg.version + ' 不一致')

// ② files 覆盖 index.js 的所有相对模块 import —— 发布事故就出在这
const imports = new Set()
const reImport = /(?:from|import)\s+'(\.\/[^']+)'/g
let mm
while ((mm = reImport.exec(source))) imports.add(mm[1].replace(/^\.\//, ''))
const missing = [...imports].filter((f) => !files.includes(f))
if (missing.length) fail('index.js import 了但 files 没发布：' + missing.join(', '))

// ③ 每项都存在、无重复
if (new Set(files).size !== files.length) fail('package.json.files 含重复项')
for (const f of files) if (!fs.existsSync(path.join(root, f))) fail('files 清单缺文件：' + f)

// ④ 两边一致
const pick = (text, key) => {
  const r = new RegExp('^\\s*' + key + ':\\s*(.+)$', 'm').exec(text)
  // 去掉行尾注释与可能的逗号 —— index.js 是 JS（键后有逗号），patch 是 YAML（没有）
  return r ? r[1].replace(/\s+#.*$/, '').trim().replace(/,$/, '') : null
}
for (const key of ['stubCaps', 'prunerLive']) {
  const a = pick(source, key)
  const b = pick(patch, key)
  if (a === null) fail('index.js DEFAULTS 缺 ' + key)
  if (b === null) fail('cordis.patch.yml 缺 ' + key + '（patch 会覆盖 DEFAULTS，必须两边都写）')
  if (a !== b) fail(key + ' 两边不一致：index.js=' + a + ' patch=' + b)
}

// ⑤ caps 十项，一项不许少
const CAPS = ['followup', 'session', 'sessions', 'workspaces', 'agent', 'events', 'service', 'huanqi', 'pruner', 'context']
const capsLine = /caps:\s*\[([^\]]+)\]/.exec(patch)
if (!capsLine) fail('patch 里找不到 caps')
const caps = capsLine[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean)
const lost = CAPS.filter((c) => !caps.includes(c))
if (lost.length) fail('patch caps 少了：' + lost.join(', ') + '（不许用缩减 caps 掩盖问题）')

console.log('packaging smoke: PASS')
console.log('version=' + pkg.version + ' files=' + files.length + ' caps=' + caps.length
  + ' imports-verified=' + imports.size + ' stubCaps=' + pick(source, 'stubCaps') + ' prunerLive=' + pick(source, 'prunerLive'))
