// 假 QQ 网关（OneBot v11：WS Universal + HTTP）—— core 侧的验收用件
// ============================================================================
// 迁入自原型 test/mock-onebot.mjs（2026-11-10）。**不连接真实 QQ**，只监听回环。
// 它额外记三样东西，用来做「结构性不行动」的断言：
//   framesFromClient —— 客户端在握手之后往 WS 上写了多少个帧（期望 0）
//   sends            —— 收到的 send_* 调用次数（HTTP + WS 合计，期望 0）
//   closedCount      —— 被断开过几次（core shutdown 之后必须 > 0）
// ============================================================================
import http from 'node:http'
import { createHash } from 'node:crypto'

const wsAccept = (key) => createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')

function encodeFrame (str) {
  const p = Buffer.from(str, 'utf8')
  const head = p.length < 126
    ? Buffer.from([0x81, p.length])
    : Buffer.from([0x81, 126, p.length >> 8, p.length & 255])
  return Buffer.concat([head, p])
}

function decodeFrames (buf) {
  const out = []
  let i = 0
  while (i + 2 <= buf.length) {
    let len = buf[i + 1] & 0x7f
    let p = i + 2
    if (len === 126) { len = buf.readUInt16BE(p); p += 2 } else if (len === 127) { len = Number(buf.readBigUInt64BE(p)); p += 8 }
    const masked = buf[i + 1] & 0x80
    let mask
    if (masked) { mask = buf.subarray(p, p + 4); p += 4 }
    if (p + len > buf.length) break
    const data = Buffer.from(buf.subarray(p, p + len))
    if (mask) for (let k = 0; k < data.length; k++) data[k] ^= mask[k % 4]
    out.push({ op: buf[i] & 0x0f, data })
    i = p + len
  }
  return { frames: out, rest: buf.subarray(i) }
}

export async function startMock ({ selfId = '10001', token = 'mock-token-not-real', port = 0 } = {}) {
  const calls = []
  const sockets = new Set()
  let seq = 1000
  let framesFromClient = 0
  let closedCount = 0

  const handle = (action) => {
    if (action === 'get_login_info') return { user_id: Number(selfId), nickname: 'mock' }
    if (String(action).startsWith('send_')) return { message_id: ++seq }
    return null
  }

  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    if (req.headers.authorization !== 'Bearer ' + token) {
      res.statusCode = 401
      return res.end(JSON.stringify({ status: 'failed', retcode: 1403 }))
    }
    const action = req.url.replace(/^\/+/, '').split('?')[0]
    calls.push({ action, t: Date.now() })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: handle(action) }))
  })

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://x')
    if (url.searchParams.get('access_token') !== token) return socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + wsAccept(req.headers['sec-websocket-key']) + '\r\n\r\n')
    sockets.add(socket)
    let pending = Buffer.alloc(0)
    socket.on('data', (d) => {
      pending = Buffer.concat([pending, d])
      const { frames, rest } = decodeFrames(pending)
      pending = rest
      for (const f of frames) {
        if (f.op === 8) { try { socket.end() } catch { /* */ } continue }
        if (f.op !== 1) continue
        framesFromClient++
        let m = null
        try { m = JSON.parse(f.data.toString('utf8')) } catch { /* 非 JSON 也计数 */ }
        if (m && m.action) calls.push({ action: m.action, t: Date.now(), via: 'ws' })
        socket.write(encodeFrame(JSON.stringify({ status: 'ok', retcode: 0, data: m ? handle(m.action) : null, echo: m ? m.echo : undefined })))
      }
    })
    const gone = () => { if (sockets.delete(socket)) closedCount++ }
    socket.on('close', gone)
    socket.on('error', gone)
  })

  await new Promise((r) => server.listen(port, '127.0.0.1', r))
  const p = server.address().port

  return {
    port: p,
    token,
    selfId,
    wsUrl: 'ws://127.0.0.1:' + p,
    httpUrl: 'http://127.0.0.1:' + p,
    calls,
    get framesFromClient () { return framesFromClient },
    get closedCount () { return closedCount },
    connections: () => sockets.size,
    /** 推一个消息事件（自动补 time/self_id/post_type）。 */
    push (ev) {
      const frame = JSON.stringify(Object.assign({ time: Math.floor(Date.now() / 1000), self_id: Number(selfId), post_type: 'message' }, ev))
      for (const s of sockets) s.write(encodeFrame(frame))
      return sockets.size
    },
    /** 推一条原始帧（坏帧测试用）。 */
    pushRaw (text) { for (const s of sockets) s.write(encodeFrame(String(text))) },
    sends: () => calls.filter((c) => String(c.action).startsWith('send_')),
    async close () {
      for (const s of sockets) { try { s.destroy() } catch { /* */ } }
      sockets.clear()
      await new Promise((r) => server.close(r))
    },
  }
}
