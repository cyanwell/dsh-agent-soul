// bridge-tools.mjs —— 把 aurabot 的工具**挂到 DSH 的 agent 上**（她在 v4 里跑）
// ============================================================================
// ★ 问题（2026-11-13 第 14 代实测）：
//   aurabot 的 hub.mount(agent) 要给会话挂 QQ 工具（发图、查记忆、记忆写入…），
//   它调 agent.ctx.tools.register(fn)。而 agent 活在 DSH 进程里、实现活在 v4 进程里 ——
//   **函数跨不了进程**。于是 v4 那个 ctx 只能是 noop 安全壳，工具一个都挂不上，
//   她于是连 report_to_lead 都调不到，事件层从 11-12 起就没通过电（队列只有一条自检）。
//
// ★ 解法：**转发器 + 反向调用**。
//   ① v4：工具的真实现登记进 ControlHub 的 invokers 表（文件名 → 函数，只在本地）；
//   ② DSH 侧：bridge 在 agent 上注册一个同名「转发器」，execute 时发
//      { type:'invoke', tool, args } 回 v4；
//   ③ v4 执行完回 { type:'invoke-result', ok, data|error }。
//   ★ 全程只有 JSON，没有函数跨界 —— 那条线本来就不可能跨。
//
// ★ 失败必须可见：注册不上就抛/打日志，绝不「静默挂载成功但工具是空的」。
// ============================================================================

export const BRIDGE_AGENT_CAP = 'agent'

function pickHost (control) {
  if (!control || typeof control.whoHas !== 'function') throw new Error('没有控制通道（ControlHub 未就绪）')
  const peers = control.whoHas(BRIDGE_AGENT_CAP) || []
  if (!peers.length) throw new Error('没有宿主声明 ' + BRIDGE_AGENT_CAP + ' 能力（bridge 版本太旧，或此刻没连上）')
  return peers[0]
}

/**
 * 造一个「够用的 ctx.tools」——只有 register（aurabot 只用这一个，restrict 是 noop）。
 *
 * @param {{ registerInvoker:Function, whoHas:Function, exec:Function }} control v4 的 ControlHub
 * @param {{ log?:Function, timeoutMs?:number }} [opts]
 */
export function createBridgeToolHost (control, opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  // ★ 工具是挂在**某一个会话的 agent** 上的（hub.mount(agent) 逐会话挂），
  //   所以注册必须带 sessionId —— 不带的话 DSH 那边不知道该挂给谁。
  const sessionId = String(opts.sessionId || '').trim()
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 30000
  const mounted = new Map()   // key → { offInvoke, offRemote }

  function register (spec) {
    const name = String((spec && spec.name) || '').trim()
    if (!name) throw new Error('工具需要一个名字')
    if (typeof (spec && spec.execute) !== 'function') throw new Error('工具 ' + name + ' 没有 execute')

    /* ★★★ 2026-11-14（第 14 代）：**这里原来是 `'aurabot:' + name` —— 冒号不合法。**
     *
     * 实测（2026-11-14 02:43，真跑一轮才暴露）：
     *   400 {"code":"InvalidParameter",
     *        "message":"tools.4.function.name: expected 1-128 ASCII letters, digits, underscores or hyphens"}
     *   模型 API 对 function name 只收 [a-zA-Z0-9_-]，冒号直接 BadRequest，
     *   于是**整轮请求被拒** —— 她一个字都回不了。
     *
     * ★ 单测测不出这个：那是我自己造的假宿主，不会去校验名字字符集。
     *   只有真跑一轮才会撞上。这条注释留着，免得以后有人觉得「冒号更好看」再改回去。 */
    const key = 'aurabot_' + name
    // ① 本地登记：宿主发 invoke 时按这个名字找回来
    const offInvoke = control.registerInvoker(key, spec.execute)

    // ② 让 DSH 侧挂转发器（异步 —— exec 是 Promise）
    let offRemote = () => {}
    Promise.resolve()
      .then(() => pickHost(control))
      /* ★★★ 2026-11-14（第 14 代）：**先撤旧名，再挂新名。**
       *
       * 实测事故（02:51，会话文件里的直接证据）：同一个 agent 上**同时挂着两套工具**——
       *   araubot:qq_chat_history … araubot:report_to_lead   ← 10 个旧名（带冒号）
       *   aurabot_qq_chat_history … aurabot_report_to_lead   ← 10 个新名（下划线）
       * 而带冒号的 10 个**不合法**（模型 API 只收 [a-zA-Z0-9_-]）→ 整轮 BadRequest → 她一个字都回不了。
       *
       * 为什么旧的会留在这儿：v4 重启后 `mounted` Map 是空的，**没有任何人记得
       * DSH 那边还挂着上一次注册的工具** —— 宿主侧的注册是**凭据式**的，不是 v4 内存的镜像。
       * 所以撤销必须能在「新进程、零记忆」的情况下发生：**每次注册顺手把旧名撤一遍**。
       *
       * ★ 不依赖「旧名一定是 araubot:xxx」这个具体形状 —— 两种都撤，撤掉不存在的也不报错。 */
      .then(async (peer) => {
        for (const stale of ['aurabot:' + name]) {
          try { await control.exec(peer.id, BRIDGE_AGENT_CAP, 'tool-unregister', { sessionId, name: stale }, 8000) } catch (e) {}
        }
        return peer
      })
      .then((peer) => control.exec(peer.id, BRIDGE_AGENT_CAP, 'tool-register', {
        sessionId,
        name: key,
        description: String(spec.description || ''),
        /* ★★★ 2026-11-14（第 14 代）：**这里原来读的是错字段。**
         *
         * 实测事故（03:05，一手证据：会话文件里她那次工具调用的 arguments）：
         *   她调 report_to_lead 时传的是 {"content":"【事件层连通性测试…】"} —— 只有一个 content，
         *   而工具定义的参数明明叫 tier / title / facts / why。
         *
         * 根因：aurabot 的 defineTool（src/tools/tools.js:8-30）返回的是
         *     { name, description, parameters: {type,properties,required,additionalProperties}, output, execute }
         *   —— **schema 在 `parameters` 里，顶层没有 properties / required。**
         *   而这里原来读 `spec.properties` / `spec.required`，两个都是 undefined →
         *   挂到模型上的工具是**零参数**的 → 模型自己编一个 content 塞进来 →
         *   工具实现收到 args.tier/title/facts 全是空 → 队列里 title/facts/why 全空 →
         *   事件层虽然读到了，却解出一条没有正文的 event。
         *
         * ★ 一个字段名错了，断的是「事件层能不能带内容」这一整条。 */
        parameters: (() => {
          const fromSpec = spec && typeof spec === 'object' ? spec.parameters : null
          if (fromSpec && typeof fromSpec === 'object' && fromSpec.type) return fromSpec
          // 兼容裸形状（单测里常用）：顶层给 properties / required
          return {
            type: 'object',
            properties: (spec && spec.properties && typeof spec.properties === 'object') ? spec.properties : {},
            required: Array.isArray(spec && spec.required) ? spec.required : [],
          }
        })(),
        timeoutMs,
      }, 15000))
      .then(() => {
        offRemote = () => {
          try {
            const peer = (control.whoHas(BRIDGE_AGENT_CAP) || [])[0]
            if (peer) control.exec(peer.id, BRIDGE_AGENT_CAP, 'tool-unregister', { sessionId, name: key }, 8000).catch(() => {})
          } catch (e) {}
        }
        log('[tools] 已挂到 DSH：' + key)
      })
      .catch((e) => {
        // ★ 挂不上要说出来 —— 这正是今晚（11-13）那整条链断掉时「看不出来」的地方
        log('[tools] 挂载失败 ' + key + '：' + String((e && e.message) || e))
      })

    const dispose = () => {
      offInvoke()
      try { offRemote() } catch (e) {}
      mounted.delete(key)
    }
    mounted.set(key, dispose)
    return dispose
  }

  return {
    register,
    /** 只登记本地实现、不通知 DSH（单测/离线用）。 */
    registerLocal (spec) {
      const key = 'aurabot_' + String((spec && spec.name) || '').trim()
      return control.registerInvoker(key, spec.execute)
    },
    disposeAll () { for (const d of [...mounted.values()]) { try { d() } catch (e) {} } },
    get size () { return mounted.size },
  }
}
