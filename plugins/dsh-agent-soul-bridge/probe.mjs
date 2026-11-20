/**
 * probe.mjs —— 不启动 DSH 也能验的宿主端探针。
 *
 * ★ 为什么需要它：插件的宿主半只在 **DSH 进程启动时**加载（profile 的 bundles 是启动时组装的），
 *   而「重启 DSH」会打断所有正在跑的会话。所以先把能验的全验掉，剩下真正需要重启的那一条再交给
 *   人来定时间点 —— 别拿「重启一下试试」当调试手段。
 *
 * 三种模式：
 *   node probe.mjs fake     ← 用 agent-soul 真实的服务端代码（src/control/ws.mjs + hub.mjs）
 *                              在本地起一个「假 v4」，验：hello / welcome / exec→result /
 *                              followup 真的调到 agent / 桩回 ok:false / 掉线重连
 *   node probe.mjs live     ← 连真实的 ws://127.0.0.1:7310/control，只验握手 + hello
 *   node probe.mjs backoff  ← 指向一个没人听的端口，验退避序列 1s → 2s → 4s → 8s
 *
 * 它 import 的是**本插件自己的 index.js**，不是复制一份逻辑 —— 验的就是要装进去的那份代码。
 * 读 agent-soul 的源码（只读，不改）：那是协议的真实实现，对着它验比对着文档验硬。
 */

import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const SOUL_CONTROL = 'D:/AI/agent-soul/src/control'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const T0 = Date.now()
const ts = () => '(' + String(Date.now() - T0).padStart(5) + 'ms)'

let PASS = 0
let FAIL = 0
function check (ok, label, extra) {
  if (ok) { PASS++; console.log('  ✔ ' + label + (extra ? '  — ' + extra : '')) }
  else { FAIL++; console.log('  ✘ ' + label + (extra ? '  — ' + extra : '')) }
}

/** 一个够用的 Cordis ctx 桩：只提供本插件软取的那几个服务 */
function makeCtx (opts = {}) {
  const followupCalls = []
  const fakeAgent = {
    id: 'session-fake-0001',
    session: { id: opts.sessionId || 'fake0001-1111-2222-3333' },
    followup (msg) { followupCalls.push(msg) },
  }
  const services = {
    agents: {
      roots: () => (opts.noAgents ? [] : [fakeAgent]),
      get: (id) => (String(id) === String(fakeAgent.id) ? fakeAgent : null),
    },
  }
  if (!opts.noWatermark) {
    services.sessionProjections = {
      snapshot: () => ({
        values: {
          contextPressure: {
            projectedTokens: opts.projectedTokens ?? 482000,
            pressureTokens: 481000,
            contextWindow: 1048576,
          },
        },
      }),
    }
  }
  const promptContexts = []
  const ctx = {
    get: (n) => services[n],
    inject: (names, fn) => { fn({ systemPrompt: { context: (c) => promptContexts.push(c) } }) },
    effect: (fn) => { const d = fn(); return d },
  }
  return { ctx, fakeAgent, followupCalls, promptContexts, services }
}

async function loadPlugin () {
  const mod = await import(pathToFileURL(path.join(HERE, 'index.js')).href)
  return mod
}

// ───────────────────────── fake 模式 ─────────────────────────
async function runFake () {
  const { accept } = await import(pathToFileURL(path.join(SOUL_CONTROL, 'ws.mjs')).href)
  const { ControlHub } = await import(pathToFileURL(path.join(SOUL_CONTROL, 'hub.mjs')).href)

  const PORT = 17310
  const hubLogs = []
  const hub = new ControlHub({ log: (m) => { hubLogs.push(m); console.log('  [v4] ' + m) } })

  let server = null
  const conns = []
  const inbound = []
  function startServer () {
    return new Promise((resolve) => {
      server = http.createServer((req, res) => { res.writeHead(404); res.end('not found') })
      server.on('upgrade', (req, socket) => {
        const conn = accept(req, socket)
        if (!conn) return
        conns.push(conn)
        hub.attach(conn)
        // ★ 顺手把客户端发上来的原文留一份 —— 断言要打在「它到底说了什么」上，
        //   而不是打在 hub 消化完之后剩下的东西上（hub 的 snapshot 不暴露 meta）。
        const prev = conn.onmessage
        conn.onmessage = (raw) => { inbound.push(raw); if (prev) prev(raw) }
      })
      server.listen(PORT, '127.0.0.1', () => resolve())
    })
  }
  async function stopServer () {
    for (const c of conns) { try { c.close() } catch {} }
    conns.length = 0
    await new Promise((r) => server ? server.close(() => r()) : r())
    server = null
  }

  await startServer()
  const { ctx, followupCalls, promptContexts } = makeCtx()
  const { apply } = await loadPlugin()
  apply(ctx, { url: 'ws://127.0.0.1:' + PORT + '/control', pingMs: 0, statePerTurn: true, stateMinGapMs: 0 })

  await sleep(900)
  const hosts = hub.snapshot()
  check(hosts.length === 1, 'v4 侧收到一条 host', JSON.stringify({ id: hosts[0]?.id, host: hosts[0]?.host, caps: hosts[0]?.caps }))
  check(hosts[0] && hosts[0].host === 'dsh', 'hello 报的 host 是 dsh', String(hosts[0]?.host))
  check(hubLogs.some((l) => l.indexOf('hello: dsh') >= 0), '服务端日志里出现 hello: dsh 能力=[...]', hubLogs.find((l) => l.indexOf('hello:') >= 0))
  const helloMsg = (() => { try { return JSON.parse(inbound.find((x) => String(x).indexOf('"hello"') >= 0) || 'null') } catch { return null } })()
  check(!!helloMsg, '客户端第一条就是 hello', JSON.stringify(helloMsg && { type: helloMsg.type, host: helloMsg.host, caps: helloMsg.caps }))
  check(helloMsg && helloMsg.meta && helloMsg.meta.contextTokens === 482000, 'hello.meta 带上了真水位（482000）', JSON.stringify(helloMsg && helloMsg.meta))
  check(helloMsg && helloMsg.meta && Array.isArray(helloMsg.meta.stubs) && helloMsg.meta.stubs.length === 2, 'hello.meta 主动声明了两个桩', JSON.stringify(helloMsg && helloMsg.meta && helloMsg.meta.stubs))

  // —— exec: followup/say
  try {
    const data = await hub.exec(hosts[0].id, 'followup', 'say', { text: '该说话了（probe）' })
    check(followupCalls.length === 1, 'followup 真的调到了 agent.followup', '回执=' + JSON.stringify(data))
    const msg = followupCalls[0] || {}
    check(msg.role === 'user' && Array.isArray(msg.content) && msg.content[0] && msg.content[0].type === 'text',
      'followup 的消息形状对（role/content[{type:text}]）', JSON.stringify(msg).slice(0, 160))
    check(msg.content && msg.content[0] && msg.content[0].text === '该说话了（probe）', '正文原样送达', msg.content && msg.content[0]?.text)
    check(!!(msg.source && msg.source.kind), 'source.kind 带上了（可追溯）', JSON.stringify(msg.source))
  } catch (e) {
    check(false, 'followup/say 回执', String(e && e.message))
  }

  // —— exec: 桩
  // ★ 2026-11-09 修断言：这两条原本只接受桥接自己回的「未实现」。
  //   但 hub.mjs:92-103 已经按「桩提前拒绝」在**派活前** reject（e.hint='stub_declared'）——
  //   那是更好的行为（秒级 vs 15 秒超时），且桥接侧的桩分支因此在真 v4 下不可达。
  //   所以断言改成：**两条路都算过**，验的是「派到桩一定被拒且理由清楚」，
  //   而不是「一定由桥接拒」。桥接分支仍保留，作为 hub 未拦时的兜底。
  try {
    await hub.exec(hosts[0].id, 'huanqi', 'break-turn', {})
    check(false, 'huanqi 应该回 ok:false，实际成功了')
  } catch (e) {
    check(e && (e.hint === 'stub_declared' || /未实现/.test(String(e.message))), 'huanqi 桩在派活前就被拒（秒级，不是等 15 秒超时）', String(e && e.message) + '  [hint=' + String(e && e.hint) + ']')
  }
  try {
    await hub.exec(hosts[0].id, 'pruner', 'prune', {})
    check(false, 'pruner 应该回 ok:false，实际成功了')
  } catch (e) {
    check(e && (e.hint === 'stub_declared' || /未实现/.test(String(e.message))), 'pruner 桩在派活前就被拒（秒级，不是等 15 秒超时）', String(e && e.message) + '  [hint=' + String(e && e.hint) + ']')
  }

  // —— 每轮上报：借 systemPrompt 的 render 当钩子
  const promptCtx = promptContexts[0]
  check(!!promptCtx, '每轮钩子装上了（systemPrompt.context）')
  if (promptCtx) {
    const before = hub.snapshot()[0].state
    const txt = promptCtx.text({ agent: { session: { id: 'fake0001-1111-2222-3333' } } })
    check(txt === '', '钩子返回空串（不往提示里塞字）', JSON.stringify(txt))
    await sleep(80)
    const after = hub.snapshot()[0].state
    check(!!after && String(after.turnId) !== String(before && before.turnId), 'state 每轮上报了（turnId 变了）', String(after && after.turnId) + ' ctx=' + String(after && after.contextTokens))
  }

  // —— 断线重连
  await stopServer()
  console.log('  … 服务端已停，等它自己退避重连')
  await sleep(2600)             // 第一次重试在 1s，第二次在 2s
  await startServer()
  await sleep(4200)
  const after = hub.snapshot()
  check(after.length === 1 && after[0].host === 'dsh', '断线后自己重连回来了', 'id=' + String(after[0]?.id))
  const helloCount = hubLogs.filter((l) => l.indexOf('hello: dsh') >= 0).length
  check(helloCount >= 2, '重连后重新发了一次 hello', '共 ' + helloCount + ' 次')

  console.log('')
  console.log('  服务端日志全文（v4 那边会看到的东西）：')
  for (const l of hubLogs) console.log('    [控制] ' + l)
  await stopServer()
  await sleep(200)
  return
}

// ───────────────────────── live 模式 ─────────────────────────
async function runLive () {
  const { ctx } = makeCtx({ noWatermark: true })
  const { apply } = await loadPlugin()
  apply(ctx, { url: 'ws://127.0.0.1:7310/control', pingMs: 0, statePerTurn: false, log: true })
  await sleep(1500)
  const bridge = ctx.__agentSoulBridge
  check(!bridge, '（ctx 桩上拿不到内部状态是正常的，只看日志与连接）')
  return
}

// ───────────────────────── backoff 模式 ─────────────────────────
async function runBackoff () {
  const { ctx } = makeCtx({ noWatermark: true })
  const { apply } = await loadPlugin()
  // 17311 上什么都不听 —— 观察退避序列
  apply(ctx, { url: 'ws://127.0.0.1:17311/control', pingMs: 0, statePerTurn: false })
  const seen = []
  const orig = console.warn
  console.warn = (...a) => { seen.push(ts() + ' ' + a.join(' ')); orig.apply(console, a) }
  await sleep(15500)
  console.warn = orig
  check(seen.length >= 1, '失败时说了一句人话（不是每轮刷）', seen.length + ' 条 warn')
  check(seen.length <= 4, '15.5 秒里 warn 不超过 4 条（1s+2s+4s+8s 只重试 4 次）', String(seen.length))
  return
}

const mode = process.argv[2] || 'fake'
console.log('=== probe: ' + mode + ' ===')
try {
  if (mode === 'fake') await runFake()
  else if (mode === 'live') await runLive()
  else if (mode === 'backoff') await runBackoff()
  else { console.log('未知模式：' + mode); process.exitCode = 2 }
} catch (e) {
  FAIL++
  console.log('✘ 探针自己炸了：' + String((e && e.stack) || e))
}
console.log('')
console.log('结果：PASS ' + PASS + ' / FAIL ' + FAIL)
process.exit(FAIL ? 1 : 0)
