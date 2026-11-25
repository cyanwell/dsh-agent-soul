// aurabot 在 v4 里的 ctx 适配器
// ============================================================================
// 目标：让 `src/aurabot/src/host.js` 的 `apply(ctx)` 能在 v4 里跑起来。
//
// ★ 为什么可行（2026-11-12 量过）：host.js 对宿主的所有依赖只有 9 处 ——
//   ctx.effect / ctx.webServer.register / ctx.llm / ctx.on
//   ctx.interval / ctx.systemPrompt.variable / ctx.get / ctx.logger
//   而 **52 个 route 全部收敛到 ctx.webServer.register 一个调用**。
//   所以这个对上，一次就通 52 个接口。
//
// ★★ 两条纪律：
//   ① **默认不启动外部连接** —— 现在的 aurabot 插件还在 DSH 里跑着（57470 的
//      /aurabot/api/state 返回 200），两个同时连一个 QQ 号就是双发。
//      注册路由可以，起连接不行。
//   ② **effect 立刻执行并收集 dispose** —— cordis 的语义，aurabot 里到处用它。
// ============================================================================

import { createBridgeEvents } from './bridge-events.mjs'

const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

export function createAurabotCtx (opts = {}) {
  const out = (opts.log || ((m) => console.log(m)))
  const minLevel = LOG_LEVELS[opts.logLevel || 'info'] || 20

  const routes = new Map()
  const disposers = []
  const listeners = new Map()
  const intervals = []
  const variables = new Map()

  const logAt = (lv) => (m) => { if ((LOG_LEVELS[lv] || 20) >= minLevel) out('[aurabot/' + lv + '] ' + String(m)) }
  const logger = { debug: logAt('debug'), info: logAt('info'), warn: logAt('warn'), error: logAt('error') }
  logger.child = () => logger

  const effect = (fn, label) => {
    try {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
      return d
    } catch (e) {
      // ★ effect 里抛错不该把整插件带下去：一个 route 注册失败，别的还该活着
      out('[aurabot] effect 失败' + (label ? '（' + label + '）' : '') + '：' + String((e && e.message) || e))
      return undefined
    }
  }

  const webServer = {
    register (spec) {
      const p = String((spec && spec.path) || '')
      if (!p || typeof spec.handler !== 'function') {
        out('[aurabot] register 参数不全: ' + JSON.stringify({ path: p, kind: spec && spec.kind }).slice(0, 120))
        return () => {}
      }
      if (routes.has(p)) out('[aurabot] 路由重复注册（后者覆盖）: ' + p)
      routes.set(p, { handler: spec.handler, kind: spec.kind || 'exact' })
      return () => { routes.delete(p) }
    },
  }

  const on = (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event).add(fn)
    return () => { const s = listeners.get(event); if (s) s.delete(fn) }
  }

  const interval = (fn, ms) => {
    const t = setInterval(() => { try { fn() } catch (e) { out('[aurabot] interval 抛错: ' + String((e && e.message) || e)) } }, ms)
    if (t.unref) t.unref()
    intervals.push(t)
    return () => { clearInterval(t); const i = intervals.indexOf(t); if (i >= 0) intervals.splice(i, 1) }
  }

  /* ★★★ 2026-11-14（第 14 代 · 协议 v2 补的第五通道）：每轮动态上下文。
   *
   * 真 DSH 里宿主每轮**同步**调 text() 去拼提示词；跨进程做不到同步回调。
   * 所以这里**登记**，由投递方（bridge-session-controller 的 followup/steer）
   * 在发包前同步算一次，作为消息的**第一个块**带过去 —— 位置和 memory 的
   * 「你记得这些事…」一致，都是「先说背景，再说正文」。
   *
   * ★ 差在哪（不藏）：它不再是「提示词变量」，而是「消息前缀」。
   *   对模型来说两者都在上下文里，但**前缀会进会话历史**，变量不会。
   *   代价是历史里多一段重复文本；好处是时序天然正确、不用新开一条同步通道。 */
  const promptContexts = []   // [{name, order, text}]

  const systemPrompt = {
    variable (n, fn) { variables.set(String(n), fn); return () => { variables.delete(String(n)) } },
    context (spec) {
      const s = spec || {}
      const row = { name: String(s.name || ''), order: Number(s.order) || 500, text: s.text }
      promptContexts.push(row)
      return () => { const i = promptContexts.indexOf(row); if (i >= 0) promptContexts.splice(i, 1) }
    },
  }

  /** 同步渲染所有已登记的上下文（投递前调）。任何一段抛错只丢那一段，不拖垮整条投递。 */
  function renderPromptContexts () {
    return promptContexts
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((r) => {
        try { return typeof r.text === 'function' ? String(r.text() || '') : String(r.text || '') }
        catch (e) { out('[aurabot] prompt context 抛错（' + r.name + '）：' + String((e && e.message) || e)); return '' }
      })
      .filter((s) => s.trim())
      .join('\n\n')
  }

  const services = opts.services || {}
  const get = (n) => services[n]

  const emit = async (event, ...args) => {
    const s = listeners.get(event)
    if (!s) return []
    const rs = []
    for (const fn of s) {
      try { rs.push(await fn(...args)) } catch (e) { out('[aurabot] 监听器抛错（' + event + '）: ' + String((e && e.message) || e)) }
    }
    return rs
  }

  // ★★★ 2026-11-14（第 14 代 · 协议 v2）：**回程的入口就在这三行。**
  //
  //   全库没有一处调 emit —— 于是 host.js 里那句
  //       ctx.on('session/event', (session, event) => hub.onSessionEvent(session, event))
  //   的监听器**一次都没被调过**。她跑完一轮、话生成出来了、然后就没有然后了。
  //
  //   现在：bridge-events 收到宿主 push 的 session/event 帧 → 调 emit → 监听器 → hub.onSessionEvent
  //   → 发回 QQ。★ 签名必须是 (session, event) **两个参数**，不能塞成一个对象
  //   （塞成一个对象时 onSessionEvent 的形参就错位了，而错位的失败在日志里长得像「没有事件」）。
  let events = opts.events || null
  let eventsOwned = false
  if (!events && opts.control && opts.bridgeEvents !== false) {
    try {
      events = createBridgeEvents(opts.control, {
        // ★ 事件层的日志**不许被 quiet 吞掉**：quiet 是「别唠叨」，而「事件层没接上」
        //   等于「她的话回不到 QQ」—— 那件事在日志里消失，排查就只剩猜。
        log: typeof opts.eventLog === 'function' ? opts.eventLog : (m) => out('[aurabot] ' + String(m)),
        topics: opts.eventTopics,
        retryMs: opts.eventRetryMs,
      })
      eventsOwned = true
    } catch (e) {
      // ★ 建不出来要说出来：事件层没了等于「她的话回不到 QQ」，而那种失败最容易被当成「今天没人说话」。
      out('[aurabot] bridge-events 建不起来（事件层不通）：' + String((e && e.message) || e))
      events = null
    }
  }
  if (events && typeof events.bind === 'function') {
    events.bind({
      onEvent: (session, event) => emit('session/event', session, event),
      onRevoked: opts.onRevoked,
    })
  }

  const ctx = {
    effect,
    webServer,
    on,
    interval,
    systemPrompt,
    get,
    logger,
    // Core events ingress is the only QQ WebSocket receiver in the embedded v4 host.
    aurabotOneBotConnect: opts.onebotConnect === true,
    // ★ 2026-11-14：services.llm 必须一起参与 —— 下面那圈「只补 ctx 上没有的键」
    //   会因为 'llm' in ctx 为 true 而跳过它，于是 opts.llm || null 会把
    //   「本地没有 llm 时退回 bridge 代理」这条路整个吃掉（表现为 ctx.llm === null）。
    llm: opts.llm || (services && services.llm) || null,
    dispose () {
      // ★ 事件层是异步的（要发退订帧）：这里 fire-and-forget，且**不等** —— 退出不该被网络拖住。
      if (events && typeof events.stop === 'function') {
        try { Promise.resolve(events.stop()).catch((e) => out('[aurabot] events 停止时出错：' + String((e && e.message) || e))) } catch (e) {}
      }
      for (const d of disposers.splice(0)) { try { d() } catch (e) {} }
      for (const t of intervals.splice(0)) clearInterval(t)
      routes.clear()
      listeners.clear()
      variables.clear()
    },
  }

  // ★★★ 2026-11-14（第 14 代）：把 services 也摊到 ctx 上 —— 这才是 cordis 的 ctx.svc 语义。
  //   之前只有 ctx.get('x')，于是 aurabot 源码里 `dsh.agents.get(sid)` 这种写法
  //   会抛 `Cannot read properties of undefined (reading 'get')`（hub.js:189），
  //   而那个错被上层 catch 成「会话 xxx 恢复不了，换一个新的」——
  //   表现成「莫名其妙换会话」，真因只是一行属性访问。
  //   ★ 只补 ctx 上**没有**的键：已有能力（effect/webServer/on/…）不许被 services 覆盖。
  for (const [k, v] of Object.entries(services)) {
    if (!(k in ctx)) ctx[k] = v
  }

  return {
    ctx,
    routes,
    variables,
    promptContexts,
    systemPrompt,
    registerPromptContext: (spec) => systemPrompt.context(spec),
    renderPromptContexts,
    emit,
    events,
    eventsOwned,
    view () {
      return {
        routes: routes.size,
        listeners: [...listeners.keys()].map((k) => k + ':' + listeners.get(k).size),
        variables: [...variables.keys()],
        promptContexts: promptContexts.length,
        intervals: intervals.length,
        disposers: disposers.length,
        // ★ 事件层有没有真的接上，面板要能看见（不然「订阅了但没有事件」永远是猜）。
        events: events ? events.status() : null,
      }
    },
  }
}