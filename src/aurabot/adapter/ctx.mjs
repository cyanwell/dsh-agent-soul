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

  const systemPrompt = {
    variable (n, fn) { variables.set(String(n), fn); return () => { variables.delete(String(n)) } },
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

  const ctx = {
    effect,
    webServer,
    on,
    interval,
    systemPrompt,
    get,
    logger,
    llm: opts.llm || null,
    dispose () {
      for (const d of disposers.splice(0)) { try { d() } catch (e) {} }
      for (const t of intervals.splice(0)) clearInterval(t)
      routes.clear()
      listeners.clear()
      variables.clear()
    },
  }

  return {
    ctx,
    routes,
    variables,
    emit,
    view () {
      return {
        routes: routes.size,
        listeners: [...listeners.keys()].map((k) => k + ':' + listeners.get(k).size),
        variables: [...variables.keys()],
        intervals: intervals.length,
        disposers: disposers.length,
      }
    },
  }
}