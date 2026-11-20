// bridge-events.mjs —— 事件层的 v4 半边（bridge 协议 v2 · §2.2 / §2.3 / §4.2）
// ============================================================================
// ★ 为什么会有这个文件（2026-11-14 第 14 代）：
//   aurabot 的 host.js 里一直挂着
//       ctx.on('session/event', (session, event) => hub.onSessionEvent(session, event))
//   而全库**没有一处 emit** —— 订阅存在、事件从不发生。
//   于是「一轮跑完了要发回 QQ」这条路从来没通过电，她的回复永远到不了群里。
//
// ★ 事件源在 DSH 那边（它自己的 ctx.on('session/event')）。函数跨不了进程，
//   所以协议 v2 加了单向帧 push：{type:'push', topic, sub, seq, at, data}。
//   这个文件就是把它接回 v4 的 ctx.emit。
//
// ★ 三条纪律（都是踩过的坑）：
//   ① **先 backlog 再实时**：订阅动作与第一帧 push 之间有竞态。实时帧先到的进 buffer，
//      等 backlog 消费完再接上 —— 否则「补的旧帧」会盖掉「刚到的新帧」。
//   ② **幂等**：seq <= 已消费的就丢。重复消费 = 同一句回复在群里发两遍。
//   ③ **拿不到真值就抛**：没有 events 能力就说出来，不许假装订阅成功。
//
// ★ 一处**有损**的地方，明写在这里而不是藏起来：
//   帧若没有整数 seq（协议不符），无法判幂等。丢帧 = 事件永远回不去（判据 #7 直接废），
//   重复帧 = 群里多一条。所以这里**降级为「分发 + 记一次 warn + 计数」**，
//   并把 noSeq 报进 status()。宁可多一条，也不静默全丢。
// ============================================================================

export const BRIDGE_EVENTS_CAP = 'events'
/** 默认订阅的 topic（契约 §2.2 的三个；少订一个就等于少一路信号）。 */
export const DEFAULT_TOPICS = ['session/event', 'handle/revoked', 'host/state']

/**
 * @param {{ whoHas:Function, exec:Function, subscribe?:Function, onHostClose?:Function }} control v4 的 ControlHub
 * @param {{
 *   log?: (m:string)=>void,
 *   onEvent?: (session:object, event:object)=>any,      // ★ 两个参数，不是一整个对象
 *   onRevoked?: (info:object)=>any,
 *   onHostState?: (data:object)=>any,
 *   topics?: string[],
 *   timeoutMs?: number,
 *   retryMs?: number,        // 0 = 不自动重连（测试用）
 *   autoStart?: boolean,     // 默认 false；由调用方在监听器挂好之后显式 start()
 * }} [opts]
 */
export function createBridgeEvents (control, opts = {}) {
  const log = (m) => { try { if (typeof opts.log === 'function') opts.log('[events] ' + String(m)) } catch (e) { /* 日志自己不许炸 */ } }
  const topics = Array.isArray(opts.topics) && opts.topics.length ? opts.topics.map(String) : DEFAULT_TOPICS.slice()
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 20000
  const retryMs = Number.isFinite(opts.retryMs) && opts.retryMs >= 0 ? opts.retryMs : 3000

  let handlers = {
    onEvent: typeof opts.onEvent === 'function' ? opts.onEvent : null,
    onRevoked: typeof opts.onRevoked === 'function' ? opts.onRevoked : null,
    onHostState: typeof opts.onHostState === 'function' ? opts.onHostState : null,
  }

  let started = false
  let stopping = false
  let ready = false            // 订阅成功、backlog 已消费完
  let peerId = null
  let peerHost = null
  let subscriptionId = ''
  let lastError = null
  let lastErrorAt = null
  let timer = null
  let offLocal = null
  let offHostClose = null
  let localInstalled = false
  let chain = Promise.resolve()   // ★ 串行消费：backlog 与实时不许交叠

  const bySub = new Map()      // subscriptionId → 已消费的最大 seq
  const buffer = []            // 订阅完成前到的实时帧
  const warned = new Set()
  const stats = {
    subscribeCalls: 0, resubs: 0, frames: 0, fromBacklog: 0, fromLive: 0, fromBuffer: 0,
    events: 0, revoked: 0, hostState: 0, dropped: 0, gaps: 0, badFrames: 0,
    noSeq: 0, unknownTopic: 0, handlerErrors: 0,
  }

  function warnOnce (key, msg) {
    if (warned.has(key)) return
    warned.add(key)
    log(msg)
  }

  function peers () {
    if (!control || typeof control.whoHas !== 'function') return []
    try { return control.whoHas(BRIDGE_EVENTS_CAP) || [] } catch (e) { return [] }
  }

  /**
   * ★★★ 2026-11-14（第 14 代）：轮询定时器**必须在第一次尝试订阅之前就存在**。
   *
   * 原来它只在「订阅成功」的尾部创建（旧 :276-279）。后果是两条路都断：
   *   ① 宿主还没声明 events 能力 → start() 在 peers() 空那里就抛，
   *      started 永远 false，而 tick() 又要求 started 才动 → **轮询一次都不会跑**；
   *   ② 即使 started 被置 true（exec 那条路失败），timer 仍没创建 → 同样接不上。
   *
   * 实测场景（2026-11-14 01:49）：v4 先起、DSH 后重启 → 事件层永久断开，
   * 只有再重启一次 v4 才接得上。**那不是一个可接受的运维顺序** ——
   * 「宿主晚到」是常态（DSH 重启、断线重连），不是异常。
   */
  function ensureTimer () {
    if (retryMs <= 0 || timer) return
    timer = setInterval(() => { api.tick().catch(() => {}) }, retryMs)
    if (timer.unref) timer.unref()
  }

  function markDown (why) {
    ready = false
    lastError = String(why || '未知原因')
    lastErrorAt = new Date().toISOString()
  }

  /** 后绑处理器（ctx.mjs 用它把 emit 接上）。 */
  function bind (next = {}) {
    if (typeof next.onEvent === 'function') handlers.onEvent = next.onEvent
    if (typeof next.onRevoked === 'function') handlers.onRevoked = next.onRevoked
    if (typeof next.onHostState === 'function') handlers.onHostState = next.onHostState
    return api
  }

  /** 本地订阅只许挂一次 —— 重连时重复挂会让同一帧 emit 两遍（= 群里两条一样的回复）。 */
  function installLocal () {
    if (localInstalled) return
    if (!control || typeof control.subscribe !== 'function') {
      throw new Error('没有控制通道的 subscribe（ControlHub 未就绪）—— 事件层接不上')
    }
    const offs = topics.map((t) => control.subscribe(t, (frame) => onLive(frame)))
    offLocal = () => { for (const off of offs) { try { off() } catch (e) {} } }
    localInstalled = true
  }

  function onLive (frame) {
    if (stopping) return
    stats.frames++
    if (!ready) { buffer.push(frame); return }
    stats.fromLive++
    enqueue(frame)
  }

  function enqueue (frame, from) {
    chain = chain
      .then(() => consume(frame, from))
      .catch((e) => { stats.handlerErrors++; log('消费帧出错：' + ((e && e.message) || e)) })
    return chain
  }

  function curSeq () {
    const v = bySub.get(subscriptionId)
    return Number.isInteger(v) ? v : 0
  }

  function consume (frame, from) {
    if (!frame || typeof frame !== 'object') { stats.badFrames++; warnOnce('bad-frame', '收到不是对象的帧，已丢'); return }
    const topic = String(frame.topic || '')
    const sub = String(frame.sub || subscriptionId || '')
    const seq = Number.isInteger(frame.seq) ? frame.seq : null

    // ── 幂等 ──────────────────────────────────────────────
    if (sub && seq !== null) {
      const seen = bySub.get(sub)
      if (Number.isInteger(seen)) {
        if (seq <= seen) { stats.dropped++; return }
        if (seq !== seen + 1) { stats.gaps++; warnOnce('gap:' + sub, 'seq 不连续（' + seen + ' → ' + seq + '，缺 ' + (seq - seen - 1) + ' 帧）—— 补帧没补上，或者宿主跳号了') }
      }
      bySub.set(sub, seq)
    } else {
      // ★ 无 seq = 协议不符。见文件头那条取舍：分发，但计数 + warn。
      stats.noSeq++
      warnOnce('no-seq', '收到没有整数 seq 的 push 帧 —— 无法判幂等（降级为分发，重复帧会重复触发监听器）')
    }

    // ── 按 topic 分发 ─────────────────────────────────────
    if (topic === 'session/event') {
      const d = frame.data
      const session = d && d.session
      const event = d && d.event
      if (!session || !event) {
        stats.badFrames++
        warnOnce('bad-session-event', 'session/event 帧缺 data.session 或 data.event —— 不分发（分发了只会让监听器读 undefined 抛错）')
        return
      }
      stats.events++
      return callHandler('onEvent', session, event)
    }

    if (topic === 'handle/revoked') {
      stats.revoked++
      return callHandler('onRevoked', frame.data || {})
    }

    if (topic === 'host/state') {
      stats.hostState++
      return callHandler('onHostState', frame.data || {})
    }

    stats.unknownTopic++
    warnOnce('topic:' + topic, '不认识的 topic：' + topic + '（已忽略，不猜语义）')
  }

  async function callHandler (name, ...args) {
    const fn = handlers[name]
    if (typeof fn !== 'function') { stats.handlerErrors++; warnOnce('no-handler:' + name, '没有挂 ' + name + ' 处理器 —— 这一帧没人消费'); return }
    try { await fn(...args) }
    catch (e) {
      // ★ 一个监听器抛错不许停掉事件流：后面还有 turn/end 要发回 QQ。
      stats.handlerErrors++
      log('处理器 ' + name + ' 抛错（继续）：' + ((e && e.message) || e))
    }
  }

  /**
   * 订阅（或重订）。★ 幂等：已 ready 且还是同一个宿主时直接返回。
   * @returns {Promise<object>} status()
   */
  async function start () {
    if (stopping) throw new Error('bridge-events 已停止，不能再 start')
    // ★ 先起轮询再谈成败：一次失败不等于永久放弃（见 ensureTimer 的注释）
    ensureTimer()
    const list = peers()
    if (!list.length) {
      const e = new Error('没有宿主声明 ' + BRIDGE_EVENTS_CAP + ' 能力（bridge 版本太旧，或此刻没连上）—— 事件层接不上')
      e.code = 'no-host'
      markDown(e.message)
      throw e
    }
    const peer = list[0]
    if (ready && peerId === peer.id) return api.status()

    installLocal()
    started = true

    const resumeFrom = curSeq()
    stats.subscribeCalls++
    let data = null
    try {
      data = await control.exec(peer.id, BRIDGE_EVENTS_CAP, 'subscribe', {
        topics,
        resumeFrom,
      }, timeoutMs)
    } catch (e) {
      markDown('events/subscribe 失败：' + ((e && e.message) || e))
      throw e
    }

    // ★ control.exec() 只 resolve payload（不包 ok）。业务失败在宿主那边是扔错（走 reject），
    //   所以这里**不能**写 `data.ok === true` —— 那会把成功判成失败（已踩过一次，一次产生 9 条假失败）。
    if (!data || typeof data !== 'object') {
      const e = new Error('events/subscribe 回执为空（协议不符，不等于订阅成功）')
      e.code = 'shape'
      markDown(e.message)
      throw e
    }
    if (data.ok === false) {
      const e = new Error('events/subscribe 被拒绝：' + String(data.message || data.code || '宿主没说原因'))
      e.code = data.code || 'refused'
      markDown(e.message)
      throw e
    }
    const subId = String(data.subscriptionId || '')
    if (!subId) {
      const e = new Error('events/subscribe 回执缺 subscriptionId（协议不符，不能靠猜一个）')
      e.code = 'shape'
      markDown(e.message)
      throw e
    }
    if (subscriptionId && subscriptionId !== subId) stats.resubs++

    if (Number.isInteger(data.seq) && !bySub.has(subId)) bySub.set(subId, data.seq)
    subscriptionId = subId
    peerId = peer.id
    peerHost = peer.host || peer.id

    // ① backlog：形状与 push 帧完全一致，**同一条消费路径**（契约 §2.4）。
    const backlog = data.backlog === undefined ? [] : data.backlog
    if (!Array.isArray(backlog)) {
      const e = new Error('events/subscribe 的 backlog 不是数组（协议不符）')
      e.code = 'shape'
      markDown(e.message)
      throw e
    }
    const ordered = backlog
      .map((f) => (f && typeof f === 'object' ? Object.assign({ sub: subId }, f) : f))
      .sort((a, b) => (Number.isInteger(a && a.seq) ? a.seq : 0) - (Number.isInteger(b && b.seq) ? b.seq : 0))
    for (const f of ordered) { stats.fromBacklog++; await consume(f, 'backlog') }

    // ② buffer：订阅完成前到的实时帧。seq 必然 >= backlog 的最大值（host 单调递增），
    //    所以「先 backlog 后 buffer」= 时间顺序，不会倒挂。重复的自然被幂等挡掉。
    while (buffer.length) {
      const f = buffer.shift()
      stats.fromBuffer++
      await consume(f, 'buffer')
    }

    ready = true
    lastError = null
    log('已订阅 ' + topics.join(',') + '（sub=' + subId + '，host=' + peerHost + '，resumeFrom=' + resumeFrom + '，backlog=' + backlog.length + '）')
    ensureTimer()   // 幂等 —— 正常路径上它早就起好了
    if (!offHostClose && control && typeof control.onHostClose === 'function') {
      offHostClose = control.onHostClose((rec) => {
        if (rec && rec.id === peerId) { markDown('宿主连接断开（' + (rec.host || rec.id) + '）—— 等它回来，用 resumeFrom=' + curSeq() + ' 补帧'); log(lastError) }
      })
    }
    return api.status()
  }

  /**
   * 断线检测（轮询调它）。★ 三种情形都要能自己爬起来：
   * ① 宿主整个不在；② 宿主换了一条连接（peerId 变了）；③ 订阅过但 ready 被清掉。
   * ★ 不许在这里 throw：调用方是 setInterval，抛了就成了未捕获异常。
   */
  async function tick () {
    // ★ 不再要求 started —— 「还没成功过」正是最需要重试的状态
    if (stopping) return api.status()
    const list = peers()
    if (!list.length) { if (ready) markDown('宿主不在（events 能力没有连接）'); return api.status() }
    const alive = peerId && list.some((p) => p.id === peerId)
    if (ready && alive) return api.status()
    try { await start() } catch (e) { markDown('重连失败：' + ((e && e.message) || e)) }
    return api.status()
  }

  /** 退订并停掉轮询。★ 失败只记日志：停止阶段的异常不许把进程收尾拖住。 */
  async function stop () {
    if (stopping) return
    stopping = true
    started = false
    ready = false
    if (timer) { clearInterval(timer); timer = null }
    if (offLocal) { try { offLocal() } catch (e) {} offLocal = null; localInstalled = false }
    if (offHostClose) { try { offHostClose() } catch (e) {} offHostClose = null }
    const sub = subscriptionId
    if (!sub) return
    try {
      const list = peers()
      if (!list.length) { log('退订跳过：宿主已不在（sub=' + sub + '）'); return }
      await control.exec(list[0].id, BRIDGE_EVENTS_CAP, 'unsubscribe', { subscriptionId: sub }, timeoutMs)
    } catch (e) {
      log('退订失败（不影响退出）：' + ((e && e.message) || e))
    }
  }

  function status () {
    return {
      started, ready, peerId, peerHost, subscriptionId,
      lastSeq: curSeq(),
      resumeFrom: curSeq(),
      topics: topics.slice(),
      buffered: buffer.length,
      lastError, lastErrorAt,
      stats: { ...stats },
    }
  }

  const api = {
    start, stop, tick, bind, status,
    /** 直投一帧（测试 / 宿主侧主动注入用）。走的是与实时帧**完全相同**的路径。 */
    handleFrame (frame) { stats.frames++; return enqueue(frame, 'direct') },
    /** 等已排队的帧全部消费完（测试用；关停前也该 await 它，别让半条事件悬着）。 */
    drain () { return chain },
    get ready () { return ready },
    get stats () { return { ...stats } },
    get subscriptionId () { return subscriptionId },
  }
  return api
}
