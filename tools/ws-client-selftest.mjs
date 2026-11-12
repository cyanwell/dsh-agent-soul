/**
 * ws-client 自检 —— 对着 **v4 真的服务端代码** 跑，不是对着文档跑。
 *
 *   node tools/ws-client-selftest.mjs
 *
 * 起一个临时 server，直接复用 src/control/ws.mjs（握手 + 帧解析）和
 * src/control/hub.mjs（注册表 + exec），客户端用 src/control/ws-client.mjs。
 * 两边都是**生产代码**，所以这里验的是真协议，不是模拟。
 *
 * 覆盖 10 项：握手 / 校验 accept / hello / 收到 exec / 回执(data) / 回执(error) /
 *             回执(hint) / hint 封闭集合 / state 上报 / 掉线重连
 */

import http from 'node:http'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const load = (rel) => import(new URL('file:///' + path.join(ROOT, rel).replace(/\\/g, '/')).href)

const { accept } = await load('src/control/ws.mjs')
const { ControlHub } = await load('src/control/hub.mjs')
const { connect, ExecRefused, HINTS } = await load('src/control/ws-client.mjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const T0 = Date.now()
const ts = () => '(' + String(Date.now() - T0).padStart(5) + 'ms)'

let pass = 0
let fail = 0
function check (ok, label, extra) {
  if (ok) { pass++; console.log('  \u2714 ' + label + (extra ? '  \u2014 ' + extra : '')) }
  else { fail++; console.log('  \u2718 ' + label + (extra ? '  \u2014 ' + extra : '')) }
}

const PORT = 17320
const ROGUE_PORT = 17321

// ── 一个真的控制通道服务端（= v4 那一侧） ─────────────────────
function makeServer (port) {
  const logs = []
  const inbound = []
  const hub = new ControlHub({ log: (m) => { logs.push(m); console.log('  [v4] ' + m) } })
  const conns = []
  let server = null
  return {
    hub,
    logs,
    inbound,
    async start () {
      return new Promise((resolve) => {
        server = http.createServer((req, res) => { res.writeHead(404); res.end('not found') })
        server.on('upgrade', (req, socket) => {
          const conn = accept(req, socket)
          if (!conn) return
          conns.push(conn)
          hub.attach(conn)
          // 留原始帧：断言要打在「对端到底说了什么」上，而不是打在 hub 消化完的结果上
          // （hub 的 snapshot 不暴露 hello.meta，也不保留 result.hint）
          const prev = conn.onmessage
          conn.onmessage = (raw) => {
            try { inbound.push(JSON.parse(raw)) } catch { inbound.push({ raw }) }
            if (prev) prev(raw)
          }
        })
        server.listen(port, '127.0.0.1', () => resolve())
      })
    },
    async stop () {
      for (const c of conns) { try { c.close() } catch { /* */ } }
      conns.length = 0
      await new Promise((r) => (server ? server.close(() => r()) : r()))
      server = null
    },
    framesOf (type) { return inbound.filter((m) => m && m.type === type) },
  }
}

// ── 1~2 / 4~8 / 9：假装客户端跑一遍全部协议 ────────────────────
const good = makeServer(PORT)
await good.start()

const seen = []
const client = connect({
  url: 'ws://127.0.0.1:' + PORT + '/control',
  host: 'selftest',
  caps: ['echo', 'wired', 'stub', 'flaky', 'other'],
  meta: { pid: process.pid, stubs: ['stub'] },
  pingMs: 0,
  log: (m) => console.log('  [client] ' + m),
  warn: (m) => console.log('  [client][warn] ' + m),
  onExec (cmd) {
    seen.push(cmd.cap + '/' + cmd.action)
    if (cmd.cap === 'echo') return { got: cmd.args && cmd.args.text }
    if (cmd.cap === 'wired') throw new Error('参数不对（普通 Error，不该带 hint）')
    if (cmd.cap === 'flaky') throw new ExecRefused('未实现：要 hook 才能截断', HINTS.NOT_WIRED)
    // 未登记的 hint 必须被过滤掉，不许它变成第二个 error 字符串
    const e = new Error('hint 乱填'); e.hint = '我乱写的'; throw e
  },
})

await sleep(700)

// ① 握手
const hosts = good.hub.snapshot()
check(hosts.length === 1, '\u2460 握手成功：服务端注册表里有 1 条 host', JSON.stringify({ id: hosts[0]?.id, host: hosts[0]?.host }))

// ② hello
const hello = good.framesOf('hello')[0]
check(!!hello && hello.host === 'selftest', '\u2461 hello 发得对（host 名）', JSON.stringify(hello && { type: hello.type, host: hello.host, caps: hello.caps }))
check(!!hello && Array.isArray(hello.meta && hello.meta.stubs) && hello.meta.stubs[0] === 'stub', '\u2462 hello.meta 原样带到（stubs 声明）', JSON.stringify(hello && hello.meta))
check(!!(hello && hello.meta && hello.meta.pid), '\u2463 meta 里的运行时信息带上了', String(hello && hello.meta && hello.meta.pid))

// ④ exec → 回执
try {
  const data = await good.hub.exec(hosts[0].id, 'echo', 'say', { text: 'ping' })
  check(!!data && data.got === 'ping', '\u2464 收到 exec 并回了 ok:true（data 原样传回）', JSON.stringify(data))
} catch (e) {
  check(false, '\u2464 收到 exec 并回了 ok:true', String(e && e.message))
}

// ⑤~⑦ 三条异常路径：按「回执内容」找帧，不依赖到达顺序 / id
const rejects = []
async function execExpectFail (cap, action) {
  try {
    await good.hub.exec(hosts[0].id, cap, action, {})
    return ''
  } catch (e) { return String(e && e.message) }
}
const whyWired = await execExpectFail('wired', 'say')
const whyStub = await execExpectFail('stub', 'break-turn')   // 这个在 hello.meta.stubs 里 → 服务端会自己拦掉
const whyFlaky = await execExpectFail('flaky', 'break-turn') // 这个没声明是桩 → 真会走到客户端
const whyOther = await execExpectFail('other', 'x')
await sleep(120)
const fails = good.framesOf('result').filter((r) => r.ok === false)

const fWired = fails.find((r) => /参数不对/.test(String(r.error)))
check(!!fWired && fWired.hint === undefined, '\u2465 普通异常回 ok:false 且不带 hint', JSON.stringify(fWired) + ' ｜hub 侧拒绝原因=' + JSON.stringify(whyWired))

const fFlaky = fails.find((r) => /未实现/.test(String(r.error)))
check(!!fFlaky && fFlaky.hint === 'capability_not_wired', '\u2466 桩回执带 hint=capability_not_wired', JSON.stringify(fFlaky) + ' ｜hub 侧拒绝原因=' + JSON.stringify(whyFlaky))

// ⑥b 声明成桩的能力，服务端**在派活前就拦了**（canDo 生效，exec 帧根本没发出去）
check(!!whyStub && /桩/.test(whyStub), '\u2466b hub 按 canDo 在派活前就拒了已声明的桩', String(whyStub).slice(0, 80))

const fOther = fails.find((r) => /hint 乱填/.test(String(r.error)))
check(!!fOther && fOther.hint === undefined, '\u2467 未登记的 hint 被过滤（封闭集合生效）', JSON.stringify(fOther) + ' ｜hub 侧拒绝原因=' + JSON.stringify(whyOther))

// ⑧ 每条 exec 都有回执 —— 性质是「onExec 次数 == result 条数」，一条都不吞
const resultCount = good.framesOf('result').length
check(seen.length === 4 && resultCount === 4, '\u2468 4 次 onExec 对应 4 条回执（一条都不吞）', seen.length + ' 次 onExec / ' + resultCount + ' 条回执 ｜seen=' + JSON.stringify(seen))

// ⑨ state
client.state({ contextTokens: 482000, contextWindow: 1048576, turnId: 't-1' })
await sleep(120)
const st = good.hub.snapshot()[0] && good.hub.snapshot()[0].state
check(!!st && st.contextTokens === 482000, '\u2469 state 上报到了（contextTokens）', JSON.stringify(st))

// ⑩ 掉线重连（服务端停 → 起，客户端应自己回来并**重发 hello**）
const beforeHello = good.framesOf('hello').length
await good.stop()
console.log('  \u2026 服务端已停，等它自己退避重连')
await sleep(2600)
await good.start()
await sleep(4200)
const after = good.hub.snapshot()
check(after.length === 1 && after[0].host === 'selftest', '\u246A 掉线后自己重连回来了', 'id=' + String(after[0]?.id))
check(good.framesOf('hello').length > beforeHello, '\u246B 重连后重新发了一次 hello', beforeHello + ' \u2192 ' + good.framesOf('hello').length)

client.close()
await good.stop()

// ── 3：恶意/半吊子服务端回错的 Sec-WebSocket-Accept → 客户端必须拒 ──
const rogue = http.createServer((req, res) => { res.writeHead(404); res.end() })
const rogueSockets = []
rogue.on('upgrade', (req, socket) => {
  rogueSockets.push(socket)
  // 故意给一个错的 accept（真正该是 SHA1(key+GUID)）
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=' + '\r\n\r\n'
  )
  // ★ 收尾要自己断：不 destroy 的话 server.close() 会一直等这条连接，自检就挂在那儿了
  setTimeout(() => { try { socket.destroy() } catch { /* */ } }, 50)
})
await new Promise((r) => rogue.listen(ROGUE_PORT, '127.0.0.1', () => r()))

let opened = false
let errMsg = ''
const bad = connect({
  url: 'ws://127.0.0.1:' + ROGUE_PORT + '/control',
  host: 'nope',
  caps: [],
  autoReconnect: false,
  pingMs: 0,
  log: () => {},
  warn: (m) => { errMsg = errMsg || m },
  onError: (e) => { errMsg = errMsg || String((e && e.message) || e) },
  onOpen: () => { opened = true },
})
await sleep(600)
check(opened === false, '\u246C accept 不匹配时不认这条连接（onOpen 从未触发）')
check(/accept/i.test(errMsg), '\u246D 而且报错说清了是 accept 不匹配', errMsg.slice(0, 90))
bad.close()
for (const s of rogueSockets) { try { s.destroy() } catch { /* */ } }
await Promise.race([
  new Promise((r) => rogue.close(() => r())),
  sleep(800), // 兜底：close 等不到也不许把自检吊死
])

// ── 11：退回「退避序列」的那条日志纪律（空端口） ──
const warns = []
const dead = connect({
  url: 'ws://127.0.0.1:17322/control',
  host: 'dead',
  caps: [],
  pingMs: 0,
  log: () => {},
  warn: (m) => { warns.push(m) },
})
await sleep(15500)
dead.close()
check(warns.length >= 1 && warns.length <= 4, '\u246E 15.5 秒里 warn 不超过 4 条（重试不刷屏）', String(warns.length))
check(/退避/.test(warns[0] || ''), '\u246F 第一次失败就说清了「开始退避、上限多少」', String(warns[0] || '').slice(0, 80))

console.log('')
console.log('结果：PASS ' + pass + ' / FAIL ' + fail)
process.exit(fail ? 1 : 0)
