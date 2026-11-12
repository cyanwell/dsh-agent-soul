// events · reply —— 从 DSH 会话日志里取「最后一轮说了什么」
// ============================================================================
// 为什么需要它：v4 的投递是 followup（把话送进会话就返回），**拿不回回复**。
//   而发回 QQ 需要那句回复。之前这一步由 aurabot 的 onSessionEvent 做 ——
//   它监听宿主事件、攒 assistant/message、turn/end 时发出去。
//   v4 不在宿主进程里，收不到那些事件，所以只能**回头读日志**。
//
// 为什么读日志而不是让宿主推：控制通道是单向的（v4 请求 → 宿主应答），
//   没有「宿主主动推事件」这条路。加一条要动 bridge + 重启 DSH。
//   读日志不用动任何运行中的东西，代价是延迟（轮询）和 CPU（解压）。
//
// ★ 三个必须说清的语义：
//   ① **只认「完整的一轮」**：必须有 turn/end。没有 turn/end = 还在跑，
//      这时候取到的 assistant/message 是半句 —— 发出去比不发更糟。
//   ② **只取 text 块**：assistant/message 里还有 reasoning（思考过程）。
//      那不能发到 QQ，也不能进日志（会泄露内部推理）。
//   ③ **读不到 ≠ 没说话**：坏帧/坏行/会话文件不存在必须报 error，
//      不能报「这轮没说」—— 那会让调用方以为「她选择沉默」而吞掉一次真回复。
//
// ★ 性能实测（2026-11-12，9.2MB / 8176 条 / turn 797）：
//     读文件 7ms + 解压 444ms + 解析 231ms = 688ms
//   会话会越写越大，所以**支持 maxBytes 只读尾部**（只读最后 N 字节，
//   并且从第一个完整行开始解 —— 半行会 JSON.parse 失败）。
// ============================================================================

import fs from 'node:fs'
import { resolveSessionFile, decodeSessionBytes, parseRecords } from '../organs/frame-reader.mjs'

/** 默认只读尾部这么多字节。0 = 整份读（慢，但不会被截断影响）。 */
const DEFAULT_TAIL_BYTES = 4 * 1024 * 1024
const DEFAULT_MAX_TEXT = 8000

function fail(code, error, extra) {
  return { ok: false, code, error: String(error == null ? '' : error).slice(0, 300), ...(extra || {}) }
}

/**
 * 从一段已解压的 JSONL 文本里取「最后一个完整 turn」的 assistant 正文。
 * 纯函数 —— 自检可以直接喂文本，不用真文件。
 */
export function extractLastReply(text, opts = {}) {
  const wantTurn = opts.turn != null && Number.isFinite(Number(opts.turn)) ? Number(opts.turn) : null
  const maxText = Number(opts.maxText) > 0 ? Number(opts.maxText) : DEFAULT_MAX_TEXT
  const parsed = parseRecords(text)

  // ★ 有坏行就不给结论：见头注 ③。
  if (parsed.badLines.length > 0) {
    return fail('REPLY_BAD_LINES', parsed.badLines.length + ' 行解析失败，这一轮的内容不可信', {
      badLines: parsed.badLines.length,
    })
  }
  const recs = parsed.records.map((x) => x.rec)

  // 从后往前找 turn/end —— 那是「这一轮真的说完了」的唯一证据。
  let end = null
  for (let i = recs.length - 1; i >= 0; i--) {
    const r = recs[i]
    if (r && r.type === 'turn/end') {
      const t = Number(r.data && r.data.turn)
      if (wantTurn != null && Number.isFinite(t) && t !== wantTurn) continue
      end = r
      break
    }
  }
  if (!end) return fail('REPLY_NO_TURN_END', '日志里没有 turn/end —— 还在跑，或者这一轮没正常结束')

  const turn = Number(end.data && end.data.turn)
  const reason = end.data && end.data.reason ? String(end.data.reason.kind || '') : ''
  if (reason && reason !== 'completed') {
    return fail('REPLY_NOT_COMPLETED', '这一轮没正常结束：' + reason, { turn })
  }

  // 收集这一轮所有 assistant/message 的 text 块（reasoning 一律丢掉）。
  const parts = []
  for (const r of recs) {
    if (!r || r.type !== 'assistant/message') continue
    const d = r.data || {}
    if (Number(d.turn) !== turn) continue
    if (d.interrupted) continue
    const content = d.message && Array.isArray(d.message.content) ? d.message.content : []
    for (const p of content) {
      if (p && p.type === 'text' && typeof p.text === 'string' && p.text.trim()) parts.push(p.text)
    }
  }
  const body = parts.join('\n').trim()
  if (!body) return fail('REPLY_EMPTY', '这一轮没有正文（只有思考或工具调用）', { turn })

  return {
    ok: true,
    turn,
    seq: typeof end.seq === 'number' ? end.seq : null,
    time: typeof end.time === 'number' ? end.time : null,
    text: body.length > maxText ? body.slice(0, maxText) : body,
    chars: body.length,
    truncated: body.length > maxText,
  }
}

/**
 * createReplyReader({ sessionRoot, tailBytes, log }) → { lastReply(sessionId, opts) }
 *
 * ★ 每次调用都重新读文件：会话在跑，内容随时会长。**不缓存** ——
 *   缓存要判失效，而判据（mtime + size）在这里不比直接读便宜。
 */
export function createReplyReader(opts = {}) {
  const sessionRoot = String(opts.sessionRoot || '').trim()
  if (!sessionRoot) throw new Error('createReplyReader 需要 sessionRoot（DSH 的 home/sessions 目录）')
  const tailBytes = Number.isFinite(Number(opts.tailBytes)) ? Number(opts.tailBytes) : DEFAULT_TAIL_BYTES
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const counters = { reads: 0, ok: 0, failed: 0, lastAt: null, lastError: null }

  function lastReply(sessionId, callOpts = {}) {
    counters.reads += 1
    counters.lastAt = new Date().toISOString()

    const r = resolveSessionFile(sessionId, { sessionRoot })
    if (!r.ok) {
      counters.failed += 1
      counters.lastError = r.reason
      return fail('REPLY_NO_SESSION_FILE', r.reason, { sessionId })
    }

    let buf
    try {
      buf = fs.readFileSync(r.realFile || r.file)
    } catch (e) {
      counters.failed += 1
      counters.lastError = String((e && e.message) || e)
      return fail('REPLY_READ_FAILED', (e && e.message) || e, { sessionId })
    }

    // ★ 只读尾部：从文件末尾切 tailBytes，再往后找到第一个换行 ——
    //   否则第一行是半截 JSON，一定 parse 失败（而失败会被当成「坏行」拒绝整轮）。
    let sliced = buf
    let trimmedHead = false
    if (tailBytes > 0 && buf.length > tailBytes) {
      sliced = buf.subarray(buf.length - tailBytes)
      const nl = sliced.indexOf(0x0a)
      if (nl >= 0) { sliced = sliced.subarray(nl + 1); trimmedHead = true }
    }

    const dec = decodeSessionBytes(sliced, {})
    if (!dec.ok) {
      counters.failed += 1
      counters.lastError = (dec.bad && dec.bad[0] && dec.bad[0].reason) || 'decode failed'
      // ★ 尾部切片可能正好切断一个 zstd 帧 —— 这种情况退回整份读一次。
      if (trimmedHead) return lastReplyWhole(sessionId, buf, callOpts)
      return fail('REPLY_DECODE_FAILED', counters.lastError, { sessionId })
    }

    const out = extractLastReply(dec.text, callOpts)
    if (out.ok) { counters.ok += 1 } else { counters.failed += 1; counters.lastError = out.code }
    return out
  }

  function lastReplyWhole(sessionId, buf, callOpts) {
    log('尾部切片解不开，退回整份读：' + sessionId)
    const dec = decodeSessionBytes(buf, {})
    if (!dec.ok) return fail('REPLY_DECODE_FAILED', '整份读也解不开', { sessionId })
    const out = extractLastReply(dec.text, callOpts)
    if (out.ok) counters.ok += 1
    return out
  }

  return {
    lastReply,
    view() {
      return {
        sessionRoot,
        tailBytes,
        reads: counters.reads,
        ok: counters.ok,
        failed: counters.failed,
        lastAt: counters.lastAt,
        lastError: counters.lastError,
      }
    },
  }
}
