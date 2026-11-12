// events · respond —— 投递出去，然后把回复要回来发到 QQ
// ============================================================================
// 这是「闭环的另一半」。之前缺的就是它：
//   v4 投递是 followup（把话送进会话就返回，拿不回回复），
//   而回 QQ 需要那句回复 —— 那一步一直是 aurabot 的 onSessionEvent 在做。
//
// ★ 为什么不监听事件：v4 不在宿主进程里，控制通道是单向的
//   （v4 请求 → 宿主应答），没有「宿主主动推 turn/end」这条路。
//   加一条要动 bridge + 重启 DSH。
//   读会话日志不用动任何运行中的东西，代价是延迟（轮询）和 CPU（解压）。
//
// ★★ 四条不妥协：
//   ① **只发完整的一轮**：必须有 turn/end（reply.mjs 保证），没有就当还在跑。
//   ② **只发比投递时新的一轮**：用 turn 号比。会话可能同时有多轮在排队，
//      不加这个判断会把上一轮的旧话当成本轮的回复重发一遍。
//   ③ **一条投递只发一次**：发出去了就从 watch 里摘掉。重发在群里是可见事故。
//   ④ **超时要说出来**：等不到就记 note，不能静默地什么都不做 ——
//      「她没回」和「我们丢了」在群里长得一样，但在账上必须分开。
// ============================================================================

import fs from 'node:fs'
import { toMessages, resolveMentions } from './format.mjs'
import { groupIdOf } from './members.mjs'

const DEFAULT_POLL_MS = 2500
const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000

function noteOf(code, detail) {
  return { code, detail: String(detail == null ? '' : detail).slice(0, 300) }
}

/**
 * createResponder({ replyReader, outbox, log, pollMs, timeoutMs, now, setTimer, clearTimer })
 *
 * replyReader: events/reply.mjs 的 createReplyReader(...) 结果
 * outbox:      adapters/outbox.mjs 的 createOutbox(...) 结果
 */
export function createResponder(opts = {}) {
  const replyReader = opts.replyReader
  const outbox = opts.outbox
  // ★ 群成员解析器（名字 → QQ 号）。没有它时 <at:名字> 会被原样保留 ——
  //   那是明确的能力缺口，不是「静默降级」。
  const members = opts.members || null
  // ★ 她选择沉默时要退出话题 —— 否则 engagedUntil 一直有效，
  //   判定会以为她还在聊，于是继续「接着聊」，冷掉的话题一直挂着。
  const engage = opts.engage || null
  // ★ 表情库（发送半边）。有它时 <sticker:标签> 会真的发一张图；
  //   没有时那一段会被跳过并记 dropped —— 不假装发了。
  const stickers = opts.stickers || null
  // ★ 语音合成（只用 Windows 自带）。有它时 <voice> 会真的发一条语音；
  //   没有时退回发文字 —— aurabot 也是这么兜的（念不出来就发字）。
  const tts = opts.tts || null
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const pollMs = Number(opts.pollMs) > 0 ? Number(opts.pollMs) : DEFAULT_POLL_MS
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
  const setTimer = typeof opts.setTimer === 'function' ? opts.setTimer : (fn, ms) => setTimeout(fn, ms)
  const clearTimer = typeof opts.clearTimer === 'function' ? opts.clearTimer : (t) => clearTimeout(t)

  const watches = new Map() // key → { sessionId, chatId, turnBefore, startedAt, timer, tries }
  const counters = {
    registered: 0, sent: 0, timeouts: 0, failed: 0,
    lastAt: null, lastCode: null, lastError: null, byReason: {},
  }
  const bump = (k) => { counters.byReason[k] = (counters.byReason[k] || 0) + 1 }

  function keyOf(sessionId, chatId) { return String(sessionId) + '\u0000' + String(chatId) }

  /** 投递成功后登记一次「等这一轮的回复」。重复登记同一个 (会话,chat) 会覆盖旧的。 */
  function watch(sessionId, chatId, watchOpts = {}) {
    if (!replyReader) return { ok: false, code: 'RESPOND_UNCONFIGURED', error: '没有 replyReader' }
    if (!outbox) return { ok: false, code: 'RESPOND_UNCONFIGURED', error: '没有 outbox' }

    // ★ 基准 turn：投递**之前**读一次。读不到就当 0（会话里还没有完整的一轮）——
    //   那样第一条完整回复就会被发出去，这是想要的行为（她第一次说话就该发）。
    let turnBefore = 0
    try {
      const base = replyReader.lastReply(sessionId)
      if (base.ok && Number.isFinite(base.turn)) turnBefore = Number(base.turn)
    } catch (e) { log('respond: 取基准 turn 失败（当 0 处理）：' + String((e && e.message) || e)) }
    if (Number.isFinite(Number(watchOpts.turnBefore))) turnBefore = Number(watchOpts.turnBefore)

    const key = keyOf(sessionId, chatId)
    const old = watches.get(key)
    if (old && old.timer) clearTimer(old.timer)

    const w = { sessionId: String(sessionId), chatId: String(chatId), turnBefore, startedAt: now(), timer: null, tries: 0 }
    watches.set(key, w)
    counters.registered += 1
    counters.lastAt = new Date(now()).toISOString()
    log('respond: 等回复 ' + chatId + ' ← ' + w.sessionId + '（turn>' + turnBefore + '）')

    // ★★ async：解析 <at:名字> 要查群成员表（网络）。
    //   ★ 所有调度点都必须 .catch —— 定时器里一个没接住的 rejection 会直接崩 core。
    const tick = async () => {
      if (!watches.has(key)) return
      w.tries += 1
      let r
      try { r = replyReader.lastReply(w.sessionId) } catch (e) {
        r = { ok: false, code: 'REPLY_THROW', error: String((e && e.message) || e) }
      }

      // 读不到 ≠ 没说：继续等，但把错误记下来（超时那一刻它会成为原因）。
      if (!r || !r.ok) {
        counters.lastCode = (r && r.code) || 'REPLY_UNKNOWN'
        counters.lastError = (r && r.error) || ''
        return schedule()
      }
      if (!(Number(r.turn) > w.turnBefore)) return schedule()

      // ★ 到这一步：有完整的一轮，而且比投递时新。
      const text = String(r.text || '').trim()
      if (!text) { counters.lastCode = 'REPLY_EMPTY_TEXT'; return schedule() }

      watches.delete(key)

      // ★★★ 先把 <at:名字> 换成 <at:QQ号>，再转消息段。
      //
      //   顺序不能反：toSegments 是同步纯函数，只认数字；名字要查群成员表（网络）。
      //   先解析、后转段 —— 纯函数保持纯，网络调用只在这一处。
      //
      //   ★ 解析不到的名字**原样保留**（不猜、不删），并记进 missedAt。
      let finalText = text
      if (members) {
        const gid = groupIdOf(w.chatId)
        if (gid) {
          try {
            const rm = await resolveMentions(text, members.forGroup(gid))
            finalText = rm.text
            if (rm.resolved.length) bump('at:resolved')
            if (rm.unresolved.length) bump('at:unresolved:' + rm.unresolved.slice(0, 3).join(','))
            if (rm.failed.length) bump('at:failed:' + rm.failed.slice(0, 3).join(','))
          } catch (e) {
            counters.lastError = '解析 @ 失败：' + String((e && e.message) || e)
          }
        }
      }

      // ★★ 再转消息段。**不能把正文直接发** ——
      //   会话回复里带着 <at:QQ号> / <reply:N> / ||| 这些 agent 侧约定，
      //   原样发出去群里会看到字面量（2026-11-12 03:51:04 真发生过）。
      const fmt = toMessages(finalText)
      if (!fmt.ok) {
        // ★ 沉默不是失败：她选择不说话，这时要**退出话题**，
        //   否则 engagedUntil 一直有效，判定会以为她还在聊。
        if (fmt.code === 'FORMAT_SILENT') {
          counters.lastCode = 'SILENT'
          bump('silent')
          const gid = String(w.chatId).startsWith('group:') ? String(w.chatId).slice(6) : ''
          if (engage && gid) { try { engage.leaveTopic(gid) } catch (e) { /* 记账失败不该炸这条链 */ } }
          return
        }
        counters.failed += 1
        counters.lastCode = fmt.code || 'FORMAT_FAILED'
        counters.lastError = '这一轮转不出可发的消息段'
        bump('format:' + counters.lastCode)
        return
      }
      if (fmt.missedAt.length) bump('missedAt:' + fmt.missedAt.slice(0, 3).join(','))
      if (fmt.dropped.length) bump('dropped:' + [...new Set(fmt.dropped.map((d) => d.split(':')[0]))].join(','))

      counters.lastCode = 'FORMAT_READY'
      Promise.resolve()
        // 多条气泡要**串行**：并发发出去 QQ 那边可能乱序，而且幂等窗口按内容算，
        // 一样的几条并发会被自己抑制掉。
        .then(async () => {
          let lastRes = null
          for (const m of fmt.messages) {
            // ★★ sticker 段在这里**解析成真正的图片段**。
            //   为什么不在 format.mjs 里做：那是个同步纯函数，而查库要读文件。
            //   纯函数保持纯，文件访问只在这一处。
            const segs = []
            for (const seg of m.segments) {
              if (seg.type === 'poke') {
                // ★ 戳一戳是**独立动作**，不是消息段 —— 用 send_poke，不走 send_group_msg。
                //   目标：最近戳她的人 → 这一段最后说话的人 → 放弃（不在猜）。
                //   ★ 私聊不需要目标（戳的就是对方）；群聊必须有。
                const isGroup = String(w.chatId).startsWith('group:')
                const gid = isGroup ? String(w.chatId).slice(6) : ''
                const target = isGroup
                  ? (engage && typeof engage.pokeTarget === 'function' ? engage.pokeTarget(gid) : '')
                  : String(w.chatId).slice(8)
                if (!target) { bump('poke-no-target'); continue }
                try {
                  const pr = await outbox.poke(w.chatId, target)
                  if (pr && pr.ok) { bump('poke'); counters.lastCode = 'POKED' } else bump('poke-failed:' + ((pr && pr.code) || '?'))
                } catch (e) { bump('poke-threw') }
                continue
              }
              if (seg.type === 'voice') {
                // ★ 语音条**必须单独成条** —— QQ 不支持「引用/@ + 语音」同一条（issue #103）。
                //   所以这里把语音单独发出去，别的段继续走。
                const speech = String((seg.data && seg.data.text) || '').trim()
                if (!speech) continue
                const ttsRes = tts ? await tts.speak(speech) : { ok: false, code: 'TTS_UNCONFIGURED' }
                if (!ttsRes || ttsRes.ok !== true) {
                  bump('voice-fallback-text')
                  // 念不出来就发字 —— 别让她想说的话消失
                  segs.push({ type: 'text', data: { text: speech } })
                  continue
                }
                try {
                  const b64 = fs.readFileSync(ttsRes.file).toString('base64')
                  await outbox.send(w.chatId, [{ type: 'record', data: { file: 'base64://' + b64 } }])
                  counters.lastCode = 'VOICE_SENT'
                  bump('voice')
                } catch (e) {
                  bump('voice-send-failed')
                  segs.push({ type: 'text', data: { text: speech } })
                }
                continue
              }
              if (seg.type === 'sticker') {
                const tag = String((seg.data && seg.data.tag) || '')
                const hit = stickers ? stickers.pick(tag) : null
                if (!hit) {
                  bump('sticker-miss:' + (tag || '(无标签)').slice(0, 10))
                  continue // 挑不到就不发这一段，但别的段照发
                }
                segs.push({ type: 'image', data: { file: hit.file } })
              } else {
                segs.push(seg)
              }
            }
            if (!segs.length) { counters.lastCode = 'STICKER_ONLY_MISS'; continue }
            lastRes = await outbox.send(w.chatId, segs)
            if (!lastRes || lastRes.ok !== true) return lastRes
          }
          return lastRes || { ok: true, empty: true }
        })
        .then((res) => {
          if (res && res.ok) {
            counters.sent += 1
            counters.lastCode = 'SENT'
            log('respond: 已发 ' + w.chatId + '（turn ' + r.turn + '，' + fmt.messages.length + ' 条，' + text.length + ' 字）')
          } else {
            counters.failed += 1
            counters.lastCode = (res && res.code) || 'SEND_FAILED'
            counters.lastError = (res && res.error) || ''
            bump('send:' + counters.lastCode)
            log('respond: 发失败 ' + counters.lastCode + ' — ' + counters.lastError)
          }
        })
        .catch((e) => {
          counters.failed += 1
          counters.lastCode = 'SEND_THROW'
          counters.lastError = String((e && e.message) || e)
        })
    }

    function schedule() {
      if (!watches.has(key)) return
      if (now() - w.startedAt >= timeoutMs) {
        watches.delete(key)
        counters.timeouts += 1
        counters.lastCode = 'RESPOND_TIMEOUT'
        counters.lastError = counters.lastError || ''
        bump('timeout')
        log('respond: 超时放弃 ' + w.chatId + '（' + w.tries + ' 次尝试）')
        return
      }
      w.timer = setTimer(() => { tick().catch((e) => { counters.lastError = 'TICK_THREW: ' + String((e && e.message) || e) }) }, pollMs)
      if (w.timer && typeof w.timer.unref === 'function') w.timer.unref()
    }

    w.timer = setTimer(() => { tick().catch((e) => { counters.lastError = 'TICK_THREW: ' + String((e && e.message) || e) }) }, pollMs)
    if (w.timer && typeof w.timer.unref === 'function') w.timer.unref()
    return { ok: true, sessionId: w.sessionId, chatId: w.chatId, turnBefore }
  }

  function stop() {
    for (const w of watches.values()) if (w.timer) clearTimer(w.timer)
    watches.clear()
  }

  function view() {
    return {
      watching: watches.size,
      pending: [...watches.values()].map((w) => ({
        sessionId: w.sessionId, chatId: w.chatId, turnBefore: w.turnBefore,
        tries: w.tries, ageMs: now() - w.startedAt,
      })),
      registered: counters.registered,
      sent: counters.sent,
      timeouts: counters.timeouts,
      failed: counters.failed,
      lastAt: counters.lastAt,
      lastCode: counters.lastCode,
      lastError: counters.lastError,
      byReason: { ...counters.byReason },
      pollMs,
      timeoutMs,
      hasMembers: Boolean(members),
      hasEngage: Boolean(engage),
      hasStickers: Boolean(stickers),
      hasTts: Boolean(tts),
      tts: tts && typeof tts.view === 'function' ? tts.view() : null,
    }
  }

  return { watch, stop, view }
}
