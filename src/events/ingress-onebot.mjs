// OneBot WS 只读 ingress（core 侧策略；WS 传输在 src/adapters/events-ws.mjs）
// ============================================================================
// 迁入自原型 plugins/aurabot-ingress/src/ingress-onebot.mjs（2026-11-10）。
// 唯一的结构改动：**不自己碰 WebSocket** —— 传输由 transport.create(url) 给，
// 这样「WS 归 adapters」是真的（测试也能塞一个假 transport 进来）。
//
// ★★ 结构上「不会行动」：本文件**没有任何发消息的方法**，
//    也**没有** call(action, params) 这种通用调用通道。整个生命周期里，
//    这条 WS 在握手之后**一个字节都不往上写**（framesOut 恒为 0，mock 侧可验）。
//    想加发送能力的人会发现：这里连一个能塞 action 的地方都没有 —— 那是故意的。
//
// 另外三条：
//   · 自身消息丢弃：post_type==='message_sent' 不进；user_id===self_id 再丢一次。
//   · 群/私聊白名单：默认 allow none（all=false 且 chats 空 → 全丢）。
//   · 重连有上限：默认 3 次后 giveup 并把错误显示出来，不静默无限重试。
// ============================================================================

import { buildEnvelope } from './envelope.mjs'

const WS_STATES = Object.freeze({
  disabled: 'disabled',
  connecting: 'connecting',
  connected: 'connected',
  reconnecting: 'reconnecting',
  giveup: 'giveup',
  stopped: 'stopped',
})

export function createOneBotIngress (opts = {}) {
  const {
    store,
    url,
    tokenProvider = async () => '',
    allow = { all: false, chats: [], private: [] },
    maxReconnect = 3,
    // ★ 2026-11-12：快速重连额度用完之后，转成这个间隔的低频复查。
    //   0 = 关掉慢复查（恢复旧行为：giveup 就彻底停，等人工 restart）。
    slowRetryMs = 60000,
    backoffMs = [250, 500, 1000],
    selfId: cfgSelfId = '',
    bootId,
    redact = (s) => String(s),
    log = () => {},
    now = () => Date.now(),
    onFlush = null,
    // ★ notice 旁路（不落账）。签名 (rawNotice) => void；抛错只记 note，不影响主链路。
    onNotice = null,
    transport = null,
    portSource = '',
  } = opts

  const allowAll = Boolean(allow && allow.all)
  const allowChats = new Set((allow && allow.chats ? allow.chats : []).map(String))

  const counters = {
    received: 0,
    envelopes: 0,
    dup: 0,
    selfDropped: 0,
    notAllowed: 0,
    sentTypeDropped: 0,
    malformed: 0,
    ignored: 0,        // 非 message 的 post_type（心跳/元事件等）
    framesOut: 0,      // ★ 恒为 0：握手之后再没往上写过任何东西
    connectAttempts: 0,
    reconnects: 0,
    rejected: 0,
    // ★ 2026-11-10 加：stop() 之后仍然到达的帧（WS 的 close 是异步的，所以「停 = 立刻不再写」
    //   只能是近似 —— 这里把「迟到帧」变成一个**可观察的计数**，而不是一句口头保证）。
    afterStop: 0,
  }
  const state = {
    id: 'onebot',
    enabled: Boolean(url),
    state: url ? WS_STATES.stopped : WS_STATES.disabled,
    connected: false,
    lastEventAt: null,
    lastError: null,
    lastSource: 'onebot',
    lastDrop: null,
    bootId: bootId || '',
    stoppedAt: null,
  }

  let ws = null
  let timer = null
  let bootFrame = 0
  let stopped = false

  const note = (code, detail) => {
    const row = store && store.pushError ? store.pushError(code, redact(detail)) : { t: new Date(now()).toISOString(), code, detail: redact(detail) }
    state.lastError = { code, detail: redact(detail), at: row.t }
    log('[onebot] ' + code + ' ' + redact(detail))
    return row
  }

  function safeWsUrl (u) {
    try { const x = new URL(u); return x.origin + x.pathname } catch { return '<bad url>' }
  }

  async function connect () {
    if (stopped) return
    if (!state.enabled) { state.state = WS_STATES.disabled; return }
    if (!transport || typeof transport.create !== 'function') {
      state.state = WS_STATES.giveup
      note('NO_TRANSPORT', '没有 WS 传输实现（adapters/events-ws.mjs 没接上）—— 不连，也不假装连上了')
      return
    }
    state.state = counters.connectAttempts === 0 ? WS_STATES.connecting : WS_STATES.reconnecting
    counters.connectAttempts++

    let token = ''
    try { token = String((await tokenProvider()) || '') } catch (e) {
      note('TOKEN_UNAVAILABLE', String(e && e.message || e))
    }
    if (!url) { note('NO_ENDPOINT', '没有端点：不猜端口，必须显式给 wsUrl'); state.state = WS_STATES.disabled; return }

    const full = token
      ? url + (url.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(token)
      : url

    let sock
    try {
      sock = transport.create(full)
    } catch (e) {
      note('CONNECT_FAILED', '连不上 ' + safeWsUrl(url) + '：' + String(e && e.message || e))
      return schedule()
    }
    ws = sock

    sock.onopen = () => {
      state.state = WS_STATES.connected
      state.connected = true
      state.lastError = null
      bootFrame = 0
      log('[onebot] connected ' + safeWsUrl(url))
      if (typeof onFlush === 'function') onFlush()
    }
    sock.onmessage = (m) => {
      // ★★ stop() 之后迟到的帧：在这里就拒绝 —— 不解析、不进 onEvent、不 append。
      //    计数留住（afterStop + lastDrop），因为「停止」是一次状态转换，不是「此后绝对不会有回调」。
      if (stopped) {
        counters.afterStop++
        state.lastDrop = { reason: 'after_stop', at: new Date(now()).toISOString() }
        return
      }
      let d
      try { d = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString('utf8')) } catch {
        counters.malformed++
        return note('MALFORMED_FRAME', '收到的帧不是 JSON')
      }
      try { onEvent(d) } catch (e) { note('HANDLE_FAILED', String(e && e.message || e)) }
    }
    // ★★ 实测坑（2026-11-10，node 22 内置 WebSocket）：
    //   **连接失败时只触发 error，不触发 close。** 只在 onclose 里排重连的话，
    //   计数会永远停在 1，进程就静默卡在 reconnecting —— 正好是设计里最怕的「静默失败」。
    //   所以 error 与 close 共用一次失败处理，且**同一个 socket 只算一次**（两者可能都来）。
    //   ★ 这个 settled 闸门是原型遗留里必须保住的一条，不是可选优化。
    let settled = false
    const fail = (why, code) => {
      if (settled) return
      settled = true
      if (ws === sock) ws = null
      state.connected = false
      if (stopped || state.state === WS_STATES.giveup) return
      note('DISCONNECTED', why + '（code ' + code + '）')
      schedule()
    }
    sock.onerror = (e) => fail('WS 连接/传输失败', e && e.code)
    sock.onclose = (e) => fail('WS 断开', e && e.code)
  }

  function schedule () {
    clearTimeout(timer)
    if (stopped || state.state === WS_STATES.giveup) return
    if (counters.reconnects >= maxReconnect) {
      // ★★ 2026-11-12：giveup **不再等于永久放弃**。
      //
      //   一夜之间踩了两次：网关重启（或随 DSH 一起被关）只要超过几秒，
      //   这里连试 3 次就 giveup，然后**必须人工重启 core** —— 而人工重启 core
      //   又会丢一次桥连接。一个外部依赖的抖动，代价是一次全链路中断。
      //
      //   原设计「不静默无限重试」的理由是**怕快速循环把日志刷爆**，不是怕重试本身。
      //   所以这里保留那条理由：**低频**（默认 60s）+ **每次都记 note**（不静默）。
      //   ★ 快速重连仍然有上限（maxReconnect），giveup 之后的慢复查是另一档。
      state.state = WS_STATES.giveup
      state.connected = false
      note('RECONNECT_GAVE_UP', '已快速重连 ' + maxReconnect + ' 次仍失败，转入每 ' + Math.round(slowRetryMs / 1000) + 's 一次的低频复查（不静默：每次都会记一条）')
      if (typeof onFlush === 'function') onFlush()
      // ★ 慢复查：把「配额用完 = 停摆」改成「配额用完 = 降频」。
      //   每次尝试都 note 一条，所以它**不是静默循环** —— 原设计反对的是那个。
      if (slowRetryMs > 0) {
        timer = setTimeout(() => {
          if (stopped) return
          note('SLOW_RETRY', '低频复查：再试一次连接（每 ' + Math.round(slowRetryMs / 1000) + 's 一次）')
          state.state = WS_STATES.reconnecting
          connect().catch((e) => {
            note('SLOW_RETRY_FAILED', String((e && e.message) || e))
            state.state = WS_STATES.giveup
            schedule()
          })
        }, slowRetryMs)
        if (timer.unref) timer.unref()
      }
      return
    }
    // ★ 走到这里说明还在快速重连的额度内；giveup 之后走的是下面那条慢复查。
    counters.reconnects++
    state.state = WS_STATES.reconnecting
    const wait = backoffMs[Math.min(counters.reconnects - 1, backoffMs.length - 1)]
    log('[onebot] ' + wait + 'ms 后第 ' + counters.reconnects + '/' + maxReconnect + ' 次重连')
    timer = setTimeout(() => { connect().catch((e) => note('RECONNECT_FAILED', String(e && e.message || e))) }, wait)
    if (timer.unref) timer.unref()
  }

  function allowChat (chatId) {
    if (allowAll) return true
    if (allowChats.size === 0) return false           // 默认 allow none
    return allowChats.has(chatId)
  }

  function onEvent (d) {
    // ★★ 第二道闸（第一道在 onmessage）：**停止之后一条也不入账。**
    //    这里是唯一会调 store.append 的入口，所以这条检查放在最前面 —— 先判停，再解析、再过滤。
    if (stopped) {
      counters.afterStop++
      state.lastDrop = { reason: 'after_stop', at: new Date(now()).toISOString() }
      return
    }
    if (!d || typeof d !== 'object') { counters.malformed++; return note('MALFORMED_EVENT', '事件不是对象'); }
    if (d.echo) { counters.ignored++; return }        // API 回执（本 ingress 不调接口，正常不会出现）
    counters.received++

    // ① 自己发出去的回显
    if (d.post_type === 'message_sent') {
      counters.sentTypeDropped++
      state.lastDrop = { reason: 'message_sent', at: new Date(now()).toISOString() }
      return
    }
    // ② 只收 message（★ notice 走旁路：不落账，只通知）
    //
    //   ★★ 2026-11-12：为什么 notice 不能整个丢掉。
    //   「谁戳了她」是戳一戳的判据 —— 她戳回去时优先找那个人。
    //   而那个信息**只在 notice 事件里**（post_type='notice' / sub_type='poke'）。
    //   全丢掉的话，戳一戳就只能戳「这一段最后说话的人」，
    //   而那不是"戳回去"，是"随便戳一个"。
    //
    //   ★ 但它**不进帧账**：账本只存消息帧（coalesce / decide 全部按消息设计），
    //     把 notice 塞进去会让窗口计算和判定都多一种要处理的东西。
    //     所以走旁路：onNotice 回调，调用方自己决定记什么。
    if (d.post_type !== 'message') {
      if (d.post_type === 'notice' && typeof onNotice === 'function') {
        try { onNotice(d) } catch (e) { note('NOTICE_HANDLER_THREW', String((e && e.message) || e)) }
      }
      counters.ignored++
      return
    }

    const selfId = String(d.self_id || cfgSelfId || '')
    const userId = String(d.user_id || '')
    // ③ 自身消息（self_id 可能来自首个事件；拿不到就退回配置里的号）
    if (!selfId) {
      counters.ignored++
      state.lastDrop = { reason: 'no_self_id', at: new Date(now()).toISOString() }
      return
    }
    if (userId === selfId) {
      counters.selfDropped++
      state.lastDrop = { reason: 'self', chatId: '', at: new Date(now()).toISOString() }
      return
    }

    const isGroup = d.message_type === 'group'
    const chatId = isGroup ? 'group:' + String(d.group_id) : 'private:' + userId
    // ④ 白名单
    if (!allowChat(chatId)) {
      counters.notAllowed++
      state.lastDrop = { reason: 'not_allowed', chatId, at: new Date(now()).toISOString() }
      return
    }

    bootFrame++
    const env = buildEnvelope({
      source: 'onebot',
      type: 'message',
      payload: d,                                  // ★ 原事件对象整个留下，不裁剪
      chatId,
      userId,
      messageId: d.message_id === undefined || d.message_id === null ? '' : String(d.message_id),
      bootId: state.bootId,
      raw_ptr: 'onebot:ws#' + state.bootId + '/' + bootFrame,
      createdAt: typeof d.time === 'number' ? d.time : null,
      receivedAt: now(),
      ingress: 'onebot',
      extra: {
        sub: isGroup ? 'group' : 'private',
        selfId,
        groupId: isGroup ? String(d.group_id) : '',
        sender: d.sender && typeof d.sender === 'object'
          ? { nickname: String(d.sender.nickname || ''), card: String(d.sender.card || ''), role: String(d.sender.role || '') }
          : null,
      },
    })

    if (!store) { counters.malformed++; return note('NO_STORE', '没有事件账，事件无处落') }
    const r = store.append(env)
    if (r.ok) {
      counters.envelopes++
      state.lastEventAt = env.received_at
      state.lastSource = 'onebot'
      if (typeof onFlush === 'function') onFlush()
    } else if (r.code === 'DUPLICATE') {
      counters.dup++
    } else {
      // READONLY / NOT_CONFIGURED / WRITE_FAILED —— 一律可见，不吞
      counters.rejected++
      state.lastError = { code: r.code, detail: r.message, at: new Date(now()).toISOString() }
      log('[onebot] 事件没落盘：' + r.code + ' ' + r.message)
      if (typeof onFlush === 'function') onFlush()
    }
  }

  function snapshot () {
    return {
      id: 'onebot',
      enabled: state.enabled,
      state: state.state,
      connected: state.connected,
      lastEventAt: state.lastEventAt,
      lastError: state.lastError,
      dedupCount: counters.dup,
      lastSource: state.lastSource,
      lastDrop: state.lastDrop,
      // ★ 可靠性可观察面：停止不是「从来没启用」，也不是「绝对瞬时」
      stopped: stopped,
      stoppedAt: state.stoppedAt,
      bootId: state.bootId,
      endpoint: safeWsUrl(url),
      portSource: portSource || 'config.wsUrl',
      counters: { ...counters },
      capability: { receive: true, send: false },   // ★ 能力清单：只有收
    }
  }

  return {
    id: 'onebot',
    start () { stopped = false; state.stoppedAt = null; return connect().catch((e) => note('CONNECT_THROWN', String(e && e.message || e))) },
    stop () {
      stopped = true
      state.stoppedAt = new Date(now()).toISOString()
      clearTimeout(timer)
      // ★ 用 stopped 而不是 disabled："关掉了"和"从来没启用"在状态里必须能分开，
      //   否则离线快照会把它读成「未启用」—— 那会掩盖「它刚才还在收」。
      state.state = WS_STATES.stopped
      state.connected = false
      try { if (ws && typeof ws.close === 'function') ws.close() } catch { /* ignore */ }
      ws = null
    },
    snapshot,
    get counters () { return { ...counters } },
    get state () { return state.state },
    // ★ 这里刻意没有 send / call / sendText —— 不是忘了，是设计。
  }
}
