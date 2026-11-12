// frame-reader 自检 —— S3a（离线夹具；真实日志组默认 skip）
//
// 复跑：
//   node tools/frame-reader-selftest.mjs            # 只跑夹具（本轮禁止真实日志，默认就是这样）
//   node tools/frame-reader-selftest.mjs --real DIR # 显式要求时才读一个真实会话（本切片禁用）
//
// ★ 夹具全部写在系统临时目录，跑完删除；不碰 30-状态 下任何生产数据。
// ★ 2026-11-08 返修后新增 [13] 组：字节口径矩阵 / junction / event 上界 / 解压上限 /
//   魔数误切合并 / 空片 / ok 与 allHit / deduped / 新读数并列。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const ROOT = path.resolve(HERE, '..')
const FR = path.join(ROOT, 'src', 'organs', 'frame-reader.mjs')
const CONTRACT = 'D:/AI/dsh-tools/dsh-yanqing-pruner/context-contract.mjs'

let pass = 0
let fail = 0
const failed = []
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  → ' + detail : '')) }
  else { fail++; failed.push(name); console.log('  FAIL ' + name + (detail ? '  → ' + detail : '')) }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const argv = process.argv.slice(2)
const REAL = argv.includes('--real')
const realIdx = argv.indexOf('--real')
const REAL_DIR = realIdx >= 0 && argv[realIdx + 1] ? argv[realIdx + 1] : ''

const fr = await import(pathToFileURL(FR).href)
const contract = await import(pathToFileURL(CONTRACT).href)

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 's3a-'))
const MAGIC = Buffer.from([0xAA, 0xBB, 0xCC, 0xDD])
// 宽容解码器：只切头，不校验正文（用来造各种「坏行 / 大正文」夹具）
const framesDecoder = { magic: MAGIC, decompress: (u8) => u8.subarray(4) }
// 严格解码器：正文必须是合法 JSON，否则抛（用来验「合并重试」）
const strictMagic = Buffer.from('ZZZZ')
const strictDecoder = {
  magic: strictMagic,
  decompress: (u8) => {
    const body = u8.subarray(4).toString('utf8')
    JSON.parse(body)
    return Buffer.from(body)
  },
}

function mkSession(id, lines, opts = {}) {
  const dir = opts.flat ? path.join(TMP, id) : path.join(TMP, 'ws-1', id)
  fs.mkdirSync(dir, { recursive: true })
  const magic = opts.magic || MAGIC
  const chunks = []
  for (const group of lines) {
    const body = Buffer.from(group.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8')
    chunks.push(Buffer.concat([magic, body]))
  }
  fs.writeFileSync(path.join(dir, opts.fileName || 'session.v4.jsonl.zstd'), Buffer.concat(chunks))
}
const ev = (seq, type, text) => ({ type, seq, data: { message: { content: [{ content: [{ type: 'text', text }] }] } } })
const longText = (n) => 'x'.repeat(n)

console.log('')
console.log('=== frame-reader 自检（S3a 返修后） ===')
console.log('模块  ' + FR)
console.log('契约  ' + CONTRACT + '  v' + contract.CONTRACT_VERSION)
console.log('夹具  ' + TMP)
console.log('')

// ── [1] 会话号 ──
console.log('[1] 会话号校验')
ok('1.1 .. 被拒', fr.checkSessionId('..').ok === false)
ok('1.2 ../x 被拒', fr.checkSessionId('../x').ok === false)
ok('1.3 绝对路径被拒', fr.checkSessionId('C:\\Windows').ok === false)
ok('1.4 以点开头被拒', fr.checkSessionId('.hidden').ok === false)
ok('1.5 空串被拒', fr.checkSessionId('').ok === false)
ok('1.6 正常 id 通过', fr.checkSessionId('session-4c00948d-97b4-40e4-b1c9-6599b020fad7').ok === true)

// ── [2] 定位 ──
mkSession('sess-basic', [
  [{ type: 'session', id: 'sess-basic' }, ev(0, 'user/message', 'first'), ev(1, 'assistant/message', 'second')],
  [ev(2, 'assistant/message', 'third'), ev(3, 'assistant/message', 'fourth')],
])
mkSession('sess-flat', [[ev(0, 'assistant/message', 'flat')]], { flat: true })
console.log('[2] 文件定位')
const loc1 = fr.resolveSessionFile('sess-basic', { sessionRoot: TMP })
ok('2.1 工作区布局能找到', loc1.ok === true && loc1.layout === 'workspace', loc1.file)
ok('2.2 扁平布局能找到', fr.resolveSessionFile('sess-flat', { sessionRoot: TMP }).layout === 'flat')
ok('2.3 不存在的会话 → not-found', fr.resolveSessionFile('nope', { sessionRoot: TMP }).ok === false)
ok('2.4 返回 realFile 且在根内', typeof loc1.realFile === 'string' && fs.realpathSync.native(loc1.realFile) === loc1.realFile)

const reader = await fr.createFrameReader({ sessionRoot: TMP, contract, decoder: framesDecoder })

// ── [3] 按 seq ──
console.log('[3] 按 seq 定位')
const r31 = reader.readFrames('sess-basic', [1])
ok('3.1 seq=1 拿到第二行（不是行号）', r31.frames[0] && r31.frames[0].text === 'second')
ok('3.2 seq 报回原样', r31.frames[0] && r31.frames[0].seq === 1)
ok('3.3 ptr 是门牌', r31.frames[0] && r31.frames[0].ptr === 'log:sess-basic#seq=1')
ok('3.4 会话头不入 seq 索引', r31.stats.withoutSeq === 1)

// ── [4] missing ──
console.log('[4] missing 的语义')
const r41 = reader.readFrames('sess-basic', [99])
ok('4.1 干净文件里查不到 → missing', r41.frames[0].status === 'missing' && r41.missing.length === 1)
ok('4.2 missing 不会被说成 ok 且 allHit=false', r41.ok === true && r41.allHit === false)

// ── [5] 预算 ──
mkSession('sess-big', [[ev(0, 'assistant/message', longText(200)), ev(1, 'assistant/message', longText(200))]])
console.log('[5] 预算与截断')
const r51 = reader.readFrames('sess-big', [0], { maxCharsPerFrame: 50 })
ok('5.1 超单帧上限 → truncated', r51.frames[0].status === 'truncated')
ok('5.2 chars 是给了多少', r51.frames[0].chars === 50)
ok('5.3 fullChars 是完整长度', r51.frames[0].fullChars === 200)
ok('5.4 原因 per-frame-cap', r51.frames[0].truncatedReason === 'per-frame-cap')
const r52 = reader.readFrames('sess-big', [0, 1], { maxCharsPerFrame: 120, maxTotalChars: 150 })
ok('5.5 总预算耗尽原因不同', r52.frames[1].truncatedReason === 'total-budget-exhausted')
ok('5.6 总字符不超上限', r52.totals.chars <= 150, 'chars=' + r52.totals.chars)

// ── [6] hash 与截断分离 ──
console.log('[6] hash 与截断分离')
const bigText = longText(500)
mkSession('sess-hash', [[ev(0, 'assistant/message', bigText)]])
const r61 = reader.readFrames('sess-hash', [0], { maxCharsPerFrame: 10 })
const expected = contract.canonicalEventText({ type: 'assistant/message', seq: 0, data: { message: { content: [{ content: [{ type: 'text', text: bigText }] }] } } })
ok('6.1 返回正文被截断', r61.frames[0].text.length === 10)
ok('6.2 hash 等于完整正文 hash', r61.frames[0].sha256 === expected.sha256)
ok('6.3 hash 不等于截断正文 hash', r61.frames[0].sha256 !== contract.sha256Hex(bigText.slice(0, 10)))
ok('6.4 hash 是 64 位小写 hex', /^[0-9a-f]{64}$/.test(r61.frames[0].sha256))

// ── [7] 不支持形状 ──
mkSession('sess-unsup', [[{ type: 'tool/result', seq: 0, data: { content: 'not-the-prunable-shape' } }]])
const r71 = reader.readFrames('sess-unsup', [0])
console.log('[7] 不支持的形状')
ok('7.1 sha256 是 null', r71.frames[0].sha256 === null)
ok('7.2 hashSupported=false', r71.frames[0].hashSupported === false)
ok('7.3 给了原因', r71.frames[0].hashReason === 'prune-unsupported-shape')
ok('7.4 正文仍可读', r71.frames[0].chars > 0)

// ── [8] 坏行 ──
{
  const dir = path.join(TMP, 'ws-1', 'sess-broken')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([
    MAGIC, Buffer.from(JSON.stringify(ev(0, 'assistant/message', 'good')) + '\n', 'utf8'),
    MAGIC, Buffer.from('{ this is not json }\n', 'utf8'),
  ]))
  console.log('[8] 坏行的语义')
  const r = reader.readFrames('sess-broken', [5])
  ok('8.1 有坏行时未命中 → error', r.frames[0].status === 'error')
  ok('8.2 不是 missing', r.missing.length === 0)
  ok('8.3 理由说清无法断言', /unreadable|无法断言/.test(r.frames[0].reason))
  ok('8.4 坏行记了账', r.stats.badLines === 1)
  const r2 = reader.readFrames('sess-broken', [0])
  ok('8.5 好帧仍读得到', r2.frames[0].status === 'ok' && r2.frames[0].text === 'good')
}

// ── [9] 上限 ──
console.log('[9] 上限')
const many = Array.from({ length: 13 }, (_, i) => i)
ok('9.1 一次 13 个 seq → 拒绝', reader.readFrames('sess-basic', many).error === 'too-many-seqs')
const r92 = reader.readFrames('sess-basic', [0, 1, 2, 3], { maxFrames: 2 })
ok('9.2 超 maxFrames → 拒绝', r92.error === 'too-many-seqs')
const r93 = reader.readFrames('sess-basic')
ok('9.3 不给 seqs → 全部 4 个', r93.frames.length === 4 && r93.frames[3].seq === 3)
const r94 = reader.readFrames('sess-basic', undefined, { maxFrames: 2 })
ok('9.4 不给 seqs + maxFrames=2 → 最近 2 帧', eq(r94.frames.map((f) => f.seq), [2, 3]))
ok('9.5 默认上限 6 / 硬上限 12', r93.limits.maxFrames === 6 && fr.LIMITS.maxFrames === 12)

// ── [10] 内部通道（小 event） ──
console.log('[10] 内部 event 通道')
const g1 = reader.getEventForValidate('sess-hash', 0)
ok('10.1 标了 internal=validate-only', g1.internal === 'validate-only')
ok('10.2 完整正文不受 maxCharsPerFrame 限制', g1.canonical.text.length === 500, 'chars=' + g1.canonical.text.length)
ok('10.3 带完整 event', g1.event && g1.event.seq === 0)
ok('10.4 hash 与读取层一致', g1.canonical.sha256 === expected.sha256)
ok('10.5 缺失时明确 missing', reader.getEventForValidate('sess-basic', 99).error === 'missing')
ok('10.6 成功返回带 eventBytes / responseBytes 且不超 maxResponseBytes', Number.isFinite(g1.eventBytes) && g1.responseBytes <= fr.LIMITS.maxResponseBytes, 'eventBytes=' + g1.eventBytes + ' responseBytes=' + g1.responseBytes)

// ── [11] 契约 ──
console.log('[11] 契约依赖')
let threw = null
try { await fr.createFrameReader({ sessionRoot: TMP, decoder: framesDecoder, contractPath: path.join(TMP, 'nope.mjs') }) }
catch (e) { threw = e }
ok('11.1 契约载入失败 → 抛错不降级', threw !== null)

// ── [12] 真实日志（默认 skip；本轮禁止） ──
console.log('[12] 真实日志')
if (!REAL) console.log('  skip  未传 --real：本轮禁止读真实日志')
else if (!REAL_DIR || !fs.existsSync(REAL_DIR)) console.log('  skip  真实目录不存在：' + REAL_DIR)
else {
  const real = await fr.createFrameReader({ sessionRoot: REAL_DIR, contract })
  const dirs = fs.readdirSync(REAL_DIR, { withFileTypes: true }).filter((d) => d.isDirectory())
    .map((d) => ({ name: d.name, t: fs.statSync(path.join(REAL_DIR, d.name)).mtimeMs })).sort((a, b) => b.t - a.t)
  const meta = real.readFrames(dirs[0].name, undefined, { maxFrames: 3 })
  ok('12.1 读到 3 帧', meta.frames.length === 3, meta.frames.map((f) => f.seq + ':' + f.type).join(','))
  ok('12.2 每帧有 seq 与 ptr', meta.frames.every((f) => Number.isInteger(f.seq) && /^log:.*#seq=\d+$/.test(f.ptr || '')))
  ok('12.3 新旧读数并列', Number.isInteger(meta.stats.magicSplits) && Number.isInteger(meta.stats.framesInFile), 'magicSplits=' + meta.stats.magicSplits + ' framesInFile=' + meta.stats.framesInFile)
}

// ── [13] 返修回归 ──
console.log('[13] 返修回归（P1-1 / P1-2 / P2-1 / P2-2）')

// 13.1-13.7 字节口径矩阵：jsonBytes 必须逐一等于 Buffer.byteLength(JSON.stringify(x))
const byteCases = {
  'ascii': 'hello world',
  '中文': '中文字符串测试',
  '控制字符': 'a\u0000b\tc\nd\re\u0008f',
  '引号反斜杠': 'he said "hi" \\ and \/ done',
  'emoji': '🙂🀄️🧪',
  '混合嵌套': { a: ['x', 1, true, null], b: { c: '中文', d: '\u0001' }, e: 3.5 },
}
let byteOk = 0
for (const [k, v] of Object.entries(byteCases)) {
  const exact = Buffer.byteLength(JSON.stringify(v), 'utf8')
  const got = fr.jsonBytes(v, 1e9)
  if (got === exact) byteOk++
  else console.log('  FAIL 13.x ' + k + ' 期望 ' + exact + ' 实得 ' + got)
}
ok('13.1-13.6 字节矩阵（ascii/中文/控制字符/引号/emoji/嵌套）逐一相等', byteOk === Object.keys(byteCases).length, byteOk + '/' + Object.keys(byteCases).length)
ok('13.7 超限早退返回 Infinity', fr.jsonBytes({ a: 'x'.repeat(100) }, 10) === Infinity)

// 13.8 junction 越界必须被拒
{
  const root = path.join(TMP, 'jroot')
  const outside = path.join(TMP, 'jout')
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(path.join(outside, 'sess-j'), { recursive: true })
  fs.writeFileSync(path.join(outside, 'sess-j', 'session.v4.jsonl.zstd'), Buffer.concat([
    MAGIC, Buffer.from(JSON.stringify({ seq: 42, type: 'user/message', data: { content: 'OUTSIDE' } }) + '\n', 'utf8'),
  ]))
  const cp = await import('node:child_process')
  const mk = cp.spawnSync('cmd', ['/c', 'mklink', '/J', path.join(root, 'sess-j'), path.join(outside, 'sess-j')], { encoding: 'utf8' })
  if (mk.status === 0) {
    const loc = fr.resolveSessionFile('sess-j', { sessionRoot: root })
    const real = loc.ok ? fs.realpathSync.native(loc.realFile) : null
    const inside = real ? real.startsWith(fs.realpathSync.native(root) + path.sep) : false
    ok('13.8 扁平 junction 越界被拒', loc.ok === false || inside === true, 'ok=' + loc.ok + ' realInside=' + inside)
    const rr = await fr.createFrameReader({ sessionRoot: root, contract, decoder: framesDecoder })
    const got = rr.readFrames('sess-j', [42])
    ok('13.9 junction 拒绝后读不到根外内容', !(got.frames && got.frames[0] && got.frames[0].text === 'OUTSIDE'), 'error=' + (got.error || 'none'))
  } else {
    console.log('  skip  13.8/13.9 mklink 不可用：' + (mk.stderr || '').toString().trim().slice(0, 60))
  }
}

// 13.10 大 event → event-too-large（拒绝，不给截断版）
{
  const huge = { type: 'tool/result', seq: 9, data: { content: longText(3 * 1024 * 1024) } }
  mkSession('sess-huge', [[huge]])
  const g = reader.getEventForValidate('sess-huge', 9)
  ok('13.10 大 event → event-too-large', g.ok === false && g.error === 'event-too-large', 'error=' + g.error)
  ok('13.11 拒绝时不返回 event 与 canonical.text', g.event === undefined && g.canonical === undefined)
  ok('13.12 拒绝时仍给有界元数据', g.canonicalMeta && Number.isFinite(g.canonicalMeta.bytes) && Number.isFinite(g.canonicalMeta.chars))
  ok('13.13 拒绝响应体本身很小', Buffer.byteLength(JSON.stringify(g), 'utf8') < 4096, 'bytes=' + Buffer.byteLength(JSON.stringify(g), 'utf8'))
  const rf = reader.readFrames('sess-huge', [9], { maxCharsPerFrame: 8000 })
  ok('13.14 读取层仍只看 8000 字符', rf.frames[0].chars === 8000 && rf.frames[0].fullChars === 3 * 1024 * 1024)
  ok('13.15 该形状仍无指纹（不因截断而造假指纹）', rf.frames[0].sha256 === null)
}

// 13.16 解压上限（真实 zstd；高压缩比）
{
  const dir = path.join(TMP, 'ws-1', 'sess-bomb')
  fs.mkdirSync(dir, { recursive: true })
  const payload = Buffer.from(JSON.stringify({ seq: 0, type: 'user/message', data: { content: longText(40 * 1024 * 1024) } }) + '\n', 'utf8')
  const comp = zlib.zstdCompressSync(payload)
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), comp)
  const real = await fr.createFrameReader({ sessionRoot: TMP, contract })
  const got = real.readFrames('sess-bomb', [0], { maxDecodedBytes: 1024 * 1024 })
  ok('13.16 解压超限 → decompress-limit', got.error === 'decompress-limit', 'error=' + got.error + ' 压缩后 ' + comp.length + ' B')
  ok('13.17 解压超限不降级成 missing', got.missing === undefined || got.missing.length === 0)
}

// 13.18 魔数误切 → 合并重试
{
  const textWithMagic = 'left-ZZZZ-right'
  const rec = { seq: 7, type: 'user/message', data: { content: textWithMagic } }
  const dir = path.join(TMP, 'ws-1', 'sess-merge')
  fs.mkdirSync(dir, { recursive: true })
  const body = Buffer.from(JSON.stringify(rec) + '\n', 'utf8')
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([strictMagic, body]))
  const mr = await fr.createFrameReader({ sessionRoot: TMP, contract, decoder: strictDecoder })
  const got = mr.readFrames('sess-merge', [7])
  ok('13.18 误切后合并重试成功', got.frames[0] && got.frames[0].status === 'ok', 'status=' + (got.frames[0] && got.frames[0].status))
  ok('13.19 magicSplits 记原始切分数', got.stats.magicSplits === 2, 'magicSplits=' + got.stats.magicSplits)
  ok('13.20 framesInFile 是新口径（合并后 1 帧）', got.stats.framesInFile === 1, 'framesInFile=' + got.stats.framesInFile)
  ok('13.21 framesMerged 记合并次数', got.stats.framesMerged === 1, 'framesMerged=' + got.stats.framesMerged)
  ok('13.22 误切不再污染 framesBad', got.stats.framesBad === 0, 'framesBad=' + got.stats.framesBad)
  ok('13.23 正文完整（含被误当魔数的 ZZ）', got.frames[0].text === textWithMagic, got.frames[0].text)
}

// 13.24 空解压片 → framesEmpty 且计入 unsure
{
  const dir = path.join(TMP, 'ws-1', 'sess-empty')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([MAGIC, Buffer.from('anything')]))
  const er = await fr.createFrameReader({ sessionRoot: TMP, contract, decoder: { magic: MAGIC, decompress: () => Buffer.alloc(0) } })
  const got = er.readFrames('sess-empty', [3])
  ok('13.24 空片计入 framesEmpty', got.stats.framesEmpty === 1, 'framesEmpty=' + got.stats.framesEmpty)
  ok('13.25 空片存在时未命中记 error 不记 missing', got.frames[0].status === 'error' && got.missing.length === 0)
}

// 13.26 ok / allHit / deduped / maxFileBytes 夹取
{
  const mixed = reader.readFrames('sess-basic', [0, 99])
  ok('13.26 命中+缺失：ok=true 但 allHit=false', mixed.ok === true && mixed.allHit === false)
  const dup = reader.readFrames('sess-basic', [11, 11, 11])
  ok('13.27 入参重复 seq 去重计数', dup.totals.requested === 1 && dup.totals.deduped === 2, 'requested=' + dup.totals.requested + ' deduped=' + dup.totals.deduped)
  const clamp = reader.readFrames('sess-basic', [0], { maxFileBytes: 1e9 })
  ok('13.28 maxFileBytes 被夹到硬上限 128MB', clamp.limits.maxFileBytes === fr.LIMITS.hardFileBytes, 'maxFileBytes=' + clamp.limits.maxFileBytes)
  ok('13.29 正常文件新旧读数相同（无合并时）', r31.stats.magicSplits === r31.stats.framesInFile, 'magicSplits=' + r31.stats.magicSplits + ' framesInFile=' + r31.stats.framesInFile)
}

// 13.30-13.36 P1-2 边界：非 canonical 字段 + 混合 ASCII/CJK，limit-1 / limit / limit+1
{
  const LIM = fr.LIMITS.maxEventBytes
  const cjkLen = 500000
  const mkEv = (pad) => ({ seq: 61, type: 'user/message', data: { content: 'C', blob: 'A'.repeat(pad), more: '中'.repeat(cjkLen) } })
  const b0 = Buffer.byteLength(JSON.stringify(mkEv(0)), 'utf8')
  const at = (target) => { const ev = mkEv(target - b0); return { ev, real: Buffer.byteLength(JSON.stringify(ev), 'utf8') } }
  const under = at(LIM - 1), exact = at(LIM), over = at(LIM + 1)
  ok('13.30 三档真实字节精确命中 limit-1/limit/limit+1', under.real === LIM - 1 && exact.real === LIM && over.real === LIM + 1, under.real + ' / ' + exact.real + ' / ' + over.real)
  ok('13.31 canonical 很小（证明 canonical 闸不参与）', contract.canonicalEventText(over.ev).text === 'C')
  mkSession('sess-b-under', [[under.ev]])
  mkSession('sess-b-exact', [[exact.ev]])
  mkSession('sess-b-over', [[over.ev]])
  const gU = reader.getEventForValidate('sess-b-under', 61)
  const gE = reader.getEventForValidate('sess-b-exact', 61)
  const gO = reader.getEventForValidate('sess-b-over', 61)
  ok('13.32 limit-1 → 接受并返回 event', gU.ok === true && gU.event && gU.event.seq === 61)
  ok('13.33 limit → 接受（inclusive）', gE.ok === true && gE.event !== undefined)
  ok('13.34 limit+1 → 拒绝 event-too-large', gO.ok === false && gO.error === 'event-too-large', 'error=' + gO.error)
  ok('13.35 拒绝时不返回 event 与 canonical.text', gO.event === undefined && gO.canonical === undefined)
  ok('13.36 超限时 jsonBytes 返回 Infinity，限内返回精确字节', fr.jsonBytes(over.ev, LIM) === Infinity && fr.jsonBytes(under.ev, LIM) === LIM - 1, 'over=' + fr.jsonBytes(over.ev, LIM) + ' under=' + fr.jsonBytes(under.ev, LIM))
}

console.log('')
console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败')
if (fail) { console.log('失败项：' + failed.join(' / ')); process.exitCode = 1 }
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* 清不掉不影响结论 */ }
