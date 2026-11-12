/**
 * 最小 WebSocket 客户端（RFC 6455 的一个窄子集）—— 零第三方依赖。
 *
 * ★ 为什么自己写而不引 ws 库：
 *   v4 那边的铁律是「整个服务除了 node 就是自己的代码」（D:\AI\agent-soul\src\control\ws.mjs
 *   开头的原话）。宿主端守同一条，否则「零依赖」只在服务端成立、在客户端破功。
 *   而我们需要的东西极窄：**连上去、发短文本、收短文本、断线报一声**。
 *   不需要流式、不需要二进制、不需要 permessage-deflate、不需要扩展协商。
 *
 * ★ 握手对端是 agent-soul 的 ws.mjs（已冻结），实读过的三条事实：
 *   ① 它校验 Sec-WebSocket-Key 并按 magic GUID 回 Sec-WebSocket-Accept —— 所以我们必须校验回来。
 *   ② **客户端来的帧必带 mask**（它逐字节 XOR 解）；服务端发的不带 mask。
 *   ③ 它只认文本帧（0x1），收到 0x9 会回 pong，收到 0x8 就直接关。
 *   ⇒ 我们发的每一帧都必须 mask，收的帧两种都接。
 *
 * 返回的对象：{ open, send(obj), ping(), close(), raw }
 */

import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_FRAME = 8 * 1024 * 1024

/**
 * @param {string} url  ws://127.0.0.1:7310/control
 * @param {{
 *   onopen?: () => void,
 *   onmessage?: (text: string) => void,
 *   onclose?: (reason: string) => void,
 *   onerror?: (err: Error) => void,
 *   onpong?: () => void,
 * }} handlers
 */
export function connectWs (url, handlers = {}) {
  const u = new URL(url)
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
    throw new Error('只支持 ws:// 或 wss://，收到：' + url)
  }
  const mod = u.protocol === 'wss:' ? https : http
  const key = crypto.randomBytes(16).toString('base64')
  const expect = crypto.createHash('sha1').update(key + GUID).digest('base64')

  let socket = null
  let closed = false
  let buf = Buffer.alloc(0)
  let fragOpcode = 0
  let fragChunks = []
  let attemptsDone = false

  const api = {
    get open () { return !!socket && !closed && !socket.destroyed },
    send (obj) { return sendFrame(0x1, Buffer.from(JSON.stringify(obj), 'utf8')) },
    text (str) { return sendFrame(0x1, Buffer.from(String(str), 'utf8')) },
    ping () { return sendFrame(0x9, Buffer.alloc(0)) },
    close () {
      if (closed) return
      const p = Buffer.alloc(2)
      p.writeUInt16BE(1000, 0)
      sendFrame(0x8, p)
      finish('本地主动关闭')
    },
    get raw () { return socket },
  }

  function finish (reason) {
    if (closed) return
    closed = true
    try { if (socket) socket.destroy() } catch { /* 已经死了 */ }
    try { handlers.onclose && handlers.onclose(reason) } catch { /* 回调不许炸 */ }
  }

  function sendFrame (opcode, data) {
    if (!socket || socket.destroyed) return false
    const len = data.length
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
    head[0] = 0x80 | opcode // FIN=1
    const body = Buffer.allocUnsafe(len)
    for (let i = 0; i < len; i++) body[i] = data[i] ^ mask[i & 3]
    try {
      socket.write(Buffer.concat([head, mask, body]))
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
      if (opcode === 0x9) { sendFrame(0xa, payload); continue }
      if (opcode === 0xa) { try { handlers.onpong && handlers.onpong() } catch { /* */ } ; continue }
      if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) {
        if (opcode !== 0x0) { fragOpcode = opcode; fragChunks = [] }
        fragChunks.push(Buffer.from(payload))
        if (!fin) continue // 分片还没完
        const all = Buffer.concat(fragChunks)
        fragChunks = []
        if (fragOpcode === 0x1) {
          try { handlers.onmessage && handlers.onmessage(all.toString('utf8')) } catch { /* 回调不许炸 */ }
        }
        continue
      }
      // 其它 opcode（二进制/保留）—— 这条通道用不上，静默忽略
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
    attemptsDone = true
    const got = String(res.headers['sec-websocket-accept'] || '')
    if (got !== expect) {
      try { sock.destroy() } catch { /* */ }
      try { handlers.onerror && handlers.onerror(new Error('握手校验失败：Sec-WebSocket-Accept 不匹配')) } catch { /* */ }
      finish('握手校验失败')
      return
    }
    socket = sock
    try { socket.setNoDelay(true) } catch { /* */ }
    if (head && head.length) { buf = Buffer.concat([buf, head]); drain() }
    socket.on('data', (d) => { buf = Buffer.concat([buf, d]); drain() })
    // ★ 三个事件都要接：掉线时先到的常常是 end（FIN），close 可能晚到甚至不到。
    //   这条是 agent-soul 服务端 ws.mjs 里踩过的同一个坑，反着踩一遍而已。
    socket.on('end', () => finish('对端关闭（FIN）'))
    socket.on('close', () => finish('socket close'))
    socket.on('error', (e) => {
      try { handlers.onerror && handlers.onerror(e) } catch { /* */ }
      finish('socket error：' + String((e && e.message) || e))
    })
    try { handlers.onopen && handlers.onopen() } catch { /* */ }
  })

  req.on('response', (res) => {
    // 服务端没升级（例如路径写错回 404）—— 干净地失败，别卡住
    try { handlers.onerror && handlers.onerror(new Error('服务端没有升级到 WebSocket（HTTP ' + res.statusCode + '）')) } catch { /* */ }
    try { req.destroy() } catch { /* */ }
    finish('非 101 响应（HTTP ' + res.statusCode + '）')
  })

  req.on('error', (e) => {
    if (!attemptsDone) {
      try { handlers.onerror && handlers.onerror(e) } catch { /* */ }
    }
    finish('连接失败：' + String((e && (e.code || e.message)) || e))
  })

  req.end()
  return api
}

export default { connectWs }
