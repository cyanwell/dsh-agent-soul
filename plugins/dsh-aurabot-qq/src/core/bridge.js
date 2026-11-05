// 联动：让 DSH 里别的插件、别的会话，还有电脑上别的程序也能用她。
//
// 1. 别的 DSH 插件：ctx.get('aurabot') 拿到服务对象（同一个进程里直接调，不用密钥）
// 2. DSH 里别的会话（比如平时写代码的会话）：面板里打开后，注册几个全局工具（aurabot_*），
//    那边的 AI 能让她发 QQ、查她的记忆、调用模块。她自己的 QQ 会话里会屏蔽这些工具。
// 3. 别的程序：开放 HTTP 接口 /aurabot/api/open/*，要带密钥（请求头 Authorization: Bearer 密钥）
//
// 能发给谁：白名单里的人和群（或者只能发给主人，看设置）。总开关、试运行照常管着。

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { defineTool } from '../tools/tools.js'

const RING = 300

export function createBridge({ ctx, getConfig, setConfig, hub, mods, log, version, apiVersion, overview }) {
  const events = [] // 最近发生的事（收到的消息、她发出去的话、模块发的事件），别的程序轮询用
  let seq = 0
  let toolOffs = []
  let toolNames = []

  function record(type, data) {
    events.push({ seq: ++seq, at: Date.now(), type, ...data })
    if (events.length > RING) events.shift()
  }

  // ---------- 能发给谁 ----------
  function canSend(target) {
    const cfg = getConfig()
    const [kind, id] = String(target || '').split(':')
    if (!id || !['private', 'group'].includes(kind)) return '目标要写成 private:QQ号 或 group:群号'
    if (cfg.bridge.allowTargets === 'owner') return kind === 'private' && id === cfg.ownerQQ ? '' : '设置成了只能发给主人'
    const ok = kind === 'group' ? cfg.allow.groups : [cfg.ownerQQ, ...cfg.allow.private]
    return ok.includes(id) ? '' : '不在白名单里，不能发'
  }
  const ownerTarget = () => `private:${getConfig().ownerQQ}`

  // ---------- 大家共用的几个操作 ----------
  const ops = {
    info: async () => {
      const o = await overview()
      return {
        ok: true, version, apiVersion,
        online: o.onebot.state === 'connected', login: o.onebot.login,
        enabled: o.config.enabled, dryRun: o.config.dryRun, mood: o.mood?.label || '',
        modules: mods.status().map((m) => ({ id: m.id, name: m.name, running: m.running })),
      }
    },
    /** 让她把一段话发出去（会拆条、可以带 <voice> <sticker:名字>）。target 不填 = 发给主人。 */
    send: async ({ target, text } = {}) => {
      const t = String(target || ownerTarget())
      const why = canSend(t)
      if (why) return { ok: false, message: why }
      if (!String(text || '').trim()) return { ok: false, message: '要说点什么' }
      await hub.deliver(t, String(text))
      const cfg = getConfig()
      return { ok: true, message: !cfg.enabled ? '总开关关着，没真发' : cfg.dryRun ? '试运行，只进了日志' : '发出去了' }
    },
    /** 让她自己想一想再说（走她的人格和记忆）。to 填了就把她的回答发过去。 */
    think: async ({ prompt, to } = {}) => {
      if (!String(prompt || '').trim()) return { ok: false, message: 'prompt 不能空' }
      if (to) { const why = canSend(to); if (why) return { ok: false, message: why } }
      const reply = await hub.runSystemTurn('bridge', '联动', `【系统提醒·来自联动接口】${prompt}\n（只写你要说的话。不想说就输出 [沉默]）`)
      const text = String(reply || '').trim()
      if (to && text && text !== '[沉默]') await hub.deliver(String(to), text)
      return { ok: true, reply: text }
    },
    /** 调某个模块导出的函数：call('memory', 'recall', '香菜')。模块导出了什么看面板「扩展」和 API.md。 */
    call: async ({ module, method, args } = {}) => {
      const m = mods.use(String(module || ''))
      if (!m) return { ok: false, message: `模块「${module}」没在跑` }
      const fn = m[String(method || '')]
      if (typeof fn !== 'function') return { ok: false, message: `模块「${module}」没有 ${method} 这个函数` }
      const r = await fn.apply(m, Array.isArray(args) ? args : args === undefined ? [] : [args])
      return { ok: true, result: safeJson(r) }
    },
    events: ({ after = 0, limit = 100 } = {}) => ({ ok: true, seq, list: events.filter((e) => e.seq > Number(after || 0)).slice(0, Math.min(300, Number(limit) || 100)) }),
  }

  // ---------- 1. 给别的 DSH 插件的服务 ----------
  const service = {
    version, apiVersion,
    ...ops,
    /** 拿某个模块导出的东西（同进程，直接是对象本身）。 */
    use: (id) => mods.use(id),
    modules: () => mods.status(),
    /** 听她这边的事件：'message'（收到）、'reply'（她发出去）、模块 emit 的事件……返回取消函数 */
    on: (event, fn) => mods.listen(event, fn),
    hub,
  }
  try {
    if (typeof ctx.provide === 'function') ctx.provide('aurabot', service)
  } catch (error) {
    log.debug('没能登记 aurabot 服务：', error.message)
  }

  // ---------- 2. 给 DSH 别的会话的全局工具 ----------
  const str = (description) => ({ type: 'string', description })
  function builtinTools() {
    return [
      defineTool({
        name: 'aurabot_qq_send',
        description: '让 QQ 上的「大肥鱼」（Aurabot 插件里的 AI 伙伴）替你发一条 QQ 消息。target 写 private:QQ号 或 group:群号，不填就发给主人。text 是要发的话，可以用 ||| 分多条、<voice>…</voice> 发语音。',
        properties: { target: str('private:QQ号 / group:群号，可不填（发给主人）'), text: str('要发的话') },
        required: ['text'],
        execute: async (args) => ops.send(args),
      }),
      defineTool({
        name: 'aurabot_status',
        description: '看看 QQ 上的「大肥鱼」现在的状态：在不在线、心情、开着哪些模块。',
        execute: async () => ops.info(),
      }),
      defineTool({
        name: 'aurabot_call',
        description: '调用大肥鱼某个模块导出的函数（高级）。比如 module=memory, method=recall, args=["香菜"] 查她的记忆；module=memory, method=add, args=[{"text":"…"}] 让她记住一件事。模块和函数列表用 aurabot_status 看，说明在她的数据目录 modules/API.md。',
        properties: { module: str('模块 id'), method: str('函数名'), args: { type: 'array', items: {}, description: '参数列表' } },
        required: ['module', 'method'],
        execute: async (args) => ops.call(args),
      }),
    ]
  }

  function refresh() {
    for (const off of toolOffs) { try { off() } catch (error) {} }
    toolOffs = []
    toolNames = []
    if (!getConfig().bridge.dshTools) return
    const tools = ctx.get?.('tools')
    if (!tools || typeof tools.register !== 'function') {
      log.warn('DSH 没有提供全局工具注册，联动工具挂不上')
      return
    }
    for (const t of [...builtinTools(), ...mods.dshTools().map(wrapModuleTool)]) {
      try {
        toolOffs.push(tools.register(t))
        toolNames.push(t.name)
      } catch (error) {
        log.warn(`联动工具 ${t.name} 挂不上：`, error.message)
      }
    }
    if (toolNames.length) log.info(`DSH 会话里能用的联动工具：${toolNames.join('、')}`)
  }
  /** 模块用 api.dshTool() 加的工具：允许直接给 defineTool 的参数，也允许给做好的工具。 */
  function wrapModuleTool(t) {
    return t.parameters && t.output ? t : defineTool(t)
  }

  // ---------- 3. 给别的程序的 HTTP 接口 ----------
  function ensureToken() {
    const cfg = getConfig()
    if (cfg.bridge.token) return cfg.bridge.token
    const token = 'ab_' + randomBytes(24).toString('base64url')
    setConfig({ ...cfg, bridge: { ...cfg.bridge, token } })
    return token
  }
  function resetToken() {
    const cfg = getConfig()
    setConfig({ ...cfg, bridge: { ...cfg.bridge, token: '' } })
    return ensureToken()
  }
  function authorized(req) {
    const cfg = getConfig()
    if (!cfg.bridge.http || !cfg.bridge.token) return false
    const h = req.headers || {}
    const auth = String(h.authorization || h.Authorization || '')
    let given = auth.startsWith('Bearer ') ? auth.slice(7).trim() : String(h['x-aurabot-token'] || '')
    if (!given) try { given = new URL(req.url, 'http://x').searchParams.get('token') || '' } catch (error) {}
    const a = Buffer.from(given)
    const b = Buffer.from(cfg.bridge.token)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  // 记事件：收到的消息、她发出去的话
  mods.listen('activity', (a) => {
    if (a.kind === 'in') record('message', { chatId: a.chatId, userId: a.userId, nickname: a.nickname, text: a.text })
    else if (a.kind === 'out') record('reply', { chatId: a.chatId, text: a.reply })
  })
  mods.listen('open/event', (type, data) => record(String(type), data && typeof data === 'object' ? { data } : { data: String(data) }))

  return {
    ops, service, refresh, ensureToken, resetToken, authorized,
    deniedTools: () => toolNames.slice(),
    examples: (base) => examples(base, getConfig().bridge.token),
  }
}

function safeJson(v) {
  try { return JSON.parse(JSON.stringify(v ?? null)) } catch (error) { return String(v) }
}

/** 面板上给的示例（复制就能用）。 */
function examples(base, token) {
  const t = token || '<密钥>'
  return {
    curl: `curl -X POST ${base}/aurabot/api/open/send -H "Authorization: Bearer ${t}" -H "content-type: application/json" -d "{\\"text\\":\\"下班啦\\"}"`,
    powershell: `Invoke-RestMethod -Method Post -Uri ${base}/aurabot/api/open/send -Headers @{Authorization='Bearer ${t}'} -ContentType 'application/json' -Body '{"text":"下班啦"}'`,
    python: `import requests\nrequests.post("${base}/aurabot/api/open/send", headers={"Authorization": "Bearer ${t}"}, json={"text": "下班啦"})`,
    // 不写进 inject：写了就变成「没装 Aurabot 这个插件就不启动」；用的时候再 ctx.get
    plugin: `// 别的 DSH 插件里\nexport function apply(ctx) {\n  // 用的时候再拿（Aurabot 没装 / 没启动时是 undefined）\n  ctx.get('aurabot')?.send({ text: '构建完成啦' })\n}`,
  }
}
