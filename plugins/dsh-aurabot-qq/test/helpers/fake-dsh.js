// 测试用的假 DSH 宿主：只实现 Aurabot 用到的那几样服务。
// 「模型」是个脚本：按用户消息内容决定回什么、调不调工具，用来验证插件的整条链路。

import { randomUUID } from 'node:crypto'

export function createFakeDsh({ brain }) {
  const disposers = []
  const listeners = new Map()
  const routes = new Map()
  const variables = new Map()
  const agents = new Map()
  const workspaces = []
  const turns = [] // 记录每一轮：{ sessionId, preset, userText, images, reply, toolCalls }
  const logs = []

  const emit = (name, ...args) => { for (const fn of listeners.get(name) || []) fn(...args) }

  function makeAgent(sessionId, preset) {
    const tools = new Map()
    const contexts = new Map()
    const events = []
    let turn = 0
    let chain = Promise.resolve()
    const session = {
      id: sessionId,
      append: (type, data) => events.push({ type, data }),
    }
    const agent = {
      id: sessionId,
      preset,
      session,
      tools,
      contexts,
      events,
      denied: new Set(),
      ctx: {
        tools: {
          register: (t) => { tools.set(t.name, t); return () => tools.delete(t.name) },
          restrict: ({ deny = [] }) => { for (const n of deny) agent.denied.add(n); return () => { for (const n of deny) agent.denied.delete(n) } },
        },
        systemPrompt: { context: (c) => { contexts.set(c.name, c); return () => contexts.delete(c.name) } },
      },
      steered: [],
      // 假的 steer：记下来，并当作下一步输入（这里简化成排在当前这一轮之后再跑一轮）
      steer(msg) {
        agent.steered.push(msg)
        return agent.followup(msg)
      },
      followup(msg) {
        chain = chain.then(async () => {
          turn++
          const myTurn = turn
          const text = msg.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
          const images = msg.content.filter((c) => c.type === 'image')
          const ctxText = [...contexts.values()].map((c) => c.text()).filter(Boolean).join('\n')
          const persona = variables.get('aurabot_persona')?.() || ''
          const calls = []
          const callTool = async (name, args) => {
            const t = tools.get(name)
            if (!t) { calls.push({ name, args, result: { ok: false, message: 'no such tool' } }); return null }
            const result = await t.execute(args, { agent })
            calls.push({ name, args, result })
            return result
          }
          const reply = await brain({ preset, text, images, ctxText, persona, callTool, toolNames: [...tools.keys()] })
          turns.push({ sessionId, preset, userText: text, images: images.length, reply, toolCalls: calls, ctxText })
          emit('session/event', session, { type: 'assistant/message', data: { turn: myTurn, message: { content: [{ type: 'text', text: reply }] } } })
          emit('session/event', session, { type: 'turn/end', data: { turn: myTurn, reason: { kind: 'completed' } } })
        })
        return chain
      },
    }
    return agent
  }

  const globalTools = new Map() // 全局工具（DSH 所有会话都能看到）
  const provided = new Map() // ctx.provide 登记的服务
  const ctx = {
    globalTools,
    tools: { register: (t) => { if (globalTools.has(t.name)) throw new Error('dup ' + t.name); globalTools.set(t.name, t); return () => globalTools.delete(t.name) } },
    provide(name, value) { provided.set(name, value); disposers.push(() => provided.delete(name)) },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    effect(fn) {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
    },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(fn)
      return () => listeners.get(name).delete(fn)
    },
    interval(fn, ms) {
      const t = setInterval(fn, ms)
      return () => clearInterval(t)
    },
    systemPrompt: { variable: (n, fn) => { variables.set(n, fn); return () => variables.delete(n) } },
    webServer: { register: (r) => { routes.set(r.path, r); return () => routes.delete(r.path) } },
    workspaceRegistry: {
      archivedSessionIds: [],
      archiveSession(id) { this.archivedSessionIds.push(id) },
      list: () => workspaces,
      async create(path, title) {
        const w = { id: randomUUID(), path, title, sessionIds: [] }
        workspaces.push(w)
        return w
      },
    },
    agents: { get: (id) => agents.get(id) },
    attachments: {
      async admitPromptContent(content) {
        return content.map((c) => (c.type === 'image' ? { type: 'image', attachment: { attachmentId: randomUUID() }, mediaType: c.mediaType } : c))
      },
    },
    llm: {
      listProviders: () => ['fake'],
      async listModels() { return ['fake-1', 'm-pdef', 'm-gdef', 'm-owner', 'm-g777'].map((id) => ({ id, name: id })) },
      async *stream() {
        yield { type: 'text-delta', text: '可爱的小鲸鱼 #开心 #卖萌' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    services: {
      sessionController: {
        async create({ workspaceId, agentPreset }) {
          const id = randomUUID()
          agents.set(id, makeAgent(id, agentPreset))
          workspaces.find((w) => w.id === workspaceId)?.sessionIds.push(id)
          return { sessionId: id, agentPreset }
        },
        async rename() { return {} },
        async resolveAgent(id) {
          const a = agents.get(id)
          return a ? { agent: a } : { error: { code: 'session/not-found', message: 'not found' } }
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake-1' }) },
    },
    get(name) {
      return this.services[name] ?? provided.get(name) ?? this[name]
    },
  }

  async function call(path, body, headers = {}) {
    const full = '/aurabot/api' + path.split('?')[0]
    // 先精确匹配，再找最长的前缀路由（和 DSH 的网页服务一样）
    const r = routes.get(full) || [...routes.values()].filter((x) => x.kind === 'prefix' && (full === x.path || full.startsWith(x.path + '/'))).sort((a, b) => b.path.length - a.path.length)[0]
    if (!r) throw new Error('no route ' + path)
    let out = ''
    let status = 200
    const req = {
      url: '/aurabot/api' + path,
      headers,
      async *[Symbol.asyncIterator]() { if (body) yield JSON.stringify(body) },
    }
    const res = { set statusCode(v) { status = v }, setHeader() {}, end(s) { out = s } }
    await r.handler(req, res)
    return { status, raw: () => out, json: () => JSON.parse(out) }
  }

  return { ctx, routes, variables, agents, workspaces, turns, logs, call, dispose: () => disposers.reverse().forEach((d) => { try { d() } catch (e) {} }) }
}
