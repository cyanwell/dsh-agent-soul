// frame-reader —— 从真实会话日志里按 seq 精读极少量帧（S3a）
//
// 解决什么：S3 的诊断要「先看元数据、再精读几帧原文」，而 v4 手上只有快照里的
//   seq/type/chars/sha256，没有正文。要看正文就得回原始日志取 —— 但**不能全库扫、
//   不能把整份历史塞进上下文**。所以这里只做一件事：给一组 seq，回这几帧。
//
// ★ 分帧能力不是新写的：D:\AI\memory\tools\sessionlook.mjs 已经在生产里用过
//   「按 zstd 魔数切帧 → 逐帧解压 → 拼起来按行 JSON.parse」。这里把它抽成可 import
//   的纯函数，语义照抄、加边界。原文件一行没改。
//
// ★★ 三条不许含糊的语义（契约 C4 的延伸）：
//   ① 读不到 != 不存在。坏行 / 坏帧 / 空解压片都会让「这个 seq 不存在」这个结论不可信，
//      所以只要有任何一样，未命中的 seq 一律报 error，绝不报 missing。
//   ② hash 只对**完整** canonicalText 算，不对截断后的正文算。
//   ③ 正文可截断、hash 不可；每帧同时给 chars（实际给了多少）与 fullChars（完整多长）。
//
// ★★★ 2026-11-08 返修（独立验证 P1-1 / P1-2 / P2-1 / P2-2）：
//   P1-1 根外 junction：不再信字面路径。先 lstat（必须是真目录/真文件、不是链接），
//        再 realpathSync.native 拿真实路径，要求真实路径仍在真实根之内。
//   P1-2 event 无界：**返回前**按字节算体。三条上界（原始 event / canonical 正文 /
//        整个返回体）任何一条超了都**拒绝**（ok:false），
//        **不返回截断的 event、也不返回截断的 canonical.text**，更不做「剥掉图片
//        再当完整 event 返回」那种投影冒充 —— 半份数据被当成完整数据去做 mixed/expect
//        校验，比拒绝危险得多。
//        字节口径：**一律 Buffer.byteLength(x, 'utf8')**，不是字符数、不是 length*4 估算。
//   P2-1 解压无界：逐帧走解码器内部的 maxOutputLength（解压过程本身被截住，
//        不是解完再查）；另有 maxDecodedBytes 累计预算；超限整次失败、不降级成 missing。
//   P2-2 魔数误切：解压失败不再立刻定案，先与下一片合并重试（最多 maxMergeFrames 片）；
//        成功即说明那个魔数是载荷里的巧合。解压成功但输出 0 字节 → framesEmpty（与 bad 同权）。
//        ★ 契约语义变更：framesInFile 保留字段名，但**旧义（魔数出现次数）废弃并移入
//        magicSplits**；现义 = 合并后确认的帧数（decoded + bad）。
//
// ★ 依赖注入（便于离线测试）：sessionRoot / decoder / contract 都可换。
//   contract 必须由外部给 —— 本模块绝不自己实现 hash。

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { appRoot, devPathOr, devFileOr } from '../config.mjs'

/** zstd 帧魔数（0x28 B5 2F FD）。sessionlook.mjs:29 用的同一个常量。 */
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 默认会话根目录。生产侧应显式传 sessionRoot。 */
// ★ 2026-11-10（R1）：会话根同样走「开发默认存在才用」，分发版落到 <安装根>/workspace/sessions。
export const DEFAULT_SESSION_ROOT = devPathOr('sessionRoot', path.join(appRoot(), 'workspace', 'sessions'))

/** pruner 契约的默认位置（唯一 hash 实现）。
 *  ★ 2026-11-10（R1）：不再把开发机路径无条件当默认 —— AGENT_SOUL_PRUNER_CONTRACT 优先，
 *    开发默认**只在文件存在时**用，都没有则是空串（loadContract 说「未配置」，
 *    而不是把 ERR_MODULE_NOT_FOUND + 开发机路径甩给用户）。 */
export const DEFAULT_CONTRACT_PATH = process.env.AGENT_SOUL_PRUNER_CONTRACT || devFileOr('prunerContract', '')

/** 硬上限。调用方给的数只能比它小；超过一律拒绝，不静默截断。 */
export const LIMITS = Object.freeze({
  maxFrames: 12,              // 一次最多几帧
  defaultFrames: 6,           // 不指定 seqs 时取最近几帧
  maxCharsPerFrame: 8000,     // 单帧正文字符上限（默认）
  maxTotalChars: 24000,       // 一次调用总正文字符上限
  hardCharsPerFrame: 32000,   // 单帧可配置天花板
  hardTotalChars: 96000,      // 总量可配置天花板
  maxFileBytes: 64 * 1024 * 1024,     // 单文件读取默认上限
  hardFileBytes: 128 * 1024 * 1024,   // 单文件读取硬上限
  maxDecodedBytes: 256 * 1024 * 1024, // 一次调用累计解压输出上限
  maxMergeFrames: 8,                  // 魔数误切时最多合并几片再试
  maxEventBytes: 2 * 1024 * 1024,     // getEventForValidate：原始 event 的 JSON 字节上限
  maxCanonicalBytes: 2 * 1024 * 1024, // getEventForValidate：canonical 正文的 UTF-8 字节上限
  maxResponseBytes: 4 * 1024 * 1024,  // getEventForValidate：整个成功返回体的字节上限
})

/** 会话号白名单：只放行最小集合，且不许以 . 或 - 开头（从根上排除 ..、盘符、UNC）。 */
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** 校验会话号。 */
export function checkSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return { ok: false, reason: 'sessionId 必须是非空字符串' }
  if (!SESSION_ID_RE.test(sessionId)) return { ok: false, reason: 'sessionId 只允许 [A-Za-z0-9._-]、且不能以 . 或 - 开头' }
  if (sessionId.includes('..')) return { ok: false, reason: 'sessionId 不许含 ..' }
  return { ok: true, reason: null }
}

/**
 * 一个值 JSON 序列化后的**精确 UTF-8 字节数**。
 * ★ 只用 Buffer.byteLength，不用 length*4 之类的估算：
 *   转义（控制字符会膨胀成 \u00XX）、中文（3 字节）、emoji（4 字节）都算得对。
 * ★ 超过 limit 立刻返回 Infinity（早退）：单条字符串先用「UTF-16 码元数 <= UTF-8 字节数」
 *   这一步裁掉超大输入，避免为了算长度去构造几十 MB 的中间串。
 */
export function jsonBytes(v, limit) {
  const lim = Number.isFinite(limit) ? limit : LIMITS.maxEventBytes
  let n = 0
  const walk = (x) => {
    if (n > lim) return
    if (x === null || x === undefined) { n += 4; return }
    const t = typeof x
    if (t === 'string') {
      // 码元数 <= UTF-8 字节数是恒成立的，所以这一步只可能「提前判超」，不会漏判
      if (n + x.length > lim) { n = Infinity; return }
      n += Buffer.byteLength(JSON.stringify(x), 'utf8')
      return
    }
    if (t === 'number' || t === 'boolean') { n += Buffer.byteLength(JSON.stringify(x), 'utf8'); return }
    if (Array.isArray(x)) {
      n += 2
      for (let i = 0; i < x.length; i++) {
        if (n > lim) { n = Infinity; return }
        if (i) n += 1
        walk(x[i])
      }
      return
    }
    if (t === 'object') {
      n += 2
      const keys = Object.keys(x)
      let first = true
      for (const k of keys) {
        if (x[k] === undefined) continue
        if (n > lim) { n = Infinity; return }
        if (!first) n += 1
        first = false
        if (n + k.length > lim) { n = Infinity; return }
        n += Buffer.byteLength(JSON.stringify(k), 'utf8') + 1
        walk(x[k])
      }
      return
    }
    n += 4
  }
  walk(v)
  // ★ 契约：要么 <= lim 的有限值，要么 Infinity —— 绝不返回「有限但超额」的值
  return n > lim ? Infinity : n
}

/** Windows 路径大小写不敏感；比较前统一归一。 */
function normCase(p) {
  return process.platform === 'win32' ? String(p).toLowerCase() : String(p)
}

/** 真实路径是否仍在真实根之内（按分隔符对齐，防 C:\a 与 C:\ab 的前缀误判）。 */
function isRealInside(realRoot, realTarget) {
  const r = normCase(path.resolve(realRoot))
  const t = normCase(path.resolve(realTarget))
  if (t === r) return true
  return t.startsWith(r.endsWith(path.sep) ? r : r + path.sep)
}

/** 字面包含检查（便宜的预筛；真正的判据是 isRealInside）。 */
function isInside(root, target) {
  const r = path.resolve(root)
  const t = path.resolve(target)
  const rel = path.relative(r, t)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * 在一个目录里挑会话文件。三道闸：
 *   ① 目录本身必须 lstat 为真目录、不是链接（junction/symlink 直接拒）；
 *   ② 候选文件必须 lstat 为常规文件、不是链接；
 *   ③ 候选文件的 realpathSync.native 必须仍在真实根之内。
 */
function pickSessionFile(dir, realRoot) {
  let st
  try { st = fs.lstatSync(dir) } catch { return null }
  if (!st.isDirectory() || st.isSymbolicLink()) return null
  let names = []
  try { names = fs.readdirSync(dir) } catch { return null }
  const cands = names.filter((n) => /^session.*\.jsonl\.zstd$/i.test(n)).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  for (const name of cands) {
    const full = path.join(dir, name)
    let lst
    try { lst = fs.lstatSync(full) } catch { continue }
    if (!lst.isFile() || lst.isSymbolicLink()) continue
    let real
    try { real = fs.realpathSync.native(full) } catch { continue }
    if (!isRealInside(realRoot, real)) continue
    return { file: full, realFile: real }
  }
  return null
}

/**
 * 在受控根目录下定位会话文件。
 * 真实布局：<root>/<工作区目录>/<会话id>/session.v4.jsonl.zstd（也接受扁平布局）。
 * 返回 { ok, file, realFile, layout } —— realFile 是真实路径，供审计。
 */
export function resolveSessionFile(sessionId, opts = {}) {
  const root = path.resolve(opts.sessionRoot || DEFAULT_SESSION_ROOT)
  const chk = checkSessionId(sessionId)
  if (!chk.ok) return { ok: false, reason: 'bad-session-id: ' + chk.reason, file: null, realFile: null }

  let realRoot
  try { realRoot = fs.realpathSync.native(root) } catch { return { ok: false, reason: 'session-root-missing: ' + root, file: null, realFile: null } }

  const flatDir = path.join(root, sessionId)
  if (isInside(root, flatDir)) {
    const flat = pickSessionFile(flatDir, realRoot)
    if (flat) return { ok: true, file: flat.file, realFile: flat.realFile, layout: 'flat', reason: null }
  }

  let workspaces = []
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch { /* 根读不了：落到 not-found */ }
  for (const ws of workspaces) {
    const dir = path.join(root, ws, sessionId)
    if (!isInside(root, dir)) continue
    const f = pickSessionFile(dir, realRoot)
    if (f) return { ok: true, file: f.file, realFile: f.realFile, layout: 'workspace', workspace: ws, reason: null }
  }
  return { ok: false, reason: 'not-found: 根目录下没有这个会话的 session*.jsonl.zstd', file: null, realFile: null }
}

/**
 * 把整份文件字节切成帧、逐帧解压、拼成 JSONL 文本。
 * decoder 可注入：{ decompress(buf, opts) -> Buffer, magic?: Buffer }。
 * ★ 合并重试不绕过预算：每次尝试都带同一个剩余额度。
 */
export function decodeSessionBytes(buf, opts = {}) {
  const dec = opts.decoder || {}
  const decompress = dec.decompress || ((u8, o) => zlib.zstdDecompressSync(u8, o))
  const magic = dec.magic || ZSTD_MAGIC
  const maxDecodedBytes = numOr(opts.maxDecodedBytes, LIMITS.maxDecodedBytes, 1, Number.MAX_SAFE_INTEGER)
  const maxMergeFrames = numOr(opts.maxMergeFrames, LIMITS.maxMergeFrames, 0, 64)

  const starts = []
  let at = 0
  let hit
  while ((hit = buf.indexOf(magic, at)) !== -1) { starts.push(hit); at = hit + magic.length }

  const stats = {
    magicSplits: starts.length,      // 原始魔数出现次数（framesInFile 的旧口径）
    framesInFile: 0,                 // 现口径：合并后确认的帧数 = decoded + bad
    framesDecoded: 0,
    framesMerged: 0,
    framesBad: 0,
    framesEmpty: 0,
    decodedBytes: 0,
    bytes: buf.length,
  }
  const badFrames = []
  const chunks = []
  let left = maxDecodedBytes
  let i = 0

  while (i < starts.length) {
    if (left <= 0) {
      return { ok: false, error: 'decompress-limit', reason: '累计解压输出已达上限 ' + maxDecodedBytes + ' B', stats, badFrames, limit: maxDecodedBytes }
    }
    let out = null
    let used = 0
    let lastErr = null
    const maxMerge = Math.min(maxMergeFrames, starts.length - i - 1)
    for (let m = 0; m <= maxMerge; m++) {
      const from = starts[i]
      const to = i + m + 1 < starts.length ? starts[i + m + 1] : buf.length
      try {
        const piece = decompress(buf.subarray(from, to), { maxOutputLength: left })
        out = Buffer.from(piece)
        used = m + 1
        break
      } catch (e) {
        if (e && e.code === 'ERR_BUFFER_TOO_LARGE') {
          return { ok: false, error: 'decompress-limit', reason: '解压输出超过剩余额度（第 ' + i + ' 帧起，总上限 ' + maxDecodedBytes + ' B）', stats, badFrames, limit: maxDecodedBytes }
        }
        lastErr = e
      }
    }
    if (!out) {
      stats.framesBad++
      stats.framesInFile++
      badFrames.push({ frame: i, offset: starts[i], reason: String((lastErr && lastErr.message) || lastErr || 'decode-failed') })
      i += 1
      continue
    }
    if (out.length > left) {
      return { ok: false, error: 'decompress-limit', reason: '注入解码器返回超限（第 ' + i + ' 帧起）', stats, badFrames, limit: maxDecodedBytes }
    }
    if (used > 1) stats.framesMerged++
    if (out.length === 0) stats.framesEmpty++
    left -= out.length
    stats.decodedBytes += out.length
    if (out.length) chunks.push(out)
    stats.framesDecoded++
    stats.framesInFile++
    i += used
  }

  const text = chunks.length ? Buffer.concat(chunks).toString('utf8') : ''
  return { ok: stats.framesBad === 0, text, stats, badFrames, limit: maxDecodedBytes }
}

/** 文本 → 记录。坏行留下来记账，不静默丢。 */
export function parseRecords(text) {
  const records = []
  const badLines = []
  const lines = String(text == null ? '' : text).split('\n')
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim()
    if (!s) continue
    try {
      const r = JSON.parse(s)
      if (r && typeof r === 'object') records.push({ line: i + 1, rec: r })
      else badLines.push({ line: i + 1, reason: 'not-an-object' })
    } catch (e) {
      badLines.push({ line: i + 1, reason: 'json-parse: ' + String((e && e.message) || e) })
    }
  }
  return { records, badLines }
}

/** seq → 记录。按真实 seq 索引；没有 seq 的记录（如 session 头）单独计数。 */
export function indexBySeq(records) {
  const bySeq = new Map()
  let withoutSeq = 0
  const dupSeqs = []
  for (const it of records) {
    const seq = it.rec && it.rec.seq
    if (typeof seq !== 'number' || !Number.isFinite(seq)) { withoutSeq++; continue }
    if (bySeq.has(seq)) dupSeqs.push(seq)
    else bySeq.set(seq, it)
  }
  return { bySeq, withoutSeq, dupSeqs }
}

function contractApi(contract) {
  if (!contract || typeof contract.canonicalEventText !== 'function') {
    throw new Error('contract 不可用：需要 canonicalEventText（pruner context-contract.mjs v2）')
  }
  return {
    version: contract.CONTRACT_VERSION == null ? null : contract.CONTRACT_VERSION,
    canonicalEventText: contract.canonicalEventText,
    ptr: typeof contract.framePtr === 'function' ? contract.framePtr : null,
  }
}

/** 载入 pruner 契约（唯一 hash 实现）。路径可注入。 */
export async function loadContract(p = DEFAULT_CONTRACT_PATH) {
  if (!p) throw new Error('pruner 契约未配置：设置 AGENT_SOUL_PRUNER_CONTRACT 指向 context-contract.mjs（本模块不自造 hash）')
  const mod = await import(pathToFileURL(path.resolve(p)).href)
  if (mod.CONTRACT_VERSION !== 2) throw new Error('契约版本不是 2（拿到 ' + mod.CONTRACT_VERSION + '），拒绝使用')
  return mod
}

/**
 * 建一个读取器。所有外部依赖都在这里注入。
 *   sessionRoot —— 受控根目录（内部用 realpath 解析后的真实根做包含判断）
 *   contract    —— pruner 契约模块（必须；不 fallback、不自造 hash）
 *   decoder     —— { decompress, magic }（默认 node:zlib 的 zstd）
 */
export async function createFrameReader(opts = {}) {
  const api = contractApi(opts.contract || (await loadContract(opts.contractPath || DEFAULT_CONTRACT_PATH)))
  const sessionRoot = path.resolve(opts.sessionRoot || DEFAULT_SESSION_ROOT)
  const decoder = opts.decoder || null

  function loadSession(sessionId, o) {
    const loc = resolveSessionFile(sessionId, { sessionRoot })
    if (!loc.ok) {
      const isRoot = String(loc.reason || '').startsWith('session-root-missing')
      return { ok: false, error: isRoot ? 'session-root-missing' : 'session-not-found', reason: loc.reason }
    }
    let st
    try { st = fs.statSync(loc.realFile || loc.file) } catch (e) { return { ok: false, error: 'stat-failed', reason: String((e && e.message) || e) } }
    const maxBytes = numOr(o.maxFileBytes, LIMITS.maxFileBytes, 1, LIMITS.hardFileBytes)
    if (st.size > maxBytes) {
      return { ok: false, error: 'file-too-large', reason: '会话文件 ' + st.size + ' B 超过上限 ' + maxBytes + ' B' }
    }
    let buf
    try { buf = fs.readFileSync(loc.realFile || loc.file) } catch (e) { return { ok: false, error: 'read-failed', reason: String((e && e.message) || e) } }

    const maxDecodedBytes = numOr(o.maxDecodedBytes, LIMITS.maxDecodedBytes, 1, Number.MAX_SAFE_INTEGER)
    const dec = decodeSessionBytes(buf, { decoder, maxDecodedBytes, maxMergeFrames: o.maxMergeFrames })
    if (dec.error === 'decompress-limit') {
      return { ok: false, error: 'decompress-limit', reason: dec.reason, limit: dec.limit }
    }
    const parsed = parseRecords(dec.text)
    const idx = indexBySeq(parsed.records)
    return {
      ok: true,
      file: loc.file, realFile: loc.realFile, layout: loc.layout, bytes: buf.length,
      maxFileBytes: maxBytes, maxDecodedBytes,
      stats: dec.stats, badFrames: dec.badFrames, badLines: parsed.badLines,
      bySeq: idx.bySeq, withoutSeq: idx.withoutSeq, dupSeqs: idx.dupSeqs,
      seqs: [...idx.bySeq.keys()].sort((a, b) => a - b),
    }
  }

  /**
   * 精读若干帧。
   * @param {string} sessionId
   * @param {number[]} [seqs] 不给 = 取最近 maxFrames 帧
   * @param {object} [o] { maxFrames, maxCharsPerFrame, maxTotalChars, maxFileBytes, maxDecodedBytes }
   */
  function readFrames(sessionId, seqs, o = {}) {
    const maxFrames = numOr(o.maxFrames, LIMITS.defaultFrames, 1, LIMITS.maxFrames)
    const maxCharsPerFrame = numOr(o.maxCharsPerFrame, LIMITS.maxCharsPerFrame, 1, LIMITS.hardCharsPerFrame)
    const maxTotalChars = numOr(o.maxTotalChars, LIMITS.maxTotalChars, 1, LIMITS.hardTotalChars)
    const chk = checkSessionId(sessionId)
    if (!chk.ok) return { ok: false, error: 'bad-session-id', reason: chk.reason, frames: [] }

    const asked = normalizeSeqs(seqs)
    if (asked.error) return { ok: false, error: asked.error, reason: asked.reason, frames: [] }
    if (asked.list.length > LIMITS.maxFrames) {
      return { ok: false, error: 'too-many-seqs', reason: '一次最多 ' + LIMITS.maxFrames + ' 个 seq（收到 ' + asked.list.length + '），不静默截断', frames: [] }
    }

    const loaded = loadSession(sessionId, o)
    if (!loaded.ok) return { ok: false, error: loaded.error, reason: loaded.reason, limit: loaded.limit, frames: [] }

    let want = asked.list
    if (!want.length) want = loaded.seqs.slice(-maxFrames)
    else if (want.length > maxFrames) {
      return { ok: false, error: 'too-many-seqs', reason: 'maxFrames=' + maxFrames + '，收到 ' + want.length + ' 个 seq（不静默截断）', frames: [] }
    }

    // ★ 坏帧 / 空解压片 / 坏行 —— 任意一样，「找不到」这个结论都不成立
    const unsure = loaded.stats.framesBad > 0 || loaded.stats.framesEmpty > 0 || loaded.badLines.length > 0

    let left = maxTotalChars
    const frames = []
    const missing = []
    const truncated = []
    const errors = []

    for (const seq of want) {
      const hit = loaded.bySeq.get(seq)
      if (!hit) {
        if (unsure) {
          const reason = 'unreadable-lines-may-contain-seq: 文件里有 ' + loaded.badLines.length + ' 个坏行 / '
            + loaded.stats.framesBad + ' 个坏帧 / ' + loaded.stats.framesEmpty + ' 个空解压片，无法断言这个 seq 不存在'
          frames.push({ seq, status: 'error', reason, ptr: api.ptr ? api.ptr(sessionId, seq) : null })
          errors.push({ seq, reason })
        } else {
          frames.push({ seq, status: 'missing', reason: '该 seq 不在日志里', ptr: api.ptr ? api.ptr(sessionId, seq) : null })
          missing.push(seq)
        }
        continue
      }

      const event = hit.rec
      let can
      try { can = api.canonicalEventText(event) }
      catch (e) {
        const reason = 'canonical-failed: ' + String((e && e.message) || e)
        frames.push({ seq, status: 'error', reason, ptr: api.ptr ? api.ptr(sessionId, seq) : null })
        errors.push({ seq, reason })
        continue
      }

      const full = typeof can.text === 'string' ? can.text : ''
      const perBudget = Math.min(maxCharsPerFrame, Math.max(0, left))
      const text = full.length > perBudget ? full.slice(0, perBudget) : full
      const isTrunc = text.length < full.length
      left -= text.length
      if (isTrunc) truncated.push(seq)

      frames.push({
        seq,
        status: isTrunc ? 'truncated' : 'ok',
        type: event.type || null,
        text,
        chars: text.length,
        fullChars: full.length,
        truncated: isTrunc,
        sha256: can.sha256 == null ? null : can.sha256,
        hashSupported: can.supported === true,
        hashReason: can.reason == null ? null : can.reason,
        mixed: can.mixed === true,
        ptr: api.ptr ? api.ptr(sessionId, seq) : null,
        truncatedReason: isTrunc ? (perBudget < maxCharsPerFrame ? 'total-budget-exhausted' : 'per-frame-cap') : null,
      })
    }

    return {
      ok: errors.length === 0,
      allHit: errors.length === 0 && missing.length === 0,
      session: sessionId,
      file: loaded.file,
      realFile: loaded.realFile,
      fileBytes: loaded.bytes,
      contractVersion: api.version,
      frames,
      missing,
      truncated,
      errors,
      totals: { requested: want.length, frames: frames.length, chars: frames.reduce((n, f) => n + (f.chars || 0), 0), deduped: asked.deduped },
      limits: { maxFrames, maxCharsPerFrame, maxTotalChars, maxFileBytes: loaded.maxFileBytes, maxDecodedBytes: loaded.maxDecodedBytes },
      stats: {
        magicSplits: loaded.stats.magicSplits,
        framesInFile: loaded.stats.framesInFile,
        framesDecoded: loaded.stats.framesDecoded,
        framesMerged: loaded.stats.framesMerged,
        framesBad: loaded.stats.framesBad,
        framesEmpty: loaded.stats.framesEmpty,
        decodedBytes: loaded.stats.decodedBytes,
        badLines: loaded.badLines.length,
        recordsScanned: loaded.bySeq.size + loaded.withoutSeq,
        withoutSeq: loaded.withoutSeq,
        dupSeqs: loaded.dupSeqs,
      },
      notes: buildNotes(loaded),
    }
  }

  function buildNotes(loaded) {
    const notes = []
    if (/session\.v4\./i.test(loaded.file)) notes.push('日志文件名是 session.v4.jsonl.zstd（调查文档写的是 v3；两种都接受）')
    if (loaded.withoutSeq > 0) notes.push(loaded.withoutSeq + ' 条记录没有 seq（会话头等），不参与 seq 索引')
    if (loaded.dupSeqs.length) notes.push('重复 seq：' + loaded.dupSeqs.join(',') + '（取第一条）')
    if (loaded.stats.framesMerged > 0) notes.push('魔数误切合并了 ' + loaded.stats.framesMerged + ' 次（magicSplits=' + loaded.stats.magicSplits + '）')
    if (loaded.stats.framesEmpty > 0) notes.push(loaded.stats.framesEmpty + ' 个空解压片（按可疑处理）')
    return notes
  }

  /**
   * **内部专用**：给 validate 层拿完整 event。三条字节上界，任何一条超了都**拒绝**：
   *   ① 原始 event 的 JSON UTF-8 字节（Buffer.byteLength 口径）> maxEventBytes
   *   ② canonical 正文的 UTF-8 字节 > maxCanonicalBytes
   *   ③ 整个成功返回体的 JSON UTF-8 字节 > maxResponseBytes
   * ★ 拒绝时不返回 event、也不返回 canonical.text —— 只给 canonicalMeta（元数据）。
   * ★ 不投影、不剥图片：完整就是完整，不完整就拒绝。
   */
  function getEventForValidate(sessionId, seq, o = {}) {
    const chk = checkSessionId(sessionId)
    if (!chk.ok) return { ok: false, error: 'bad-session-id', reason: chk.reason }
    const n = Number(seq)
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return { ok: false, error: 'bad-seq', reason: 'seq 必须是非负整数' }
    const loaded = loadSession(sessionId, o)
    if (!loaded.ok) return { ok: false, error: loaded.error, reason: loaded.reason, limit: loaded.limit }
    const hit = loaded.bySeq.get(n)
    if (!hit) {
      const unsure = loaded.stats.framesBad > 0 || loaded.stats.framesEmpty > 0 || loaded.badLines.length > 0
      return {
        ok: false,
        error: unsure ? 'unreadable-may-contain-seq' : 'missing',
        reason: '该 seq 不在日志里' + (unsure ? '（且有坏行/坏帧/空片，结论不完全可信）' : ''),
        session: sessionId, seq: n,
      }
    }

    const event = hit.rec
    const can = api.canonicalEventText(event)
    const canonicalText = typeof can.text === 'string' ? can.text : ''
    const canonicalBytes = Buffer.byteLength(canonicalText, 'utf8')
    const meta = {
      supported: can.supported === true,
      chars: typeof can.chars === 'number' ? can.chars : canonicalText.length,
      bytes: canonicalBytes,
      sha256: can.sha256 == null ? null : can.sha256,
      reason: can.reason == null ? null : can.reason,
      mixed: can.mixed === true,
    }
    const ptr = api.ptr ? api.ptr(sessionId, n) : null
    const refuse = (error, extra) => Object.assign({
      ok: false, internal: 'validate-only', error, session: sessionId, seq: n,
      canonicalMeta: meta, ptr,
      note: '超限即拒绝：不返回截断的 event、也不返回截断的 canonical.text',
    }, extra || {})

    const eventBytes = jsonBytes(event, LIMITS.maxEventBytes)
    if (eventBytes > LIMITS.maxEventBytes) {
      return refuse('event-too-large', { limit: LIMITS.maxEventBytes, eventBytesAtLeast: LIMITS.maxEventBytes + 1 })
    }
    if (canonicalBytes > LIMITS.maxCanonicalBytes) {
      return refuse('canonical-too-large', { limit: LIMITS.maxCanonicalBytes, canonicalBytes })
    }

    const out = {
      ok: true,
      internal: 'validate-only',
      session: sessionId,
      seq: n,
      type: event.type || null,
      event,
      canonical: {
        supported: can.supported === true,
        text: canonicalText,
        chars: typeof can.chars === 'number' ? can.chars : canonicalText.length,
        bytes: canonicalBytes,
        sha256: can.sha256 == null ? null : can.sha256,
        reason: can.reason == null ? null : can.reason,
        mixed: can.mixed === true,
      },
      ptr,
      eventBytes,
    }
    const responseBytes = jsonBytes(out, LIMITS.maxResponseBytes)
    if (responseBytes > LIMITS.maxResponseBytes) {
      return refuse('response-too-large', { limit: LIMITS.maxResponseBytes, eventBytes })
    }
    out.responseBytes = responseBytes
    return out
  }

  return {
    readFrames,
    getEventForValidate,
    contractVersion: api.version,
    sessionRoot,
    fileForSession: (sid) => resolveSessionFile(sid, { sessionRoot }),
  }
}

/** 默认读取器（懒加载契约；只给本机/调试用）。 */
let _default = null
export async function defaultReader(opts = {}) {
  if (!_default || opts.sessionRoot || opts.decoder || opts.contract) _default = await createFrameReader(opts)
  return _default
}

function numOr(v, def, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

function normalizeSeqs(seqs) {
  if (seqs == null) return { list: [], deduped: 0, error: null, reason: null }
  if (!Array.isArray(seqs)) return { list: [], deduped: 0, error: 'bad-seqs', reason: 'seqs 必须是数组' }
  const out = []
  const seen = new Set()
  let deduped = 0
  for (const v of seqs) {
    const n = Number(v)
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      return { list: [], deduped: 0, error: 'bad-seqs', reason: 'seq 必须是非负整数，收到 ' + JSON.stringify(v) }
    }
    if (seen.has(n)) { deduped++; continue }
    seen.add(n)
    out.push(n)
  }
  return { list: out, deduped, error: null, reason: null }
}
