// tools/fake-host.mjs —— 假宿主：验证「换宿主 v4 一行不改」
//
// ★★ 这个文件的意义：**它不 import v4 的任何东西**。
//   如果我用 ws-client.mjs，那只能证明「参考实现能用」；
//   手写一遍才能证明**协议本身是自描述的** —— 换一个语言、换一个人，照着文档就能接上。
//
// ★ 只用 node 内置模块（net + crypto），零依赖。

import net from 'node:net';
import crypto from 'node:crypto';

const HOST = process.argv[2] || '127.0.0.1';
const PORT = Number(process.argv[3] || 7310);
const NAME = process.argv[4] || 'fake-host';
const CAPS = (process.argv[5] || 'followup').split(',');

// ── WebSocket 客户端（RFC 6455 最小实现）──────────────
function connect() {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(PORT, HOST);
    let buf = Buffer.alloc(0);
    let upgraded = false;

    sock.on('connect', () => {
      sock.write(
        'GET /control HTTP/1.1\r\n' +
        'Host: ' + HOST + ':' + PORT + '\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n'
      );
    });

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      if (!upgraded) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = buf.slice(0, idx).toString();
        if (!/ 101 /.test(head.split('\r\n')[0])) return reject(new Error('握手失败: ' + head.slice(0, 120)));
        const expect = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        if (!head.includes(expect)) return reject(new Error('Sec-WebSocket-Accept 不对 —— 服务端不是标准 WS？'));
        buf = buf.slice(idx + 4);
        upgraded = true;
        const ws = { send: (obj) => sock.write(encodeFrame(JSON.stringify(obj))), close: () => sock.destroy(), onmessage: null };
        resolve(ws);
      }

      // 解帧
      while (buf.length >= 2) {
        const b0 = buf[0], b1 = buf[1];
        const opcode = b0 & 0x0f;
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const masked = (b1 & 0x80) !== 0;
        let maskKey = null;
        if (masked) { if (buf.length < off + 4) return; maskKey = buf.slice(off, off + 4); off += 4; }
        if (buf.length < off + len) return;
        let payload = buf.slice(off, off + len);
        if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
        buf = buf.slice(off + len);

        if (opcode === 0x1) {
          const text = payload.toString('utf8');
          if (ws.onmessage) ws.onmessage(text);
        } else if (opcode === 0x8) {
          sock.destroy();
        } else if (opcode === 0x9) {   // ping → pong
          sock.write(encodeFrame(payload, 0xA));
        }
      }
    });

    sock.on('error', reject);
    sock.on('end', () => reject(new Error('服务端断开')));
  });
}

function encodeFrame(str, op = 0x1) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.from([0x80 | op, 0x80 | len]); }
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([head, mask, masked]);
}

// ── 假宿主的主逻辑 ────────────────────────────────
const log = (...a) => console.log('[fake]', ...a);

const ws = await connect();
log('握手成功');

ws.onmessage = (raw) => {
  let m;
  try { m = JSON.parse(raw); } catch { return log('收到非 JSON:', raw.slice(0, 80)); }
  log('收到', m.type, JSON.stringify(m).slice(0, 140));

  if (m.type === 'welcome') {
    log('★ 被 v4 认了：id=' + m.id + ' you=' + m.you + ' caps=' + JSON.stringify(m.caps));
    // ★ 立即上报一次 state —— 顺带验证 state 那条路
    ws.send({ type: 'state', contextTokens: 123456, contextWindow: 1048576, turnId: 'fake-turn-1', outputTokens: 42 });
    log('已上报 state');
  }

  if (m.type === 'exec') {
    log('★ 收到派活：cap=' + m.cap + ' action=' + m.action + ' id=' + m.id);
    // 按 cap 分发，必须回执
    if (m.cap === 'followup') {
      log('   followup 的活：args=' + JSON.stringify(m.args));
      ws.send({ type: 'result', id: m.id, ok: true, data: { said: String((m.args && m.args.text) || '').slice(0, 40) } });
      log('   已回 ok:true');
    } else {
      ws.send({ type: 'result', id: m.id, ok: false, error: '这个假宿主不会 ' + m.cap });
      log('   已回 ok:false（做不到要说出来）');
    }
  }
};

// hello 是连上后第一件事
ws.send({ type: 'hello', host: NAME, caps: CAPS, meta: { pid: process.pid, why: '解耦验证' } });
log('已 hello：host=' + NAME + ' caps=' + JSON.stringify(CAPS));

// 活着，等 v4 派活
setTimeout(() => { log('10 秒到，退出'); ws.close(); process.exit(0); }, 10000);
