/**
 * 控制通道 —— 宿主端 WebSocket 客户端（零第三方依赖）
 *
 * 谁用它：任何要接 v4 控制通道、主动接收指令的宿主 —— DSH、Codex、Claude Code、huanqi 自己。
 * **都 import 这一份，不要各抄一遍。**
 *
 * ── 它替你做完的三件事 ──────────────────────────────────────────────
 *   ① 握手：按 RFC 6455 发 Upgrade，**并校验 Sec-WebSocket-Accept**（只发不验 = 没验）
 *   ② 协议：连上第一件事发 hello 自报能力；收到 exec 就交给你的 onExec，**并保证回执必达**
 *   ③ 韧性：掉线指数退避重连（1s → 2s → 4s → … → 30s），回来以后**自动重发 hello**
 *
 * ── 三条从真机上读出来、写死在代码里的硬事实 ────────────────────────
 *   ① **客户端发的帧必须 mask**（对端逐字节 XOR 解），服务端发回来的帧**不带 mask**。
 *   ② 掉线时**先到的是 end（FIN）**，close 可能晚到甚至不到。
 *      只监听 close 的客户端会「看起来连着，其实早就死了」——所以 end / close / error 三个全接。
 *      这一条服务端自己也踩过（src/control/ws.mjs 里有同一段注释）。
 *   ③ 回执是硬要求：对端 exec 之后等 15 秒，**没回执就判超时**。
 *      所以本模块把「回执」这件事从你手里拿走 —— 你的 onExec 只需要 return 或 throw。
 *
 * ── 你对 exec 的两种回答 ────────────────────────────────────────────
 *   return 任意 JSON       → 发 { type:'result', ok:true, data:... }
 *   throw  ExecRefused(…)  → 发 { type:'result', ok:false, error:..., hint:'…' }
 *   throw  其它 Error      → 发 { type:'result', ok:false, error:... }
 *   **抛什么都不会静默**：异常路径一样有回执。
 *
 * ── 最小用法 ───────────────────────────────────────────────────────
 *   import { connect, ExecRefused, HINTS } from './ws-client.mjs'
 *   const client = connect({
 *     url: 'ws://127.0.0.1:7310/control',
 *     host: 'huanqi',
 *     caps: ['huanqi'],
 *     meta: { pid: process.pid, stubs: [] },
 *     onExec (cmd) {
 *       if (cmd.cap === 'huanqi' && cmd.action === 'break-turn') return breakTurn(cmd.args)
 *       throw new ExecRefused('不认识的能力：' + cmd.cap, HINTS.MISSING)
 *     },
 *   })
 *   client.state({ contextTokens: 482000, contextWindow: 1048576, turnId: 't-7' })
 *
 * ★ 本文件的原型是 D:\AI\dsh-tools\dsh-agent-soul-bridge\ws.js（DSH 插件那份，自包含、不跨仓库 import）。
 *   两份是同一套事实的两面：插件那份只做传输，这份多了 hello/回执/重连的协议层。改动请两边对照。
 */

import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_FRAME = 8 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 15000

/**
 * 回执里 hint 的取值 —— **封闭集合，不许长成自由文本**。
 *
 * ★ 为什么要有它：对端看到一个 ok:false，需要能程序化地分清两件事 ——
 *   「这条能力我根本没有」和「能力在、但路还没通」。前者的正确反应是**永远不再派**，
 *   后者是**下次还可以试**。光靠 error 里那句人话，对端只能猜。
 *
 * ★ 为什么是封闭集合：hint 一旦能随便填，它就退化成第二个 error 字符串 ——
 *   对端还是得靠人读，那等于没加。
 */
export const HINTS = Object.freeze({
  /** 能力在、路没通（例如 huanqi 还没接到 exec 口）。**现在别试，以后还会通** */
  NOT_WIRED: 'capability_not_wired',
  /** 我根本没有这个能力。**别再派它** */
  MISSING: 'capability_missing',
  /** 参数不对。**别重试，先改参数** */
  BAD_ARGS: 'bad_args',
  /** 临时失败（忙 / 网络 / 正在跑别的）。**可以重试** */
  TRANSIENT: 'transient',
})

const HINT_SET = new Set(Object.values(HINTS))

/** 带 hint 的拒绝 —— onExec 里 throw 它，回执就会带上 hint 字段 */
export class ExecRefused extends Error {
  constructor (message, hint = HINTS.NOT_WIRED) {
    super(String(message))
    this.name = 'ExecRefused'
    this.hint = HINT_SET.has(hint) ? hint : HINTS.NOT_WIRED
  }
}

// ─────────────────────────── 帧编解码（RFC 6455 子集） ───────────────────────────

function encodeFrame (opcode, payload) {
  const len = payload.length
  const mask = crypto.randomBytes(4)
  let head
  if (len < 126) {
    head = Buffer.allocUnsafe(2)
    head[1] = 0x80 | len
  } else if (len < 65536) {
    head = Buffer.allocUnsafe(4)
    head[1] = 0x80 | 126
    head.writeUInt16BE(len, 2)
  } else {
    head = Buffer.allocUnsafe(10)
    head[1] = 0x80 | 127
    head.writeUInt32BE(0, 2)
    head.writeUInt32BE(len, 6)
  }
  head[0] = 0x80 | opcode // FIN=1；★ 客户端发出的帧一律带 mask 位（下面 body 异或）
  const body = Buffer.allocUnsafe(len)
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3]
  return Buffer.concat([head, mask, body])
}

/**
 * 低层连接：只负责「握手 + 收发帧 + 掉线告诉我」。
 * 协议层（hello / 回执 / 重连）在下面的 connect() 里。
 */
function open ({ url, handlers = {} }) {
  const u = new URL(url)
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new Error('只支持 ws:// 或 wss://，收到：' + url)
  const mod = u.protocol === 'wss:' ? https : http
  const key = crypto.randomBytes(16).toString('base64')
  const expect = crypto.createHash('sha1').update(key + GUID).digest('base64')

  let socket = null
  let closed = false
  let buf = Buffer.alloc(0)
  let fragOpcode = 0
  let fragChunks = []
  let upgraded = false

  const api = {
    get open () { return !!socket && !closed && !socket.destroyed },
    sendRaw (opcode, data) { return frame(opcode, data) },
    sendJson (obj) { return frame(0x1, Buffer.from(JSON.stringify(obj), 'utf8')) },
    ping () { return frame(0x9, Buffer.alloc(0)) },
    close () {
      if (closed) return
      const p = Buffer.alloc(2)
      p.writeUInt16BE(1000, 0)
      frame(0x8, p)
      finish('本地主动关闭')
    },
  }

  function finish (reason) {
    if (closed) return
    closed = true
    try { if (socket) socket.destroy() } catch { /* 已经死了 */ }
    try { handlers.onclose && handlers.onclose(reason) } catch { /* 回调不许炸 */ }
  }

  function frame (opcode, data) {
    if (!socket || socket.destroyed) return false
    try {
      socket.write(encodeFrame(opcode, data))
      return true
    } catch (e) {
      finish('写失败：' + String((e && e.message) || e))
      return false
    }
  }

  function drain () {
    while (!closed) {
      if (buf.length < 2) return
      const b0 = buf[0]
      const b1 = buf[1]
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let len = b1 & 0x7f
      let off = 2
      if (len === 126) {
        if (buf.length < 4) return
        len = buf.readUInt16BE(2); off = 4
      } else if (len === 127) {
        if (buf.length < 10) return
        const hi = buf.readUInt32BE(2); const lo = buf.readUInt32BE(6)
        len = hi * 2 ** 32 + lo; off = 10
      }
      if (len > MAX_FRAME) { finish('对端帧过大：' + len); return }
      const maskLen = masked ? 4 : 0
      if (buf.length < off + maskLen + len) return

      let payload = buf.subarray(off + maskLen, off + maskLen + len)
      if (masked) {
        const mk = buf.subarray(off, off + 4)
        const out = Buffer.allocUnsafe(len)
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mk[i & 3]
        payload = out
      }
      buf = buf.subarray(off + maskLen + len)

      if (opcode === 0x8) { finish('对端发来 close 帧'); return }
      if (opcode === 0x9) { frame(0xa, payload); continue }
      if (opcode === 0xa) { try { handlers.onpong && handlers.onpong() } catch { /* */ } ; continue }
      if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) {
        if (opcode !== 0x0) { fragOpcode = opcode; fragChunks = [] }
        fragChunks.push(Buffer.from(payload))
        if (!fin) continue // 分片还没收齐
        const all = Buffer.concat(fragChunks)
        fragChunks = []
        if (fragOpcode === 0x1) {
          try { handlers.onmessage && handlers.onmessage(all.toString('utf8')) } catch { /* */ }
        }
        continue
      }
      // 其它 opcode（二进制/保留）这条通道用不上，静默忽略
    }
  }

  const req = mod.request({
    host: u.hostname,
    port: u.port || (u.protocol === 'wss:' ? 443 : 80),
    path: (u.pathname || '/') + (u.search || ''),
    method: 'GET',
    headers: {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
    },
  })

  req.on('upgrade', (res, sock, head) => {
    upgraded = true
    // ★ 必须校验：只发 key 不看 accept，等于没验对方身份（中间人可以随便伪造 101）
    const got = String(res.headers['sec-websocket-accept'] || '')
    if (got !== expect) {
      try { sock.destroy() } catch { /* */ }
      try { handlers.onerror && handlers.onerror(new Error('握手校验失败：Sec-WebSocket-Accept 不匹配（期望 ' + expect + '，收到 ' + got + '）')) } catch { /* */ }
      finish('握手校验失败')
      return
    }
    socket = sock
    try { socket.setNoDelay(true) } catch { /* 老平台没有 */ }
    if (head && head.length) { buf = Buffer.concat([buf, head]); drain() }
    socket.on('data', (d) => { buf = Buffer.concat([buf, d]); drain() })
    // ★★ 三个事件全接 —— 少一个就会出现「看着连着、其实死了」
    socket.on('end', () => finish('对端关闭（FIN）'))
    socket.on('close', () => finish('socket close'))
    socket.on('error', (e) => {
      try { handlers.onerror && handlers.onerror(e) } catch { /* */ }
      finish('socket error：' + String((e && e.message) || e))
    })
    try { handlers.onopen && handlers.onopen() } catch { /* */ }
  })

  req.on('response', (res) => {
    // 没升级（比如路径写错回 404）—— 干净地失败，别卡住
    try { handlers.onerror && handlers.onerror(new Error('服务端没有升级到 WebSocket（HTTP ' + res.statusCode + '）')) } catch { /* */ }
    try { req.destroy() } catch { /* */ }
    finish('非 101 响应（HTTP ' + res.statusCode + '）')
  })

  req.on('error', (e) => {
    if (!upgraded) {
      try { handlers.onerror && handlers.onerror(e) } catch { /* */ }
    }
    finish('连接失败：' + String((e && (e.code || e.message)) || e))
  })

  req.end()
  return api
}

// ─────────────────────────── 协议层 ───────────────────────────

function fmtMs (ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?'
  if (ms < 1000) return Math.round(ms) + 'ms'
  if (ms < 60000) return (ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1) + 's'
  return Math.round(ms / 60000) + 'min'
}

/**
 * 连一条控制通道，并把「重连 / 重发 hello / exec 回执」全包掉。
 * @param {object} options
 * @returns {object} client
 */
export function connect (options = {}) {
  const cfg = {
    url: 'ws://127.0.0.1:7310/control',
    host: 'unknown',
    caps: [],
    meta: {},
    onExec: null,
    onWelcome: null,
    onState: null,      // ★ 只是「我发了一条 state」的回显钩子；入站帧只有 welcome / exec 两种
    onOpen: null,
    onClose: null,
    onError: null,
    log: (m) => console.log(m),
    warn: (m) => console.warn(m),
    pingMs: 25000,
    autoReconnect: true,
    reconnect: { min: 1000, max: 30000, factor: 2 },
    execTimeoutMs: DEFAULT_TIMEOUT_MS,
    ...options,
  }
  const rc = { min: 1000, max: 30000, factor: 2, ...(cfg.reconnect || {}) }

  const st = {
    ws: null,
    connected: false,
    helloed: false,
    hostId: '',
    attempts: 0,
    delay: rc.min,
    downSince: 0,
    loggedCap: false,
    retryTimer: null,
    pingTimer: null,
    stopped: false,
    sent: 0,
    received: 0,
    lastError: null,
  }

  const log = (m) => { try { cfg.log(m) } catch { /* */ } }
  const warn = (m) => { try { cfg.warn(m) } catch { /* */ } }

  function metaNow () {
    try {
      const m = typeof cfg.meta === 'function' ? cfg.meta() : cfg.meta
      return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {}
    } catch { return {} }
  }

  function send (obj) {
    if (!st.ws || !st.connected) return false
    const ok = st.ws.sendJson(obj)
    if (ok) st.sent += 1
    return ok
  }

  // ── 回执：这一层保证「抛什么都有回执」 ──────────────────────────
  function buildResult (id, ok, payload) {
    if (ok) return { type: 'result', id, ok: true, data: payload === undefined ? null : payload }
    const err = payload
    const msg = String((err && err.message) || err)
    const hint = err && typeof err === 'object' && HINT_SET.has(err.hint) ? err.hint : undefined
    const out = { type: 'result', id, ok: false, error: msg }
    if (hint) out.hint = hint // ★ 只有登记过的 hint 才发出去，不让它长成第二个 error
    return out
  }

  function replyResult (id, ok, payload) {
    if (!id) { warn('收到一条没有 id 的 exec，无法回执（协议要求必须有 id）'); return false }
    return send(buildResult(id, ok, payload))
  }

  // ── 入站 ────────────────────────────────────────────────────
  function onMessage (raw) {
    st.received += 1
    let m
    try { m = JSON.parse(raw) } catch { warn('收到非 JSON 帧，已忽略'); return }
    if (!m || typeof m !== 'object') return

    if (m.type === 'welcome') {
      st.hostId = String(m.id || '')
      log('v4 认了我：id=' + st.hostId + ' you=' + String(m.you || '?') + ' caps=[' + (Array.isArray(m.caps) ? m.caps.join(',') : '') + ']')
      if (typeof cfg.onWelcome === 'function') { try { cfg.onWelcome(m) } catch { /* */ } }
      return
    }
    if (m.type === 'exec') { handleExec(m); return }
    // 将来加新类型：静默放过，别因为不认识就把连接搞崩
  }

  function handleExec (m) {
    const id = m && m.id
    Promise.resolve()
      .then(() => (typeof cfg.onExec === 'function' ? cfg.onExec(m, client) : undefined))
      .then((data) => {
        if (!replyResult(id, true, data)) warn('回执发不出去（连接已断），这条会被对端判超时：' + String(id))
      })
      .catch((e) => {
        const why = String((e && e.message) || e)
        if (!replyResult(id, false, e)) warn('失败回执发不出去（连接已断）：' + String(id) + '｜' + why)
      })
  }

  // ── 连接 / 重连 ──────────────────────────────────────────────
  function stopPing () {
    if (st.pingTimer) { clearInterval(st.pingTimer); st.pingTimer = null }
  }

  function startPing () {
    stopPing()
    const ms = Number(cfg.pingMs) || 0
    if (ms <= 0) return
    st.pingTimer = setInterval(() => { try { if (st.ws) st.ws.ping() } catch { /* 下一跳会走 onclose */ } }, ms)
    if (st.pingTimer.unref) st.pingTimer.unref()
  }

  function nextDelay () {
    const d = st.delay
    const n = Math.min(Number(rc.max), Math.round(st.delay * Number(rc.factor || 2)))
    st.delay = Math.max(Number(rc.min), Number.isFinite(n) ? n : Number(rc.min))
    return d
  }

  function scheduleRetry (why) {
    if (st.stopped || cfg.autoReconnect === false) return
    const delay = nextDelay()
    st.attempts += 1
    if (!st.downSince) st.downSince = Date.now()
    // ★ 日志纪律：第 1 次失败说清楚「开始退避」，之后静默；到顶再说一次。
    //   7310 不开机是常态，一开一关几十次重试，每次打一行会把日志埋掉。
    if (st.attempts === 1) {
      warn('控制通道不可用（' + why + '）—— 开始指数退避重连：' + fmtMs(delay) + ' → 上限 ' + fmtMs(Number(rc.max)) + '，重试期间不刷屏')
    } else if (delay >= Number(rc.max) && !st.loggedCap) {
      st.loggedCap = true
      warn('仍在重连（已 ' + st.attempts + ' 次，间隔已到 ' + fmtMs(Number(rc.max)) + ' 上限）—— 保持静默重试，连上会报一声')
    }
    if (st.retryTimer) clearTimeout(st.retryTimer)
    st.retryTimer = setTimeout(openSocket, delay)
    if (st.retryTimer.unref) st.retryTimer.unref()
  }

  function onClosed (why) {
    const was = st.connected
    st.connected = false
    st.helloed = false
    st.ws = null
    stopPing()
    if (st.stopped) return
    if (typeof cfg.onClose === 'function') { try { cfg.onClose(why) } catch { /* */ } }
    if (was) warn('控制通道断了（' + why + '）')
    scheduleRetry(why)
  }

  function onOpen (ws) {
    if (!ws || st.helloed) return
    st.helloed = true
    st.connected = true
    const waited = st.downSince ? Date.now() - st.downSince : 0
    const tries = st.attempts
    st.attempts = 0
    st.delay = Number(rc.min)
    st.downSince = 0
    st.loggedCap = false
    if (tries > 0) log('已重连 ' + cfg.url + '（重试 ' + tries + ' 次，空了 ' + fmtMs(waited) + '）')
    else log('已连上 ' + cfg.url)
    // ★ hello 一定在这一步发 —— 对端的注册表只靠它认识我们；重连后同样要重发。
    const hello = {
      type: 'hello',
      host: String(cfg.host),
      caps: Array.isArray(cfg.caps) ? cfg.caps.map(String) : [],
      meta: metaNow(),
    }
    send(hello)
    startPing()
    if (typeof cfg.onOpen === 'function') { try { cfg.onOpen(hello) } catch { /* */ } }
  }

  function openSocket () {
    if (st.stopped) return
    let cur = null
    try {
      cur = open({
        url: cfg.url,
        handlers: {
          onopen: () => onOpen(cur),
          onmessage: onMessage,
          onclose: onClosed,
          onerror: (e) => {
            st.lastError = String((e && e.message) || e)
            if (typeof cfg.onError === 'function') { try { cfg.onError(e) } catch { /* */ } }
          },
        },
      })
    } catch (e) {
      onClosed(String((e && e.message) || e))
      return
    }
    st.ws = cur
    // 本地回环上握手可能同步完成，那时 onopen 里的 cur 还是 null —— 补一次
    if (cur.open) onOpen(cur)
  }

  const client = {
    get connected () { return st.connected },
    get hostId () { return st.hostId },
    get stats () { return { sent: st.sent, received: st.received, attempts: st.attempts, lastError: st.lastError } },
    /** 发一条 state（可选，每轮上报，供对端做「思考退化检测」） */
    state (payload) {
      const frame = { type: 'state', ...(payload && typeof payload === 'object' ? payload : {}) }
      const ok = send(frame)
      if (ok && typeof cfg.onState === 'function') { try { cfg.onState(frame) } catch { /* */ } }
      return ok
    },
    /** 低层：直接回一条 result（一般用不到，onExec 的 return/throw 已经覆盖） */
    result (id, ok, payload) { return replyResult(id, ok, payload) },
    /** 低层：发任意帧 */
    send,
    close () {
      st.stopped = true
      stopPing()
      if (st.retryTimer) { clearTimeout(st.retryTimer); st.retryTimer = null }
      try { if (st.ws) st.ws.close() } catch { /* 已经死了 */ }
      st.ws = null
      st.connected = false
      st.helloed = false
    },
  }

  openSocket()
  return client
}

export default { connect, ExecRefused, HINTS }
