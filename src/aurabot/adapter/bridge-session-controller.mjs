// bridge-session-controller.mjs —— 把 DSH 的会话入口借给 aurabot（它在 v4 进程里跑）
// ============================================================================
// ★ 为什么需要（2026-11-13 第 14 代）：
//   hub.createSession() 拿到工作区之后，紧接着三件事都发生在 DSH 那一侧：
//       controller().create({ workspaceId, agentPreset })   → 建会话
//       controller().rename({ sessionId, title })           → 改标题
//       controller().resolveAgent(sid)                      → 拿回活 agent
//   而 v4 的适配 ctx 里没有 sessionController —— 于是第二条路也断在这里。
//
// ★ 三条边界，必须写在前面（这是这一版与「真 DSH 里跑」的差距）：
//   ① create / rename 是纯映射，跨进程没问题。
//   ② **agent 对象拿不回来**。真 agent 身上有 session.append / ctx.tools.register /
//      ctx.systemPrompt.context，这些操作的是 DSH 进程内的东西，跨进程代理不了。
//      所以这里返回的是一个「够聊天的句柄」：id / session.id / followup / steer 有，
//      挂工具和挂提示是 noop。
//   ③ 因此：**能让她说话，不能给她加工具**。要加工具，那段逻辑得搬进 DSH 侧。
//      这一条不当 bug 藏起来 —— 谁看到这里，都该知道差在哪。
//
// ★ 失败必须外显：拿不到宿主就抛，绝不回空对象冒充「建好了」。
// ============================================================================

import { createBridgeToolHost } from './bridge-tools.mjs'

export const BRIDGE_SESSION_CAP = 'session'

function pickHost (control) {
  if (!control || typeof control.whoHas !== 'function') {
    const e = new Error('没有控制通道（control hub 未就绪）—— 无法通过 bridge 操作会话')
    e.code = 'no-host'
    throw e
  }
  let peers = []
  try { peers = control.whoHas(BRIDGE_SESSION_CAP) || [] } catch (e) { peers = [] }
  if (!peers.length) {
    // ★ code 必须带：调用处（hub.js 的自愈路径）靠它区分「没有宿主」和「会话不存在」。
    const e = new Error('没有宿主声明 ' + BRIDGE_SESSION_CAP + ' 能力（bridge 版本太旧，或此刻没连上）—— 不猜测')
    e.code = 'no-host'
    throw e
  }
  return peers[0]
}

async function call (control, action, args, timeoutMs) {
  const peer = pickHost(control)
  let data = null
  try {
    data = await control.exec(peer.id, BRIDGE_SESSION_CAP, action, args || {}, timeoutMs)
  } catch (e) {
    // ★★ 2026-11-14（协议 v2）：**code 原来在这里被丢掉了。**
    //   hub 已经把宿主回的 stage/code 挂到 error 上（hub.mjs 的 result 分支），
    //   而这一行重新包了一个 new Error —— 剥掉了 code，于是 attach 失败在 v4 侧
    //   只剩下一句中文，调用处（hub.js 的自愈路径）拿不到任何机器可读判据。
    const err = new Error('session/' + action + ' 失败（host=' + (peer.host || peer.id) + '）：' + String((e && e.message) || e))
    err.code = (e && (e.code || e.stage)) ? String(e.code || e.stage) : 'call-failed'
    if (e && e.stage) err.stage = String(e.stage)
    throw err
  }
  // ★★★ 2026-11-14 00:20（第 14 代）：**这一行原来把「成功」判成了「失败」。**
  //
  //   原文：`if (!data || data.ok !== true) throw ...`
  //   错在哪：`control.exec()` 在**传输层**已经判过 ok 了 —— 桥回的是
  //     {type:'result', ok:true, data:payload}，hub 的 exec 只把 **payload** 交出来。
  //     所以这里拿到的 data 是 bridge 的业务回执，里面**没有 ok 字段**。
  //     session/followup 的业务回执长这样：
  //       {delivered:true, sessionId, target, how, candidates, ambiguous, chars}
  //   后果（2026-11-14 00:14 实测）：会话真的被唤醒了、真的投进去了，
  //     而 v4 报「回执不 ok」—— 于是她看到的是「投递失败」，日志里全是失败。
  //
  //   现在：只判「有没有回执」。业务层失败（not-found / 超时 / 没投成）
  //   在 bridge 那边是**扔错**的，会走 exec 的 reject —— 不需要在这里再判一次。
  if (!data) throw new Error('session/' + action + ' 回执为空（协议不符，不等于「做成了」）')
  return data
}

/**
 * 造一个「长得像 sessionController」的对象。只有 hub 用到的那三个方法。
 * @param {{ whoHas: Function, exec: Function }} control v4 的 ControlHub
 */
export function createBridgeSessionController (control, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 20000
  const log = (m) => { try { if (typeof opts.log === 'function') opts.log('[session] ' + String(m)) } catch (e) {} }
  // ★ 句柄缓存：sessionId → { handleId, agent, at }
  //   为什么缓存：hub.js:189 的 `dsh.agents.get(sid)` 是**同步**读的，
  //   而 attach 是异步的 —— 同步位置只能命中已经 attach 过的那些。
  const handles = new Map()
  // ★ 复验周期。没有它的话，句柄一旦缓存就永远不会失效 ——
  //   除非 handle/revoked 事件真的通（而事件层这两天才刚接上）。
  //   30 秒的代价是「多一次 attach」，换来的是「自愈路径不会静默失效」。
  const revalidateMs = Number.isFinite(opts.revalidateMs) && opts.revalidateMs > 0 ? opts.revalidateMs : 30000

  /**
   * ★★★ 2026-11-14（第 14 代）：把 hub 交给 agent.followup 的 payload 归一成 content 块数组。
   *
   * ★ 这里原来只取 payload.content[0].text —— 而 hub.js:1272 传的 content 是
   *   [记忆召回提示, 群聊正文]，**第一块是记忆，第二块才是人真正说的话**。
   *   只取第一块 = 她收到的是「你记得这些事…」，看不到任何人在说话。
   *
   * ★ 实测证据（一手，不是推断）：session-0c90de16 在 2026-11-14 01:03:03 的
   *   user/message，content 只有 1 个块、352 字、内容是记忆召回提示，群聊正文不存在。
   *   她那一轮回了「[沉默]」—— 因为她确实没听到话，那是**正确反应**。
   *
   * 现在：整个数组原样透传，一个块都不许丢；回执里的 blocks 可以让调用方核对。
   */
  /**
   * 把「每轮动态上下文」拼到消息最前面。
   *
   * ★ 为什么是消息前缀、不是提示词变量：⊂跨进程没有同步回调⊃ —— 宿主拼提示词是同步的，
   *   而我们只能异步问 v4。所以改成「投递前算好、随消息带过去」，时序天然正确。
   * ★ 顺序：上下文（身份/规则/印象）→ memory hint（「你记得这些事…」）→ 正文。
   *   前两块都是模块加的，正文才是人说的话。
   */
  function withContext (blocks) {
    let ctxText = ''
    try { ctxText = typeof opts.renderContext === 'function' ? String(opts.renderContext() || '') : '' } catch (e) { ctxText = '' }
    if (!ctxText.trim()) return blocks
    return [{ type: 'text', text: ctxText }, ...blocks]
  }

  function toBlocks (payload) {
    if (typeof payload === 'string') return payload.trim() ? [{ type: 'text', text: payload }] : []
    if (!payload || typeof payload !== 'object') return []
    if (Array.isArray(payload.content) && payload.content.length) {
      return payload.content.filter((b) => b && typeof b === 'object' && typeof b.type === 'string')
    }
    if (typeof payload.text === 'string' && payload.text.trim()) return [{ type: 'text', text: payload.text }]
    return []
  }

  /**
   * 一个会话句柄：够说话，不够挂东西。
   * ★ 2026-11-14（协议 v2）：多了 handleId —— attach 的产物。
   *   followup/steer 把 **sessionId 和 handleId 一起发**：
   *     · 老 bridge 只认 sessionId，多余字段它不理（向后兼容，不会因为升级协议就断）；
   *     · 新 bridge 认 handleId，并能在句柄失效时回 handle/revoked（不再「静默成功」）。
   */
  function handleOf (sessionId, handleId) {
    const id = String(sessionId || '')
    const hid = String(handleId || '')
    const ref = () => (hid ? { sessionId: id, handleId: hid } : { sessionId: id })
    // ★★★ 2026-11-14（第 14 代）：工具走**转发器** —— 真实现留在这边，DSH 侧挂壳。
    //   之前这里是 noop，代价是：她连 report_to_lead 都调不到，事件层从 11-12 起没通电。
    const tools = createBridgeToolHost(control, { sessionId: id, log: opts.log, timeoutMs })
    return {
      id,
      session: {
        id,
        // ★ 真 DSH 上这个能写事件（模型选择走的就是它）。跨进程做不到 —— 如实抛，
        //   调用处（hub.js 的模型选择分支）在 try 里，抛了会退回默认模型。
        append () {
          throw new Error('v4 侧的会话句柄不支持 session.append（跨进程，只有 DSH 进程内能写事件）')
        },
      },
      // ★ 安全壳，不是能力：挂工具/挂提示在 v4 侧不成立。
      //   为什么返回 noop 而不抛：hub.mount() 里这几处都在 try 里，抛了只会刷日志；
      //   noop 的语义更准 —— 「这个宿主不在这里挂东西」。
      // ★ tools.register 现在是**真的**：登记到 v4 的 invokers，并让 DSH 侧挂转发器。
      //   （2026-11-14 之前这里是 noop —— 那正是事件层从没通电的原因）
      tools,
      ctx: {
        tools: {
          register: (reg) => tools.register(reg),
          restrict: () => () => {},
        },
        // ★★★ 2026-11-14（第 14 代）：这里不再是空壳。
        //   登记的上下文由 withContext 在投递前同步渲染，作为消息的**第一个块**带过去。
        //   ★ 语义变了：它不再是「提示词变量」（跨进程没有同步回调），而是「消息前缀」。
        //     代价与理由写在 ctx.mjs 的 promptContexts 注释里 —— 那是同一条决定的两半。
        systemPrompt: {
          context: (spec) => {
            try {
              const off = typeof opts.registerPromptContext === 'function' ? opts.registerPromptContext(spec) : null
              return typeof off === 'function' ? off : () => {}
            } catch (e) { return () => {} }
          },
        },
      },
      async followup (payload) {
        const blocks = toBlocks(payload)
        if (!blocks.length) throw new Error('followup 内容为空（text 或 content 块数组都没有）')
        return call(control, 'followup', Object.assign(ref(), { content: withContext(blocks) }), timeoutMs)
      },
      async steer (payload) {
        const blocks = toBlocks(payload)
        if (!blocks.length) throw new Error('steer 内容为空')
        return call(control, 'steer', Object.assign(ref(), { content: withContext(blocks) }), timeoutMs)
      },
    }
  }

  /**
   * 向宿主要一个句柄（契约 §2.5）。**失败一定 throw**，绝不编一个 handleId。
   *
   * ★ 回执判据只有两样（不是 `ok===true`）：
   *   ① exec reject —— 主路径（桥那边把失败扔出来）
   *   ② payload 明确是失败帧 `{ok:false, code}`
   *   其余一律当成功，然后**校验** handleId 在不在（缺 = 协议不符，不是成功）。
   *
   * @returns {Promise<{ handleId:string, agent:object, session:object }>}
   */
  async function attach (sid) {
    const sessionId = String(sid || '').trim()
    if (!sessionId) {
      const e = new Error('session/attach 需要 sessionId')
      e.code = 'bad-request'
      throw e
    }
    let data
    try {
      data = await call(control, 'attach', { sessionId }, timeoutMs)
    } catch (e) {
      // ★★ 自愈路径的开关就在这三行：**code 必须带出去**。
      //   hub.js:205-218 的 catch 会把它写进日志（「会话 xxx 恢复不了（not-found）」），
      //   而不是一句没有原因的失败 —— 后者在日志里看起来和「今天没人说话」一模一样。
      const err = new Error('会话 ' + sessionId + ' attach 失败：' + String((e && e.message) || e))
      err.code = (e && e.code) || 'attach-failed'
      if (e && e.stage) err.stage = String(e.stage)
      err.sessionId = sessionId
      throw err
    }
    if (!data) {
      const e = new Error('session/attach 回执为空（协议不符，不等于拿不到句柄）')
      e.code = 'shape'
      e.sessionId = sessionId
      throw e
    }
    if (data.ok === false) {
      const e = new Error('会话 ' + sessionId + ' attach 被拒绝：' + String(data.message || data.error || data.code || '宿主没说原因'))
      e.code = String(data.code || data.stage || 'attach-refused')
      if (data.stage) e.stage = String(data.stage)
      e.sessionId = sessionId
      throw e
    }
    const handleId = String(data.handleId || '')
    if (!handleId) {
      const e = new Error('session/attach 回执缺 handleId（协议不符 —— 不许自己编一个）')
      e.code = 'shape'
      e.sessionId = sessionId
      throw e
    }
    // 旧句柄如果换了 id，撤掉旧的（否则宿主那边的句柄表只增不减）
    const old = handles.get(sessionId)
    if (old && old.handleId && old.handleId !== handleId) {
      call(control, 'detach', { handleId: old.handleId }, timeoutMs).catch((e) => log('撤旧句柄失败 ' + old.handleId + '：' + ((e && e.message) || e)))
    }
    const agent = handleOf(sessionId, handleId)
    handles.set(sessionId, { handleId, agent, at: Date.now() })
    log('attach ' + sessionId + ' → ' + handleId + (data.session && data.session.title ? '（' + data.session.title + '）' : ''))
    return { handleId, agent, session: data.session || { id: sessionId } }
  }

  /**
   * 句柄失效：从缓存里删掉。**下一条消息会重新 attach** —— 那正是自愈。
   * @param {{handleId?:string, sessionId?:string, reason?:string, code?:string}} info
   * @returns {number} 删掉几条
   */
  function revoke (info) {
    const handleId = String((info && info.handleId) || '')
    const sessionId = String((info && info.sessionId) || '')
    if (!handleId && !sessionId) {
      log('收到 handle/revoked 但既没有 handleId 也没有 sessionId —— 无法定位，忽略（宿主那边协议不符）')
      return 0
    }
    let removed = 0
    for (const [sid, rec] of [...handles]) {
      if ((handleId && rec.handleId === handleId) || (sessionId && sid === sessionId)) { handles.delete(sid); removed++ }
    }
    log('句柄失效 ' + (handleId || sessionId) + '（' + String((info && (info.reason || info.code)) || '未说明原因') + '）'
      + ' —— 清掉 ' + removed + ' 条缓存；下一条消息会重新 attach')
    return removed
  }

  /** 收尾：把登记的句柄都还给宿主。★ 失败逐条记日志，不静默（静默 = 谁的句柄没还回去都不知道）。 */
  async function detachAll () {
    const items = [...handles]
    handles.clear()
    const failed = []
    for (const [, rec] of items) {
      try { await call(control, 'detach', { handleId: rec.handleId }, timeoutMs) }
      catch (e) { failed.push({ handleId: rec.handleId, error: String((e && e.message) || e) }) }
    }
    if (failed.length) log('detachAll：' + failed.length + ' 条没还回去（' + failed.map((f) => f.handleId).join(',') + '）')
    return { detached: items.length - failed.length, failed }
  }

  return {
    async create (request = {}) {
      const args = {}
      if (request.workspaceId) args.workspaceId = String(request.workspaceId)
      if (request.agentPreset) args.agentPreset = String(request.agentPreset)
      if (request.cwd) args.cwd = String(request.cwd)
      const data = await call(control, 'create', args, timeoutMs)
      if (!data.sessionId) throw new Error('session/create 回执缺 sessionId：' + JSON.stringify(data).slice(0, 200))
      // ★ 收口成 hub 期望的形状：它只读 r.sessionId
      return { sessionId: data.sessionId, preset: data.preset || null }
    },
    async rename (request = {}) {
      const sid = String(request.sessionId || '').trim()
      if (!sid) throw new Error('rename 需要 sessionId')
      return call(control, 'rename', { sessionId: sid, title: String(request.title || '') }, timeoutMs)
    },
    /**
     * ★★★ 2026-11-14（协议 v2）：**这个方法必须会失败。**
     *
     *   为什么这一条是整晚的开关（契约 §2.5）：hub.js:205-218 有三段自愈 ——
     *       try { agent = await resolveAgent(sid) } catch { 换一个新会话 }
     *       if (reg.archivedSessionIds.includes(sid)) { 换一个新的 }
     *    而原来的实现是 `return { agent: handleOf(sid) }`（无条件返回句柄）——
     *    **三个触发器全部失效**：会话被归档、agent 被 dispose、宿主换了一轮，
     *    v4 都会 happily 拿着一个已经死了的句柄继续投递，投递失败的错被 readback 当成「模型没回」。
     *
     *   现在：先缓存 → 再 attach（真的问宿主这个会话还活着吗）→ 失败就 throw，带 code。
     */
    async resolveAgent (sessionId) {
      const sid = String(sessionId || '').trim()
      if (!sid) throw new Error('resolveAgent 需要 sessionId')
      const hit = handles.get(sid)
      if (hit && (Date.now() - hit.at) < revalidateMs) return { agent: hit.agent, handleId: hit.handleId, cached: true }
      const r = await attach(sid)
      return { agent: r.agent, handleId: r.handleId, cached: false }
    },
    attach,
    /** 句柄失效（来自 handle/revoked push，或调用方自己知道它死了）。 */
    revoke,
    /** sessionId → 活句柄的**同步**门面（给 ctx.services.agents）。 */
    agents: {
      get (id) {
        const raw = String(id || '')
        if (!raw) return undefined
        const sid = raw.startsWith('session-') ? raw.slice('session-'.length) : raw
        const hit = handles.get(sid) || handles.get(raw)
        return hit ? hit.agent : undefined
      },
      roots () { return [...handles.keys()] },
      /** 面板用：只报 id/handleId/时间，不交出 agent 对象（它不可序列化）。 */
      list () { return [...handles.entries()].map(([sid, r]) => ({ sessionId: sid, handleId: r.handleId, at: r.at })) },
    },
    detachAll,
    status () {
      return {
        cap: BRIDGE_SESSION_CAP,
        handles: [...handles.entries()].map(([sid, r]) => ({ sessionId: sid, handleId: r.handleId, ageMs: Date.now() - r.at })),
        revalidateMs,
        timeoutMs,
      }
    },
  }
}
