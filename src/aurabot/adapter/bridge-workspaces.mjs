// bridge-workspaces.mjs —— 把 DSH 的工作区注册表借给 aurabot（它现在跑在 v4 进程里）
// ============================================================================
// ★ 为什么需要这个文件（2026-11-13 第 14 代，爀曦定的方向）：
//   aurabot 搬进 v4 之后，它手里的 `ctx` 是 agent-soul/src/aurabot/adapter/ctx.mjs 造的适配对象，
//   里面**没有** workspaceRegistry 服务 —— 于是 host.js → hub.ensureWorkspace() 那句
//   `dsh.workspaceRegistry || dsh.get('workspaceRegistry')` 两个都是 undefined，
//   每条 QQ 消息都在这里断掉，日志只有一行「宿主没有 workspaceRegistry」。
//   那行字看起来像配置问题，其实是通道缺口：**能力在 DSH 里，只是 aurabot 够不着。**
//
// ★ 修法不是把 aurabot 搬回 DSH（那是倒退），而是走既定的那条唯一通道：
//   **bridge**。爀曦原话：「如果没有对应的这个服务，就写进 bridge 里，让它能被调动」。
//
// ★ 失败必须外显：拿不到宿主就抛，绝不回空数组冒充「没有工作区」——
//   空数组和「读不到」在调用方眼里长得一模一样，那正是 11-13 那天所有坑的共同形状。
// ============================================================================

export const BRIDGE_WORKSPACES_CAP = 'workspaces'

function pickHost (control) {
  if (!control || typeof control.whoHas !== 'function') {
    const e = new Error('没有控制通道（control hub 未就绪）—— 无法通过 bridge 取工作区')
    e.code = 'no-host'
    throw e
  }
  let peers = []
  try { peers = control.whoHas(BRIDGE_WORKSPACES_CAP) || [] } catch (e) { peers = [] }
  if (!peers.length) {
    // ★ code 必须带：调用处（hub.js 的自愈路径）靠它区分「没有宿主」和「会话不存在」。
    const e = new Error('没有宿主声明 ' + BRIDGE_WORKSPACES_CAP + ' 能力（bridge 版本太旧，或此刻没连上）—— 不猜测')
    e.code = 'no-host'
    throw e
  }
  return peers[0]
}

async function call (control, action, args, timeoutMs) {
  const peer = pickHost(control)
  let data = null
  try {
    data = await control.exec(peer.id, BRIDGE_WORKSPACES_CAP, action, args || {}, timeoutMs)
  } catch (e) {
    throw new Error('workspaces/' + action + ' 失败（host=' + (peer.host || peer.id) + '）：' + String((e && e.message) || e))
  }
  // ★★★ 2026-11-14 00:20（第 14 代）：同 bridge-session-controller 里那处 —— 这里也判错了一层。
  //   `control.exec()` 只交出 payload；bridge 的业务回执（{action,count,items} 等）里没有 ok 字段。
  //   原文要求 data.ok===true，等于**只要回执带了数据就判失败**。
  //   业务失败在 bridge 那边是扔错（走 exec 的 reject），这里只需判「有没有回执」。
  if (!data) throw new Error('workspaces/' + action + ' 回执为空（协议不符，不是「没有工作区」）')
  if (data && typeof data === 'object' && data.ok === false) {
    throw new Error('workspaces/' + action + ' 被宿主拒绝：' + String(data.message || data.error || data.code || '没有原因'))
  }
  return data
}

/**
 * 造一个「长得像 workspaceRegistry」的对象，塞进 aurabot 的 ctx.services。
 *
 * ★ 三个方法都是 **async** —— 因为真正的执行方在另一个进程。
 *   调用侧（hub.ensureWorkspace）已经写成 `await reg.list()` / `await reg.create(...)`，
 *   而 await 一个普通数组是合法的，所以同一个调用点既能喂真 DSH ctx、也能喂这份代理。
 *
 * @param {{ whoHas: Function, exec: Function }} control  v4 的 ControlHub
 * @param {{ timeoutMs?: number }} [opts]
 */
export function createBridgeWorkspaceRegistry (control, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 15000
  const log = (m) => { try { if (typeof opts.log === 'function') opts.log('[workspaces] ' + String(m)) } catch (e) {} }
  const cacheTtlMs = Number.isFinite(opts.cacheTtlMs) && opts.cacheTtlMs >= 0 ? opts.cacheTtlMs : 2000

  // ── archivedSessionIds：**属性**，不是方法（契约 §2.4）────────────────────
  //
  // ★ 为什么单独处理：hub.js:213 写的是
  //     (reg.archivedSessionIds || []).includes(sid)
  //   同步读。而真值在 DSH 进程里 —— 只能缓存。缓存没过期就用缓存；
  //   过期了**仍然返回旧值**，同时踢一次后台刷新（不让每条 QQ 消息都等一次跨进程往返）。
  //   ★ 所以这里必须如实暴露 ok / at / why：客户代码拿到的可能是「上一批」。
  const archived = { value: [], at: 0, ok: false, why: null, inflight: null }

  async function fetchFromService () {
    // ★ 属性只能靠 kind:'get' 表达（service/call 只谈 method）。
    //   host 侧要照这个形状实现：kind==='get' → 读属性，不做函数调用。
    const peer = pickHost(control)
    let data
    try {
      data = await control.exec(peer.id, 'service', 'call', {
        name: 'workspaceRegistry', method: 'archivedSessionIds', args: [], kind: 'get',
      }, timeoutMs)
    } catch (e) {
      throw new Error('service/workspaceRegistry.archivedSessionIds 失败（host=' + (peer.host || peer.id) + '）：' + String((e && e.message) || e))
    }
    const ids = Array.isArray(data) ? data : (data && Array.isArray(data.ids) ? data.ids : (data && Array.isArray(data.value) ? data.value : null))
    if (!ids) throw new Error('archivedSessionIds 回执不是数组（协议不符，不是「没有归档会话」）')
    return ids
  }

  function refreshArchived () {
    if (archived.inflight) return archived.inflight
    const fn = typeof opts.fetchArchived === 'function' ? () => opts.fetchArchived() : fetchFromService
    archived.inflight = Promise.resolve()
      .then(() => fn())
      .then((v) => {
        const ids = Array.isArray(v) ? v : (v && Array.isArray(v.ids) ? v.ids : (v && Array.isArray(v.value) ? v.value : null))
        if (ids) { archived.value = ids.map(String); archived.ok = true; archived.why = null }
        else { archived.ok = false; archived.why = '回执不是数组：' + JSON.stringify(v === undefined ? null : v).slice(0, 120); log(archived.why) }
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

  return {
    /** @returns {Promise<Array<{id,path,title,createdAt,sessionIds}>>} */
    async list () {
      const data = await call(control, 'list', {}, timeoutMs)
      if (!Array.isArray(data.items)) throw new Error('workspaces/list 回执缺 items 数组（协议不符，不是「没有工作区」）')
      return data.items
    },
    /** 幂等：同一条规范化路径已有工作区就复用，否则新建。 */
    async create (dir, title) {
      const p = String(dir || '').trim()
      if (!p) throw new Error('create 需要一个目录路径')
      const args = title ? { path: p, title: String(title) } : { path: p }
      const data = await call(control, 'ensure', args, timeoutMs)
      if (!data.workspace) throw new Error('workspaces/ensure 回执缺 workspace')
      return data.workspace
    },
    async get (id) {
      const key = String(id || '').trim()
      if (!key) throw new Error('get 需要一个工作区 id')
      const data = await call(control, 'get', { id: key }, timeoutMs)
      return data.workspace || undefined
    },
    async archiveSession (sessionId) {
      const key = String(sessionId || '').trim()
      if (!key) throw new Error('archiveSession 需要 sessionId')
      const peer = (() => {
        if (!control || typeof control.whoHas !== 'function') throw new Error('没有控制通道——无法归档 session')
        let peers = []
        try { peers = control.whoHas('service') || [] } catch {}
        if (!peers.length) throw new Error('没有宿主声明 service 能力——无法归档 session')
        return peers[0]
      })()
      try {
        const receipt = await control.exec(peer.id, 'service', 'call', {
          name: 'workspaceRegistry', method: 'archiveSession', args: [key],
        }, timeoutMs)
        // DSH service gateway encodes a void archiveSession success as null.
        if (receipt && typeof receipt === 'object' && receipt.ok === false) {
          throw new Error('宿主拒绝 archiveSession：' + String(receipt.message || receipt.error || receipt.code || '没有原因'))
        }
        return receipt
      } catch (error) {
        throw new Error('service/workspaceRegistry.archiveSession 失败（host=' + (peer.host || peer.id) + '）：' + String((error && error.message) || error))
      }
    },
    /**
     * ★ 同步 getter（hub.js:213 就是同步读的）。过期就顺手踢一次后台刷新。
     * ★ 首次访问（还没取到过）返回 []，此时 archivedFresh === false ——
     *   index.mjs 装配时会先 await ready() 把这一窗口关掉。
     */
    get archivedSessionIds () {
      if (Date.now() - archived.at > cacheTtlMs && !archived.inflight) refreshArchived().catch(() => {})
      return archived.value.slice()
    },
    get archivedFresh () { return archived.ok && (Date.now() - archived.at) <= cacheTtlMs },
    archivedState () { return { ids: archived.value.slice(), ok: archived.ok, at: archived.at, why: archived.why } },
    refreshArchived,
  }
}

/** 有没有宿主举手干这件活（面板/体检用，不抛）。 */
export function hasBridgeWorkspaces (control) {
  try {
    const peers = control && typeof control.whoHas === 'function' ? control.whoHas(BRIDGE_WORKSPACES_CAP) : []
    return Array.isArray(peers) && peers.length > 0
  } catch (e) {
    return false
  }
}
