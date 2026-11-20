// 唤醒投递：把「投递请求」真的送进会话 —— 链路最末那一步
// ============================================================================
// 上游 wake.compose() 产出 { chatId, text, eventId }，但**不投**（它能单测，正是因为它不投）。
// 本文负责投：resolve(chatId) → followup(sessionId, text) → 判回执。
//
// ── 为什么 resolve 和 followup 必须成对出现在这里 ──────────────
//   resolve 只证明「这个 chatId 有对应会话」，不证明「这句话送到了」；
//   followup 的回执才证明投递。把两步写在一起，是为了让「投了没有」只有一个答案 ——
//   分开写就会出现「resolve 成功了，然后没人调 followup」这种看起来一切正常的空转。
//
// ── 四条纪律 ────────────────────────────────────────────────
//   ① **默认不投**。enabled 由调用方给（函数或布尔），每次投递前读一次 —— 热开关，
//      改配置不用重启。关着的时候返回 { disabled:true }，不是静默成功。
//   ② **按会话串行**。同一个 chatId 的两条投递不能并发：会话侧是「一轮」模型，
//      并发投进去就是两条消息抢同一个回合。
//   ③ **同一条事件只投一次**。seen 记 eventId；进程重启就清空（事件账本身是幂等的，
//      这里防的是同一进程内 derive 被多路径触发）。
//   ④ **正文不外泄**。日志只写「投了几个、跳过几个、什么码」，不写 text。
// ============================================================================

const SEEN_MAX = 5000

/**
 * @param {object} opts
 *   dispatch —— session-dispatch 实例（resolve / followup / view）
 *   enabled  —— boolean 或 () => boolean；默认 false
 *   now      —— 可注入时间
 *   log      —— 一行一次，**不含正文**
 */
export function createWakeDeliverer (opts = {}) {
  const dispatch = opts.dispatch || null
  // ★★ 2026-11-12：投递成功后，把「等这一轮回复并发回 QQ」交给它。
  //   没有它 = 只投不回（旧行为，aurabot 负责回）；有它 = v4 自己闭环。
  //   **不要在这里判空就当成功** —— 没配 responder 就是「只投不回」，
  //   那是明确的能力缺口，view() 里要能看出来。
  const responder = opts.responder || null
  // ★★ 2026-11-12：投递成功 = 她在这个群里说了一次话。
  //   要记进 engage（noteReply + joinTopic），否则：
  //     · botReplyTimes 永远是空的 → 「刚说太多就歇会儿」的刹车永远不触发
  //     · engagedUntil 永远是 0 → 插话判定永远不走「接着聊」那条分支
  //   状态建起来但没人写，等于没建 —— 上一轮就是停在这里。
  const engage = opts.engage || null
  const enabledOf = typeof opts.enabled === 'function' ? opts.enabled : () => Boolean(opts.enabled)
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()

  const seen = new Set()
  /** 每个 chatId 的串行闸：前一条没回来，后一条排队。 */
  const chains = new Map()

  const stats = {
    rounds: 0,
    asks: 0,
    delivered: 0,
    requested: 0,      // resolve 成功的次数
    skipped: {},       // code → 次数
    // ★ 按判定的 mode 分账（must / interject / engaged）。asks 上带着 mode ——
    //   「被 @ 叫出来的」和「自己插一句的」在事后核对时是两件事，混成一个数就查不出异常。
    byMode: {},
    lastMode: null,
    lastAt: null,
    lastCode: null,
    lastEventId: null,
    lastError: null,
  }

  function bump (code) {
    stats.skipped[code] = (stats.skipped[code] || 0) + 1
    stats.lastCode = code
  }

  function remember (id) {
    seen.add(id)
    if (seen.size > SEEN_MAX) {
      // ★ 简单粗暴地丢掉最老的一批：这个集合只防「同一进程内重复投」，
      //   丢早了最坏是多投一次（会被 seen 之外的幂等层拦，或用户收到两遍）。
      //   丢晚了是内存泄漏。两害相权取前者，而且只在这个量级才会发生。
      const drop = [...seen].slice(0, SEEN_MAX - Math.floor(SEEN_MAX * 0.9))
      for (const d of drop) seen.delete(d)
    }
  }

  /** 一条投递请求：resolve → followup。返回 { ok, code?, sessionId? } */
  async function deliverOne (ask) {
    if (!dispatch) return { ok: false, code: 'NO_DISPATCH' }

    const r = await dispatch.resolve({ chatId: ask.chatId })
    if (!r || r.ok !== true) return { ok: false, code: (r && r.code) || 'RESOLVE_FAILED' }
    const sessionId = String(r.sessionId || '')
    if (!sessionId) return { ok: false, code: 'RESOLVE_NO_SESSION' }
    stats.requested++

    const d = await dispatch.followup({ sessionId, text: ask.text })
    if (!d || d.ok !== true) return { ok: false, code: (d && d.code) || 'FOLLOWUP_FAILED' }

    // ★ 回执里的 sessionId 必须与 resolve 给的那个逐字相同。
    //   session-dispatch 内部已判过「与请求一致」，这里是第二道 —— 因为请求是我拼的，
    //   如果哪天我拼错了（传了别的 id），只有这一道能看出来。
    const back = String(d.sessionId || '')
    if (back && back !== sessionId) return { ok: false, code: 'SESSION_MISMATCH' }

    return { ok: true, sessionId }
  }

  /**
   * 投一批。**逐条串行**，同一 chatId 内部再串行。
   * @returns {Promise<{ ok:true, disabled?:true, delivered:number, skipped:Object }>}
   */
  async function deliver (asks) {
    const list = Array.isArray(asks) ? asks : (asks ? [asks] : [])
    if (!enabledOf()) return { ok: true, disabled: true, delivered: 0, skipped: {} }
    if (!list.length) return { ok: true, delivered: 0, skipped: {} }

    stats.rounds++
    stats.asks += list.length
    const skipped = {}

    for (const ask of list) {
      const id = String((ask && ask.eventId) || '')
      if (id && seen.has(id)) { bump('ALREADY_DONE'); skipped.ALREADY_DONE = (skipped.ALREADY_DONE || 0) + 1; continue }

      // 同一 chatId 串行：拿它的链尾，接上，再把新的链尾放回去。
      const key = String((ask && ask.chatId) || '')
      const prev = chains.get(key) || Promise.resolve()
      const run = prev.then(() => deliverOne(ask)).catch((e) => ({ ok: false, code: 'THREW' }))
      chains.set(key, run.then(() => {}).catch(() => {}))
      const res = await run
      const outcome = res || { ok: false, code: 'NO_RESULT' }
      if (outcome.ok) {
        stats.delivered++
        const md = String((ask && ask.mode) || 'unknown')
        stats.byMode[md] = (stats.byMode[md] || 0) + 1
        stats.lastMode = md
        if (id) { remember(id); stats.lastEventId = id }
        // ★★ 投出去了 = 她真的开口了 → 记一次「说话」+ 加入这个话题。
        //   注意记的是「投递成功」，不是「回复发出去成功」——
        //   因为判定的那一刻她就已经决定说了，后面是发送环节。
        //   （发送失败会由 respond 记 failed，那是另一件事。）
        const gid = String(key || '').startsWith('group:') ? String(key).slice(6) : ''
        if (engage && gid) {
          try {
            // ★ mode='interject' 的那次已经在 decide 阶段记过 noteInterject 了
            //   （noteInterject 内部会同时记 botReplyTimes）。这里再记一遍会让
            //   「刚说太多」的刹车把一次插话数成两次 —— 刹车会提前 40% 触发。
            if (String((ask && ask.mode) || '') !== 'interject') engage.noteReply(gid)
            engage.joinTopic(gid)
          } catch (e) {
            log('[deliver] 记 engage 失败：' + String((e && e.message) || e))
          }
        }
        // ★★ 投出去了 → 开始等这一轮的回复。
        //   用 outcome.sessionId（回执里那个，已与 resolve 逐字比对过），不是重新 resolve ——
        //   重解析可能拿到另一个会话，那样就会去读别人的回复。
        if (responder) {
          try {
            // ★ 2026-11-13：watch 现在是 async（bridge 版 reader 是异步的）。
            const w = await responder.watch(outcome.sessionId, key, {})
            if (!w || w.ok !== true) {
              stats.watchFailed = (stats.watchFailed || 0) + 1
              stats.lastWatchCode = (w && w.code) || 'WATCH_FAILED'
            }
          } catch (e) {
            stats.watchFailed = (stats.watchFailed || 0) + 1
            stats.lastWatchCode = 'WATCH_THREW'
            log('[deliver] 登记等回复失败：' + String((e && e.message) || e))
          }
        }
      } else {
        bump(outcome.code)
        skipped[outcome.code] = (skipped[outcome.code] || 0) + 1
      }
    }

    // ★★ 一轮投完就清空。
    //   ★ 第一版写的是 `for (const [k,p] of chains) if (p === undefined) chains.delete(k)` ——
    //     而 chains 里存进去的永远是 run.then(...).catch(...)，是个 Promise，
    //     **永不为 undefined**。于是那条清理一条都没删过：注释说「清掉已经跑完的链」，
    //     实现里每个出现过的 chatId 都留一条，永久。
    //   ★ 这是今晚第三次碰到同一个形状：**写着清理，永远不清理**；
    //     和「强制关插话写在展开之前」「interjectForcedOff 写死 true」是同一类错 ——
    //     让人以为有保护，实际没有。
    //   安全性来自这里本来就是串行的（for-await 逐条），走到这一行时没有在跑的链。
    chains.clear()

    stats.lastAt = new Date(now()).toISOString()
    log('[deliver] 投 ' + stats.delivered + ' 条' +
      (Object.keys(skipped).length ? '，跳过 ' + JSON.stringify(skipped) : ''))
    return { ok: true, delivered: stats.delivered, skipped }
  }

  function view () {
    return {
      enabled: (() => { try { return Boolean(enabledOf()) } catch { return false } })(),
      hasDispatch: Boolean(dispatch),
      // ★ 有没有「投完等回复」这一环。false = 只投不回（能力缺口，不是正常状态）。
      hasResponder: Boolean(responder),
      hasEngage: Boolean(engage),
      seen: seen.size,
      // ★ 挂着的链数。正常情况下永远是 0（一轮结束就清空）——
      //   不是 0 就说明有东西没跑完，或者清理逻辑又坏了。
      pendingChains: chains.size,
      ...stats,
    }
  }

  return { deliver, view }
}

export default { createWakeDeliverer, SEEN_MAX }
