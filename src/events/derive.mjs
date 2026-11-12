// 帧 → 事件 · 接线层（把纯函数接进事件接入的生命周期）
// ============================================================================
// coalesce.mjs 是纯函数（不读盘、不取时间、不打印）；本文件负责它周围的三件事：
//   ① 把 Envelope 适配成 coalesce 要的帧形状：{ id, chatId, at }
//      —— 这是唯一一处知道「at 从 created_at 解析、id 取 event_id」的地方。
//   ② 排序：coalesce 明确不收乱序（UNSORTED），而磁盘顺序**不等于**时间顺序
//      （lead-relay 是别人写的队列，一条迟到的记录就可能倒序落盘）。
//   ③ 落账：只把**已关闭**窗口写进 events.jsonl；写不进去要说出来，不许静默。
//
// ★★ 为什么每落一帧就全量重算（而不是增量维护一个窗口状态机）：
//   全量重算是**无状态**的 —— 进程随时崩、随时起，重算结果都一样。
//   增量状态机会多出一份「内存里的真相」，而它一崩就和磁盘对不上；
//   而 coalesce 1000 帧 2.5ms，重算比维护那份真相便宜得多。
//   ★ 代价写在明处（本机实测，1000 帧 / 20 个会话）：一次 derive 中位 18ms。
//     coalesce 本身约 2.5ms，大头是 store.readAll() 把整本 envelopes.jsonl parse 一遍。
//     成本随帧数线性长（一万帧量级 ~0.2s/条）。到那一步该做的是把帧按窗口分片，
//     而不是把状态机塞回内存（那只是把「慢」换成「会漂」）。
//
// ★★ 已知的**延迟**（不是丢，但要知道）：事件只在「有帧落下 / 启动 / 停止」时被写出去。
//   所以一次对话结束后，它的事件要等**下一条帧**（任何会话都行）或下次启动才落盘。
//   这不是 bug，是「不轮询」的直接代价；补法见 tools/events-coalesce-wire-selftest.mjs
//   末尾的说明（一次性 deadline 定时器，不是 setInterval）。
// ============================================================================

import { coalesce } from './coalesce.mjs'

/**
 * Envelope[] → [{ id, chatId, at }]（按 at 非递减，同毫秒按 id）
 * 返回 { frames, skipped }，skipped 里分开数三种坏帧，便于状态口说清「为什么少了」。
 * ★ 不在这里抛：一条坏帧不该让整批推导停摆 —— 它只是不参与这次解释。
 */
export function framesFromEnvelopes (rows) {
  const frames = []
  const skipped = { noChat: 0, badAt: 0, noId: 0 }
  for (const env of Array.isArray(rows) ? rows : []) {
    if (!env || typeof env !== 'object') { skipped.noChat++; continue }
    // chatId 空 = coalesce 会整批 BAD_FRAME（它逐帧校验），所以先摘出来。
    // ★ lead-relay 的记录确实可能没有 chatId（只有 kind 没有 groupId/userId 时），
    //   这不是异常数据，是那条 ingress 的形状。
    const chatId = typeof env.chatId === 'string' ? env.chatId : ''
    if (chatId === '') { skipped.noChat++; continue }
    const id = typeof env.event_id === 'string' ? env.event_id : ''
    if (id === '') { skipped.noId++; continue }
    // ★ at 只收毫秒数字（coalesce 的硬要求），所以解析放在这里 —— 只有这一处把 ISO 变成数字。
    const at = Date.parse(env.created_at)
    if (!Number.isFinite(at)) { skipped.badAt++; continue }
    frames.push({ id, chatId, at })
  }
  // ★ 同毫秒要有确定次序（用 id 兜底）：否则同一条账在两次重启后可能推出不同的
  //   frameIds 顺序 → 事件 id 变 → 账里多出一条「看起来是新事件」的重影。
  frames.sort((a, b) => (a.at - b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { frames, skipped }
}

/**
 * 造一个推导器。
 * opts.store —— openStore() 的返回值（要 readAll + appendEvents + pushError）
 * opts.now   —— 「现在」的毫秒（可注入，测试/重放用）
 * opts.rules —— 透传给 coalesce 的规则覆盖
 */
export function createEventDeriver (opts = {}) {
  const store = opts.store || null
  const now = opts.now || (() => Date.now())
  const rules = opts.rules || undefined
  const log = opts.log || (() => {})
  // ★ 2026-11-12：把「刚入账的事件」交给关注者 —— 事件 → 唤醒那一段的入口。
  //   只给**真正写进账的**：duplicate（重放命中）和 conflict（迟到帧想改写）都不是新事件，
  //   把它们的译文再唤醒一次，就是同一条消息叫醒同一个会话两遍。
  const onEvents = typeof opts.onEvents === 'function' ? opts.onEvents : null

  const stats = {
    runs: 0,
    frames: 0,          // 最近一次推导看到的帧数
    open: 0,            // 最近一次推导里仍未关闭的窗口数
    written: 0,         // 累计真正写进事件的条数
    duplicate: 0,       // 累计「已经写过了」的条数（幂等命中）
    conflict: 0,        // 累计冲突（迟到帧想改写已入账事件）
    rejected: 0,        // 累计形状不对被拒
    // ★ 下面三个是**最近一次**推导的数（账是 append-only，累计数没有意义：
    //   它们只会随账变长而线性变大，看不出「这一次少了几帧」）。
    skippedNoChat: 0,
    skippedBadAt: 0,
    skippedNoId: 0,
    failed: 0,
    lastRunAt: null,
    lastError: null,
  }

  let toldNoChat = false
  let lastConflictKey = ''

  // ★ 2026-11-12：**到期触发**。
  //   问题（子会话报的）：事件只在落帧 / start / stop 时导出，窗口到期本身不触发任何东西。
  //   于是「最后一条消息之后、下一条消息之前」这段时间里，事件不落盘 —— 帧还在、可重算，
  //   所以不是数据丢，是「解释」缺席。
  //   补法：推导完若还有未关闭窗口，按**最近的那个 deadline** 挂一次性定时器。
  //   ★ 这是一次性到期触发，不是 setInterval 轮询 —— 它落在「事件本来该发生的那一刻」。
  let armTimer = null
  const autoArm = opts.autoArm !== false
  const ARM_MAX_MS = 60 * 1000   // 最多挂 60s：超过就等下次落帧，免得挂一个几小时的定时器
  function disarm () {
    if (armTimer) { clearTimeout(armTimer); armTimer = null }
  }
  function armUntil (atMs) {
    disarm()
    if (!autoArm || atMs == null) return
    const delay = Math.max(30, Math.min(ARM_MAX_MS, atMs - now() + 20))
    armTimer = setTimeout(() => {
      armTimer = null
      try { derive() } catch (e) {
        log('[derive] 到期触发失败：' + String((e && e.message) || e))
      }
    }, delay)
    if (armTimer.unref) armTimer.unref()
  }

  function fail (code, message) {
    stats.failed++
    stats.lastError = { code, detail: String(message || '') }
    return { ok: false, code, message: String(message || '') }
  }

  /**
   * 跑一次推导：读全部帧 → 排序 → coalesce(只取已关闭) → appendEvents。
   * 幂等：同一批帧反复跑，第二遍起全是 duplicate。
   * 不抛异常给调用方（落帧路径上不许因为推导把收帧搞崩）—— 失败进 stats + errors.jsonl。
   */
  function derive () {
    const t0 = now()
    stats.runs++
    stats.lastRunAt = new Date(t0).toISOString()

    if (!store || typeof store.readAll !== 'function' || typeof store.appendEvents !== 'function') {
      return fail('NO_STORE', '没有可写的事件账：推导无处落盘（readAll/appendEvents 缺失）')
    }

    let rows
    try {
      rows = store.readAll()
    } catch (e) {
      const msg = '读帧失败：' + String((e && e.message) || e)
      if (store.pushError) store.pushError('DERIVE_READ_FAILED', msg)
      return fail('READ_FAILED', msg)
    }

    const { frames, skipped } = framesFromEnvelopes(rows)
    stats.frames = frames.length
    stats.skippedNoChat = skipped.noChat
    stats.skippedBadAt = skipped.badAt
    stats.skippedNoId = skipped.noId
    // ★ 只说一次：没有 chatId 是**结构**层面的条件（某条 ingress 本来就不带），
    //   每帧写一行 errors.jsonl 只会把错误账也写坏。
    if (skipped.noChat > 0 && !toldNoChat) {
      toldNoChat = true
      if (store.pushError) store.pushError('FRAME_NO_CHAT', skipped.noChat + ' 帧没有 chatId，未参与事件推导（coalesce 不收空 chatId）')
    }

    let r
    try {
      r = coalesce(frames, { rules, now: t0, closedOnly: true })
    } catch (e) {
      const msg = 'coalesce 抛异常：' + String((e && e.message) || e)
      if (store.pushError) store.pushError('COALESCE_FAILED', msg)
      return fail('COALESCE_THREW', msg)
    }
    if (!r.ok) {
      // BAD_FRAME / UNSORTED / BAD_RULES —— 不猜、不修补，原样上报（UNSORTED 理论不可达，
      // 因为我们自己排过序；真出现就说明 framesFromEnvelopes 被改坏了）。
      if (store.pushError) store.pushError('COALESCE_FAILED', r.code + ' · ' + (r.message || ''))
      return fail(r.code || 'COALESCE_FAILED', r.message)
    }
    stats.open = r.open ? r.open.length : 0

    const w = store.appendEvents(r.events)
    // ★ 回调在 appendEvents 之后、统计之前：先把事件交出去，再记账。
    //   ★ 出错**绝不能**把推导带下去 —— 这条路径在落帧上，推导崩了收帧就停。
    if (onEvents && w.written.length) {
      try {
        const freshIds = new Set(w.written.map(String))
        const fresh = r.events.filter((e) => freshIds.has(String(e.id)))
        if (fresh.length) onEvents(fresh)
      } catch (e) {
        stats.lastError = { code: 'ON_EVENTS_THREW', detail: String((e && e.message) || e) }
        log('[derive] onEvents 回调失败（推导继续）：' + String((e && e.message) || e))
      }
    }
    stats.written += w.written.length
    stats.duplicate += w.duplicate.length
    stats.conflict += w.conflict.length
    stats.rejected += w.rejected.length

    if (w.conflict.length) {
      // ★ 同一个冲突只记一次：迟到帧的条件会持续存在（每来一帧就重算一次），
      //   不去重的话 errors.jsonl 会被同一条冲突刷满。
      const key = w.conflict.map((c) => c.id).sort().join(',')
      if (key !== lastConflictKey) {
        lastConflictKey = key
        if (store.pushError) {
          store.pushError('EVENT_REVISED',
            w.conflict.length + ' 条推导结果与已入账事件共享帧（迟到帧改变了窗口边界）：' +
            w.conflict.slice(0, 3).map((c) => c.id + '⊃' + c.eventId).join(' , ') +
            ' —— 账是 append-only，不改旧行，只留这条痕')
        }
      }
    }

    if (!w.ok && w.code) {
      stats.lastError = { code: w.code, detail: w.message }
      log('[derive] 事件没落盘：' + w.code + ' ' + w.message)
      return { ok: false, code: w.code, message: w.message, written: w.written, duplicate: w.duplicate.length, conflict: w.conflict.length }
    }
    // ★ 到期触发：把「还有窗口没关」换算成「下一次该在什么时候再来一趟」。
    //   deadline 用「该 chatId 最后帧的 at + 该事件的 windowMs」——
    //   与 coalesce 的滑动续窗同一个口径（它算 closedAt 用的就是这条式子）。
    let nextDeadlineAt = null
    if (r.open && r.open.length) {
      const lastAt = new Map()
      for (const f of frames) lastAt.set(f.chatId, f.at)   // frames 升序，后写覆盖 = 最新
      for (const o of r.open) {
        const a = lastAt.get(o.chatId)
        const wms = Number(o.windowMs) > 0 ? Number(o.windowMs) : 0
        if (a == null || !wms) continue
        const d = a + wms
        if (nextDeadlineAt === null || d < nextDeadlineAt) nextDeadlineAt = d
      }
    }
    armUntil(nextDeadlineAt)

    return {
      ok: true,
      events: r.events.length,
      written: w.written,
      duplicate: w.duplicate.length,
      conflict: w.conflict.length,
      open: stats.open,
      nextDeadlineAt,
    }
  }

  return {
    derive,
    stats: () => ({ ...stats }),
    /** 停掉待触发的定时器（shutdown 时调；不调也不会漏，unref 过） */
    stop: disarm,
    /** 到期触发是否启用（测试里关掉它，避免真定时器污染断言） */
    armed: () => autoArm,
  }
}
