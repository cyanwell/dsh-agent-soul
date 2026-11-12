// 最小 WebSocket 服务端 —— 零依赖，只做「文本帧 + ping/pong + close」
//
// ★ 为什么自己写：v4 的规矩是**零第三方依赖**（整个 35MB 的 exe 里除了 node 就是自己的代码）。
//   引一个 ws 库就破了这条。而我们要的东西很窄：
//   **宿主连上来、说它会什么、收指令、回执**。全部是短文本帧，不需要流式、不需要二进制、不需要扩展。
//
// ★ 规格：RFC 6455 的最小可用子集
//   握手：Sec-WebSocket-Key + magic GUID → SHA1 → base64
//   接收：客户端来的帧**必带 mask**，逐字节 XOR
//   发送：服务端**不许 mask**
//   opcode：0x1 文本 / 0x8 close / 0x9 ping / 0xA pong

import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 握手：把 HTTP upgrade 请求变成一条 WS 连接 */
export function accept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return null; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  return new Conn(socket);
}

export class Conn {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.open = true;
    this.onmessage = null;
    this.onclose = null;
    this.closedPromise = new Promise((res) => { this.#resClosed = res; });

    socket.setNoDelay(true);
    socket.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.#drain(); });
    // ★★ 2026-11-07 修的一个真 bug：只监听 close 不够 —— 宿主掉线时先到的是 end（FIN）。
    //   实测：客户端 socket.destroy() → 服务端 'end' 立刻来，'close' 600ms 后都没来。
    //   后果：注册表里永远留着一条死连接，越用越多，而且 whoHas() 会把它当活的。
    //   ★ 这是「看着对，其实没生效」的又一例：close 看起来是那个事件，实际不是。
    socket.on('end', () => this.#closed());
    socket.on('close', () => this.#closed());
    socket.on('error', () => this.#closed());
  }
  #resClosed = () => {};

  #closed() {
    if (!this.open) return;
    this.open = false;
    try { this.onclose && this.onclose(); } catch {}
    this.#resClosed();
  }

  /** 从缓冲区里尽可能多地切出完整帧 */
  #drain() {
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;

      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const hi = this.buf.readUInt32BE(2), lo = this.buf.readUInt32BE(6);
        len = hi * 2 ** 32 + lo; off = 10;
      }
      // ★ 拒收超大帧：控制通道只有短指令，>1MB 一定是错或者攻击
      if (len > 1024 * 1024) { this.close(1009, '帧太大'); return; }

      const maskLen = masked ? 4 : 0;
      if (this.buf.length < off + maskLen + len) return;   // 还没收全

      let payload = this.buf.subarray(off + maskLen, off + maskLen + len);
      if (masked) {
        const mk = this.buf.subarray(off, off + 4);
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mk[i & 3];
        payload = out;
      }
      this.buf = this.buf.subarray(off + maskLen + len);

      if (opcode === 0x8) { this.close(); return; }          // close
      if (opcode === 0x9) { this.#frame(0xa, payload); continue; }  // ping → pong
      if (opcode === 0xa) continue;                           // pong，忽略
      if (opcode === 0x1) {
        try { this.onmessage && this.onmessage(payload.toString('utf8')); } catch {}
        continue;
      }
      // 其它（二进制/续帧/控制保留）—— 我们不用，静默忽略
    }
  }

  #frame(opcode, data) {
    if (!this.open || this.socket.destroyed) return;
    const len = data.length;
    let head;
    if (len < 126) {
      head = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      head = Buffer.allocUnsafe(4);
      head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2);
    } else {
      head = Buffer.allocUnsafe(10);
      head[0] = 0x80 | opcode; head[1] = 127;
      head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6);
    }
    try { this.socket.write(Buffer.concat([head, data])); } catch { this.#closed(); }
  }

  /** 发一条 JSON（自动序列化） */
  send(obj) {
    if (!this.open) return false;
    this.#frame(0x1, Buffer.from(JSON.stringify(obj), 'utf8'));
    return true;
  }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    const p = Buffer.alloc(2 + Buffer.byteLength(reason));
    p.writeUInt16BE(code, 0);
    p.write(reason, 2, 'utf8');
    this.#frame(0x8, p);
    setTimeout(() => { try { this.socket.end(); } catch {} }, 20);
    this.#closed();
  }
}
