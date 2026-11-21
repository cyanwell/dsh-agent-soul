// bridge-services.mjs —— 数据服务的异步代理（bridge 协议 v2 · §2.4 / §4.4）
// ============================================================================
// ★ 为什么要有这个文件（2026-11-14 第 14 代）：
//   aurabot 搬进 v4 之后，它要的 llm / attachments / workspaceRegistry / sessions
//   都在 DSH 进程里。之前这条路是「一个个 cap 现写」——工作区一条、会话一条、工具一条，
//   每加一个服务就要在两边各写一遍。契约 v2 把它收口成 **一个 service cap**：
//       {cap:'service', action:'call', args:{ name, method, args:[…] }}
//   host 侧白名单 + 原样返回服务方法的真值。
//
// ★ 三条纪律：
//   ① **只代理「数据服务」**。返回活对象的（agent / resolveAgent）只能走句柄通道 ——
//      对象跨不了进程，硬塞过去只会得到一层「看起来有方法、其实全是空壳」的假货。
//   ② **拿不到真值就 throw**。不返回空对象、不返回 []、不返回 null 冒充成功。
//   ③ **失败形状要带 code**：宿主扔过来的 stage/code 一路带到 v4 的 error 上。
//
// ★ 三处**有损**，明写在这里而不是藏起来：
//   · 同步方法代理不了（llm.listProviders() 就地迭代返回值）。→ 调它时延迟抛，
//     不用「返回 Promise」去糊（那会在调用处的 for…of 里炸得更难查）。
//   · 流式方法代理不了（llm.stream() 是 async generator，一帧一帧推）。→ 同样延迟抛。
//   · archivedSessionIds 是**属性**不是方法，而属性只能同步读。→ getter + 2s 缓存，
//     启动时先 await ready()（见 index.mjs 装配段），把竞态窗口缩到启动那一刻。
// ============================================================================

export const BRIDGE_SERVICE_CAP = 'service'

/** 白名单里的服务名（契约 §2.4）。★ 不在这个表里的名字不许代理 —— 反射任意属性是另一回事。 */
export const SERVICE_NAMES = ['llm', 'attachments', 'workspaceRegistry', 'sessions', 'sessionController']

/**
 * 跨进程**代理不了**的方法（实测出来的，不是猜的）。
 * 这些名字访问时不抛（typeof 探测要能过），**调用时**才抛 —— 抛得越晚越接近真因。
 */
const UNPROXYABLE = new Map([
  ['llm.listProviders', '同步方法（就地迭代返回值），跨进程只能异步'],
  ['llm.stream', '流式方法（async generator），一帧一帧推，跨进程代理不了'],
])

/** Proxy 上不能被当成服务方法的键（不排除的话 await proxy 会去读 then → 死循环）。 */
const NON_METHOD = new Set([
  'then', 'catch', 'finally', 'toJSON', 'constructor', 'inspect', 'toPrimitive',
  'toString', 'valueOf', '__proto__', 'length', 'name', 'prototype',
])

export const UNSUPPORTED = 'unsupported'

/**
 * @param {{ whoHas:Function, exec:Function }} control v4 的 ControlHub
 * @param {{
 *   log?: (m:string)=>void,
 *   timeoutMs?: number,
 *   cacheTtlMs?: number,
 *   fetchArchived?: ()=>Promise<string[]>,
 * }} [opts]
 */
export function createBridgeServices (control, opts = {}) {
  const log = (m) => { try { if (typeof opts.log === 'function') opts.log('[services] ' + String(m)) } catch (e) {} }
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 20000
  const cacheTtlMs = Number.isFinite(opts.cacheTtlMs) && opts.cacheTtlMs >= 0 ? opts.cacheTtlMs : 2000

  const stats = { calls: 0, failures: 0, lastError: null, lastErrorAt: null, lastMethod: null }

  function peers () {
    if (!control || typeof control.whoHas !== 'function') return []
    try { return control.whoHas(BRIDGE_SERVICE_CAP) || [] } catch (e) { return [] }
  }

  function fail (msg, extra) {
    stats.failures++
    stats.lastError = String(msg).slice(0, 240)
    stats.lastErrorAt = new Date().toISOString()
    const e = new Error(msg)
    if (extra && extra.code) e.code = String(extra.code)
    if (extra && extra.stage) e.stage = String(extra.stage)
    if (extra && extra.name) e.service = String(extra.name)
    if (extra && extra.method) e.method = String(extra.method)
    log(msg)
    return e
  }

  /**
   * 调一个服务方法。**返回宿主给的原始返回值**（null / 0 / false 都是合法真值）。
   *
   * ★ 判失败只看两样，不许写成「要求 ok===true」：
   *   ① exec **reject**（宿主把失败扔出来了 —— 这是主路径）
   *   ② payload 是明确的失败形状 {ok:false, code?, message?}（有些宿主不扔错，回失败帧）
   *   ★ 曾经写成「要求 ok===true」，把 9 条成功全判成失败 —— 因为 exec 只交 payload，payload 里没有 ok。
   */
  async function callService (name, method, args, kind) {
    const svc = String(name || '')
    const mth = String(method || '')
    if (!svc || !mth) throw fail('service/call 需要 name 和 method', { name: svc, method: mth })
    const list = peers()
    if (!list.length) {
      throw fail('没有宿主声明 ' + BRIDGE_SERVICE_CAP + ' 能力（bridge 版本太旧，或此刻没连上）—— 不猜服务返回值',
        { name: svc, method: mth, code: 'no-host' })
    }
    const peer = list[0]
    const payload = { name: svc, method: mth, args: Array.isArray(args) ? args : [args] }
    // ★ kind:'get' 是**读属性**的显式形状（archivedSessionIds 不是方法）。
    //   契约 §2.4 说它是属性，但 service/call 只谈 method —— 这个字段就是补那个洞的。
    if (kind === 'get') payload.kind = 'get'

    stats.calls++
    stats.lastMethod = svc + '/' + mth
    let data
    try {
      data = await control.exec(peer.id, BRIDGE_SERVICE_CAP, 'call', payload, timeoutMs)
    } catch (e) {
      throw fail('service/' + svc + '.' + mth + ' 失败（host=' + (peer.host || peer.id) + '）：' + String((e && e.message) || e),
        { name: svc, method: mth, code: (e && (e.code || e.stage)) || 'call-failed', stage: e && e.stage })
    }
    if (data && typeof data === 'object' && data.ok === false) {
      throw fail('service/' + svc + '.' + mth + ' 被宿主拒绝：' + String(data.message || data.error || data.code || '没有原因'),
        { name: svc, method: mth, code: data.code || data.stage, stage: data.stage })
    }
    return data === undefined ? null : data
  }

  /**
   * 造一个「长得像那个服务」的代理。
   * ★ 方法名照抄原生签名 —— 调用方写什么名字就转发什么名字，不在这里猜一张方法表
   *   （猜出来的表一旦和宿主对不上，错误会呈现成「方法不存在」，而不是「我猜错了」）。
   */
  function makeProxy (name) {
    const target = Object.create(null)
    return new Proxy(target, {
      get (t, prop) {
        if (typeof prop === 'symbol' || NON_METHOD.has(prop)) return undefined
        const key = String(prop)
        // ★ 同步/流式的方法：**访问时不抛**（typeof x === 'function' 这类探测到处都是），
        //   调用时才抛 —— 抛出点离真因越近越好。
        const why = UNPROXYABLE.get(name + '.' + key)
        if (why) {
          return () => { throw fail(name + '.' + key + ' 代理不了：' + why, { name, method: key, code: UNSUPPORTED }) }
        }
        return (...args) => callService(name, key, args, 'call')
      },
      has () { return true },
      set () { return false },
    })
  }

  // ── archivedSessionIds：属性，不是方法 ──────────────────────────────────
  //
  // ★ 这是整个代理层里唯一**不能等**的东西：hub.js:213 写的是
  //     (reg.archivedSessionIds || []).includes(sid)
  //   同步读。而真值在另一个进程 —— 只能缓存。
  //   ★ 缓存过期后的第一次读仍然返回旧值（并且去后台刷新），**不让调用方等**；
  //     所以这里如实暴露 ok / at / why，谁要精确谁先 await refreshArchived()。
  const archived = { value: [], at: 0, ok: false, why: null, inflight: null }

  function refreshArchived () {
    if (archived.inflight) return archived.inflight
    const fn = typeof opts.fetchArchived === 'function'
      ? () => opts.fetchArchived()
      : () => callService('workspaceRegistry', 'archivedSessionIds', [], 'get')
    archived.inflight = Promise.resolve()
      .then(() => fn())
      .then((v) => {
        const ids = Array.isArray(v) ? v : (v && Array.isArray(v.ids) ? v.ids : null)
        if (ids) {
          archived.value = ids.map(String)
          archived.ok = true
          archived.why = null
        } else {
          // ★ 形状不对就说出来，并且**不把旧值当新值**（ok=false 让调用方知道这批数可能是陈的）。
          archived.ok = false
          archived.why = 'archivedSessionIds 回执不是数组：' + JSON.stringify(v === undefined ? null : v).slice(0, 120)
          log(archived.why)
        }
        archived.at = Date.now()
        return archived.value
      })
      .catch((e) => {
        archived.ok = false
        archived.why = String((e && e.message) || e)
        archived.at = Date.now()
        log('取 archivedSessionIds 失败（保留上一批 ' + archived.value.length + ' 条）：' + archived.why)
        return archived.value
      })
      .finally(() => { archived.inflight = null })
    return archived.inflight
  }

  function makeWorkspaceRegistry () {
    return {
      async list () {
        const data = await callService('workspaceRegistry', 'list', [], 'call')
        if (Array.isArray(data)) return data
        if (data && Array.isArray(data.items)) return data.items
        throw fail('workspaceRegistry.list 回执不是数组（协议不符，不是「没有工作区」）', { name: 'workspaceRegistry', method: 'list', code: 'shape' })
      },
      async create (dir, title) {
        const p = String(dir || '').trim()
        if (!p) throw fail('workspaceRegistry.create 需要一个目录路径', { name: 'workspaceRegistry', method: 'create', code: 'bad-request' })
        const data = await callService('workspaceRegistry', 'create', title ? [p, String(title)] : [p], 'call')
        if (data && data.workspace) return data.workspace
        if (data && data.id) return data
        throw fail('workspaceRegistry.create 回执缺 workspace/id（协议不符）', { name: 'workspaceRegistry', method: 'create', code: 'shape' })
      },
      async get (id) {
        const key = String(id || '').trim()
        if (!key) throw fail('workspaceRegistry.get 需要一个 id', { name: 'workspaceRegistry', method: 'get', code: 'bad-request' })
        const data = await callService('workspaceRegistry', 'get', [key], 'call')
        if (data && data.workspace) return data.workspace
        return data || undefined
      },
      /** ★ 同步 getter（调用方 hub.js:213 就是同步读的）。过期就顺手踢一次后台刷新。 */
      get archivedSessionIds () {
        if (Date.now() - archived.at > cacheTtlMs && !archived.inflight) refreshArchived().catch(() => {})
        return archived.value.slice()
      },
      /** 这批数是不是「刚取到的真值」。false = 可能是陈的 / 从来取到过。 */
      get archivedFresh () { return archived.ok && (Date.now() - archived.at) <= cacheTtlMs },
      archivedState () { return { ids: archived.value.slice(), ok: archived.ok, at: archived.at, why: archived.why } },
      refreshArchived,
    }
  }

  // ── sessions ─────────────────────────────────────────────────────────
  //
  // ★ flush 的原生签名是 flush(session)（对象）。跨进程只能传 id ——
  //   这里把「session 对象 / {session} / 字符串」都归一成 id，别让调用方改代码。
  function sessionIdOf (x) {
    if (!x) return ''
    if (typeof x === 'string') return x.trim()
    if (typeof x === 'object') {
      if (typeof x.id === 'string' && x.id) return x.id
      if (x.session && typeof x.session.id === 'string') return x.session.id
      if (typeof x.sessionId === 'string') return x.sessionId
    }
    return ''
  }

  const sessions = {
    async list () {
      const data = await callService('sessions', 'list', [], 'call')
      if (Array.isArray(data)) return data
      if (data && Array.isArray(data.items)) return data.items
      throw fail('sessions.list 回执不是数组（协议不符）', { name: 'sessions', method: 'list', code: 'shape' })
    },
    async get (idOrObj) {
      const sid = sessionIdOf(idOrObj)
      if (!sid) throw fail('sessions.get 需要 sessionId', { name: 'sessions', method: 'get', code: 'bad-request' })
      return callService('sessions', 'get', [sid], 'call')
    },
    async flush (idOrObj) {
      const sid = sessionIdOf(idOrObj)
      if (!sid) throw fail('sessions.flush 需要 sessionId（原生签名收 session 对象，跨进程只能传 id）', { name: 'sessions', method: 'flush', code: 'bad-request' })
      return callService('sessions', 'flush', [sid], 'call')
    },
  }

  /** service cap 的 describe（列白名单与各服务方法）—— 排障时先问它，别猜方法名。 */
  async function describe () {
    const list = peers()
    if (!list.length) throw fail('没有宿主声明 ' + BRIDGE_SERVICE_CAP + ' 能力（describe 无从问起）', { code: 'no-host' })
    let data
    try {
      data = await control.exec(list[0].id, BRIDGE_SERVICE_CAP, 'describe', {}, timeoutMs)
    } catch (e) {
      throw fail('service/describe 失败：' + String((e && e.message) || e), { code: (e && (e.code || e.stage)) || 'describe-failed' })
    }
    if (!data || typeof data !== 'object') throw fail('service/describe 回执不是对象（协议不符）', { code: 'shape' })
    return data
  }

  const api = {
    /** 底层：给别的适配器复用（bridge-workspaces 就用它取 archivedSessionIds）。 */
    call: callService,
    describe,
    /** 各服务的代理对象（契约 §2.4 的四个）。 */
    llm: makeProxy('llm'),
    attachments: makeProxy('attachments'),
    workspaceRegistry: makeWorkspaceRegistry(),
    sessions,
    /**
     * sessionController 的**数据面**（create / rename 是纯数据）。
     * ★ resolveAgent 不在这里：它返回活 agent，只能走句柄通道（bridge-session-controller）。
     */
    sessionController: {
      async create (request = {}) { return callService('sessionController', 'create', [request], 'call') },
      async rename (request = {}) { return callService('sessionController', 'rename', [request], 'call') },
    },
    /** 启动时把 archivedSessionIds 先取一遍（把 hub.js:213 的首次竞态窗口关掉）。 */
    async ready () {
      try { await refreshArchived() } catch (e) { log('ready 取 archivedSessionIds 失败（继续，getter 会重试）：' + ((e && e.message) || e)) }
      return api.status()
    },
    refreshArchived,
    status () {
      return {
        ...stats,
        hosts: peers().length,
        archived: {
          count: archived.value.length,
          ok: archived.ok,
          at: archived.at,
          why: archived.why,
          fresh: archived.ok && (Date.now() - archived.at) <= cacheTtlMs,
        },
      }
    },
    get archivedSessionIds () { return archived.value.slice() },
  }
  return api
}

/** 有没有宿主举手干这件活（面板/体检用，不抛）。 */
export function hasBridgeServices (control) {
  try {
    const peers = control && typeof control.whoHas === 'function' ? control.whoHas(BRIDGE_SERVICE_CAP) : []
    return Array.isArray(peers) && peers.length > 0
  } catch (e) { return false }
}
