// lead-relay 只读 ingress（core 侧；队列仍归别人写）
// ============================================================================
// 迁入自原型 plugins/aurabot-ingress/src/ingress-lead-relay.mjs（2026-11-10）。
// 队列是「分身用工具上报」写进来的（aurabot-modules/lead-relay/index.mjs:83），
// 与 QQ 消息不是同一条流 —— 所以它是**第二种 ingress**，不是搬一个文件。
//
// ★ 只读纪律（三条，任何一条破了都会毁掉别人的写域）：
//   ① 不接管写入：队列仍然只有 lead-relay 写。本文件对 queuePath 只做 read。
//   ② 不写 sessions.json：chatId→会话 的映射归 hub，这里只抄 chatId 进 Envelope。
//   ③ 不改旧组件：不 reload 模块、不 stop 任何东西。
//   ★ core 化之后多一条：**不把队列内容再立一份权威**。Envelope 只是索引（含 payload
//     原文 + raw_ptr），权威仍是队列文件本身；快照/游标都落在 core 自己的 events 目录里。
//
// ★ 读法（两条）：
//   · 读**完整行**：只消费到最后一个换行，半行留在原地等下一次（cursor 不前移）。
//   · 坏行/半行**可见**：坏行进错误账（行号+字节偏移+脱敏摘要），半行进状态。
// ============================================================================

import fs from 'node:fs'
import { buildEnvelope } from './envelope.mjs'

export const LEAD_RELAY_KEEP_FIELDS = [
  't', 'status', 'auditDeadline', 'outcome', 'tier', 'title', 'facts', 'why',
  'chatId', 'kind', 'userId', 'groupId', 'level',
]

export function createLeadRelayIngress (opts = {}) {
  const {
    store,
    queuePath,
    pollMs = 2000,
    bootId = '',
    redact = (s) => String(s),
    log = () => {},
    now = () => Date.now(),
    maxLineBytes = 256 * 1024,
    onFlush = null,
  } = opts

  const counters = {
    polls: 0,
    lines: 0,
    envelopes: 0,
    dup: 0,
    badLines: 0,
    truncated: 0,
    rejected: 0,
    // ★ 以下两个是 2026-11-10 可靠性修复加的「可观察面」：
    stalled: 0,          // 因为拒写而卡在同一行的**轮询次数**（>0 = 队列被卡住，不是静默跳过）
    pollsAfterStop: 0,   // stop() 之后仍被调用的轮询次数（迟到轮询一律拒绝，但要能看见）
  }
  const state = {
    id: 'lead-relay',
    enabled: Boolean(queuePath),
    state: queuePath ? 'idle' : 'disabled',
    connected: false,
    lastEventAt: null,
    lastError: null,
    lastSource: 'lead-relay',
    partialTail: null,
    lastBad: null,
    // ★ 卡住的现场（offset/line/code）+ 上一次卡住的 code —— 用来「同一行只记一条错误」，
    //   否则磁盘满的时候每 2 秒往 errors.jsonl 里刷一行，把错误账也写坏。
    blocked: null,
    lastBlockedCode: null,
    stoppedAt: null,
  }

  let offset = 0
  let lineNo = 0
  let timer = null
  let stopped = false

  // 游标：场外快照（存在 core 的 events 目录里，不写队列目录）
  if (store && store.getCursor) {
    const cur = store.getCursor('lead-relay')
    if (Number.isFinite(cur && cur.offset)) {
      offset = cur.offset
      lineNo = Number(cur.line) || 0
    }
  }

  const note = (code, detail) => {
    const row = store && store.pushError ? store.pushError(code, redact(detail)) : { t: new Date(now()).toISOString(), code, detail: redact(detail) }
    state.lastError = { code, detail: redact(detail), at: row.t }
    log('[lead-relay] ' + code + ' ' + redact(detail))
    return row
  }

  function saveCursor () {
    if (store && store.setCursor) store.setCursor('lead-relay', { offset, line: lineNo })
  }

  /** 一次轮询：读新增的完整行。**只读**，r 模式。 */
  function poll () {
    // ★★ stop 之后一律拒绝：不读文件、不 append、不推进游标。
    //    计数留痕（pollsAfterStop）—— 停止是**一次状态转换**，不是「这一瞬间之后绝对没有回调」：
    //    定时器可能已经排上、调用方可能还捏着 poll()，所以拒绝要写成**可观察**的，而不是假装不会发生。
    if (stopped) { counters.pollsAfterStop++; return { read: 0, stopped: true } }
    counters.polls++
    if (!queuePath) { state.state = 'disabled'; return { read: 0 } }

    let size
    try { size = fs.statSync(queuePath).size } catch (e) {
      state.state = 'error'
      state.connected = false
      note('QUEUE_MISSING', '读不到队列：' + String((e && e.message) || e))
      return { read: 0 }
    }

    if (size < offset) {
      counters.truncated++
      note('QUEUE_TRUNCATED', '队列比游标短（被轮转/清空？）→ 从头读，重复由去重索引兜住')
      offset = 0
      lineNo = 0
    }

    let buf = Buffer.alloc(0)
    if (size > offset) {
      const len = size - offset
      buf = Buffer.alloc(len)
      let fd
      try {
        fd = fs.openSync(queuePath, 'r')      // ★ 只读打开
        fs.readSync(fd, buf, 0, len, offset)
      } catch (e) {
        state.connected = false
        note('QUEUE_READ_FAILED', String((e && e.message) || e))
        return { read: 0 }
      } finally {
        if (fd !== undefined) { try { fs.closeSync(fd) } catch (e2) { /* ignore */ } }
      }
    }

    state.connected = true
    state.state = 'reading'

    // 只消费到最后一个换行；剩下的半行留着
    const lastNl = buf.lastIndexOf(0x0a)
    if (lastNl < 0) {
      state.partialTail = buf.length ? { bytes: buf.length, preview: redact(buf.toString('utf8').slice(0, 120)) } : null
      // ★ 这一轮没有完整行可处理（没新数据 / 只有半行）→ 之前的「卡住」已经不成立：
      //   要么队列被清空了、要么游标已经越过它。不清掉的话状态会一直显示 stalled（会误导）。
      state.blocked = null
      state.lastBlockedCode = null
      return { read: 0 }
    }
    const complete = buf.subarray(0, lastNl + 1)
    const rest = buf.subarray(lastNl + 1)
    state.partialTail = rest.length ? { bytes: rest.length, preview: redact(rest.toString('utf8').slice(0, 120)) } : null

    // ★★ 游标语义（2026-11-10 修）：**只有「入账成功 / 判重 / 明确跳过（空行、坏行）」的行才推进游标。**
    //    拒写（READONLY / WRITE_FAILED / NOT_CONFIGURED / append 抛异常）时游标停在**这一行之前**，
    //    下一次 poll 从同一个 offset 重读 —— 丢一行比卡一行更坏，卡住至少是看得见的。
    //    ★ 卡住不等于丢：counters.stalled / snapshot.blocked / errors.jsonl 的 APPEND_BLOCKED 都在。
    let commitTo = 0            // 本块里已确认处理完的**相对字节数**（只有它进 offset）
    let commitLines = 0         // 对应的行数（lineNo 只在提交时加，不随读随加）
    let cursorInBlock = 0
    let seen = 0                // 本块里已「看到」的行数（raw_ptr / 错误定位用，与 lineNo 无关）
    let blocked = null          // 卡在哪一行（可观察，不是静默重试）
    const wasBlocked = state.blocked ? state.blocked.offset : null
    let blockedWasNew = false
    while (cursorInBlock < complete.length) {
      const relStart = cursorInBlock
      const nl = complete.indexOf(0x0a, relStart)
      if (nl < 0) break
      const rawLine = complete.subarray(relStart, nl)
      const lineStart = offset + relStart
      const lineEnd = nl + 1
      cursorInBlock = lineEnd
      seen++
      const thisLine = lineNo + seen

      const text = rawLine.toString('utf8').replace(/^\uFEFF/, '')
      if (text.trim() === '') { commitTo = lineEnd; commitLines = seen; continue }
      counters.lines++

      if (rawLine.length > maxLineBytes) {
        counters.badLines++
        state.lastBad = { line: thisLine, offset: lineStart, bytes: rawLine.length, reason: 'TOO_LONG' }
        note('BAD_LINE', '第 ' + thisLine + ' 行超长（' + rawLine.length + ' B），跳过（可见，不是静默）')
        // ★ 坏行也推进：它已经被**看见**（进错误账），重读一遍也不会变好；卡在它上面只会堵住后面的好行
        commitTo = lineEnd; commitLines = seen
        continue
      }

      let rec
      try { rec = JSON.parse(text) } catch (e) {
        counters.badLines++
        state.lastBad = { line: thisLine, offset: lineStart, bytes: rawLine.length, reason: 'JSON', excerpt: redact(text.slice(0, 120)) }
        note('BAD_LINE', '第 ' + thisLine + ' 行不是 JSON（偏移 ' + lineStart + '）：' + redact(String((e && e.message) || e)) + ' ｜ 摘要：' + redact(text.slice(0, 80)))
        commitTo = lineEnd; commitLines = seen
        continue
      }
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
        counters.badLines++
        state.lastBad = { line: thisLine, offset: lineStart, bytes: rawLine.length, reason: 'NOT_OBJECT' }
        note('BAD_LINE', '第 ' + thisLine + ' 行不是对象，跳过')
        commitTo = lineEnd; commitLines = seen
        continue
      }

      // ★ payload 保留**整条记录**；再显式钉住那几个关键字段（防止将来有人偷偷裁剪）
      const payload = Object.assign({}, rec)
      const kept = {}
      for (const f of LEAD_RELAY_KEEP_FIELDS) { if (Object.prototype.hasOwnProperty.call(rec, f)) kept[f] = rec[f] }

      const chatId = String(rec.chatId || (rec.kind === 'group' && rec.groupId ? 'group:' + rec.groupId
        : (rec.kind === 'private' && rec.userId ? 'private:' + rec.userId : '')))

      const env = buildEnvelope({
        source: 'lead-relay',
        type: 'report',
        payload,
        chatId,
        userId: rec.userId === undefined ? '' : String(rec.userId),
        // 队列没有 messageId（这就是为什么这条 ingress 必须靠内容指纹去重）
        messageId: rec.messageId === undefined ? '' : String(rec.messageId),
        bootId,
        raw_ptr: 'file:' + queuePath + '#L' + thisLine + '@' + lineStart,
        createdAt: rec.t || null,
        receivedAt: now(),
        ingress: 'lead-relay',
        extra: {
          kept,
          queueLine: thisLine,
          queueOffset: lineStart,
          tier: rec.tier === undefined ? '' : String(rec.tier),
          kind: rec.kind === undefined ? '' : String(rec.kind),
          status: rec.status === undefined ? '' : String(rec.status),
        },
      })

      let r
      try {
        r = store.append(env)
      } catch (e) {
        // append 抛异常 = 和 WRITE_FAILED 同一类：没落盘，游标不许前移
        r = { ok: false, code: 'APPEND_THREW', message: String((e && e.message) || e) }
      }

      if (r && r.ok) {
        counters.envelopes++
        state.lastEventAt = env.received_at
        state.lastSource = 'lead-relay'
        commitTo = lineEnd
        commitLines = seen
      } else if (r && r.code === 'DUPLICATE') {
        // ★ 判重 = 这条**已经在账里**，是合法的已处理 → 游标照推（不然每次重启都卡在同一行）
        counters.dup++
        commitTo = lineEnd
        commitLines = seen
      } else {
        // ★★ 拒写：游标**停在这一行之前**，下一次 poll 重读它。
        //    READONLY / WRITE_FAILED / NOT_CONFIGURED / APPEND_THREW 都走这里。
        const code = (r && r.code) || 'UNKNOWN_REJECT'
        counters.rejected++
        state.lastError = { code, detail: (r && r.message) || '', at: new Date(now()).toISOString() }
        blocked = { offset: lineStart, line: thisLine, bytes: lineEnd - relStart, code }
        log('[lead-relay] 第 ' + thisLine + ' 行没落盘（' + code + '）→ 游标不前移，下次重读')
        break
      }
    }

    if (blocked) {
      counters.stalled++
      state.state = 'stalled'
      // ★ 同一行只记一条错误：磁盘满的时候每 2 秒刷一行会把错误账也写坏
      blockedWasNew = !(wasBlocked === blocked.offset && state.lastBlockedCode === blocked.code)
      if (blockedWasNew) {
        note('APPEND_BLOCKED', '第 ' + blocked.line + ' 行（偏移 ' + blocked.offset + '，' + blocked.bytes + ' B）没入账：' +
          blocked.code + ' → 游标**不前移**，下一次轮询重读这一行（卡住是可见的，不是静默跳过）')
      }
      state.blocked = blocked
      state.lastBlockedCode = blocked.code
    } else {
      state.blocked = null
      state.lastBlockedCode = null
    }

    if (commitTo > 0) {
      offset += commitTo
      lineNo += commitLines
      saveCursor()
    }
    if (commitTo > 0 || blockedWasNew) {
      if (typeof onFlush === 'function') onFlush()
    }
    return { read: commitTo, lines: commitLines, blocked, offset, line: lineNo }
  }

  function loop () {
    if (stopped) return
    try { poll() } catch (e) { note('POLL_FAILED', String((e && e.message) || e)) }
    timer = setTimeout(loop, Math.max(200, Number(pollMs) || 2000))
    if (timer.unref) timer.unref()
  }

  function snapshot () {
    return {
      id: 'lead-relay',
      enabled: state.enabled,
      state: state.state,
      connected: state.connected,
      lastEventAt: state.lastEventAt,
      lastError: state.lastError,
      dedupCount: counters.dup,
      lastSource: state.lastSource,
      partialTail: state.partialTail,
      lastBad: state.lastBad,
      // ★ 可靠性可观察面（2026-11-10）：卡住/停止都不是静默状态
      blocked: state.blocked,
      stopped: stopped,
      stoppedAt: state.stoppedAt,
      queuePath: queuePath ? String(queuePath) : '',
      cursor: { offset, line: lineNo },
      counters: Object.assign({}, counters),
      capability: { receive: true, send: false, writesQueue: false },
    }
  }

  return {
    id: 'lead-relay',
    start () { stopped = false; state.stoppedAt = null; loop() },
    stop () {
      stopped = true
      clearTimeout(timer)
      state.state = 'stopped'
      state.connected = false
      state.stoppedAt = new Date(now()).toISOString()
    },
    poll,
    snapshot,
    get counters () { return Object.assign({}, counters) },
    get cursor () { return { offset, line: lineNo } },
    // ★ 没有 send / call / append —— 它只读。
  }
}
