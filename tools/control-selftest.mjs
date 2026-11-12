// 控制通道自检 —— 证明「v4 主动推指令给宿主」这条路真的通
//
// ★ 为什么要先自检而不是直接接 DSH：
//   接 DSH 要改插件、要重启、慢且脏。而这条通道的核心问题是**协议能不能跑通**，
//   拿一个假宿主就能验，且能反复跑。**验通了再接真的，出问题才知道是谁的错。**
//
// 验的五件事：
//   ① 握手成不成（WS 升级）
//   ② hello 认不认（能力注册）
//   ③ v4 → 宿主的 exec 到不到
//   ④ 宿主的 result 回不回得来
//   ⑤ 宿主上报 state（上下文水位）v4 收不收得到 —— 这是「检测上下文污染」的数据源

import http from 'node:http';
import crypto from 'node:crypto';
import { accept } from '../src/control/ws.mjs';
import { ControlHub } from '../src/control/hub.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ✓ ' + n + (d ? '  ' + d : '')); } else { fail++; console.log('  ✗ ' + n + (d ? '  ' + d : '')); } };
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ── 假宿主：自己实现 WS 客户端（零依赖，和 ws.mjs 对称）──────────
function fakeHost({ url, host, caps, onExec }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    const expect = crypto.createHash('sha1').update(key + GUID).digest('base64');
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
      },
    });

    req.on('upgrade', (res, socket) => {
      if (res.headers['sec-websocket-accept'] !== expect) { reject(new Error('握手 accept 不对')); return; }
      const api = {
        socket,
        send(obj) {
          const data = Buffer.from(JSON.stringify(obj), 'utf8');
          const len = data.length;
          let head;
          if (len < 126) { head = Buffer.from([0x81, 0x80 | len]); }
          else if (len < 65536) { head = Buffer.allocUnsafe(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
          else { head = Buffer.allocUnsafe(10); head[0] = 0x81; head[1] = 0x80 | 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
          const mk = crypto.randomBytes(4);
          const masked = Buffer.allocUnsafe(len);
          for (let i = 0; i < len; i++) masked[i] = data[i] ^ mk[i & 3];
          socket.write(Buffer.concat([head, mk, masked]));
        },
        close() { try { socket.destroy(); } catch {} },
      };
      // 收帧
      let buf = Buffer.alloc(0);
      socket.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 2) {
          const op = buf[0] & 0x0f;
          let len = buf[1] & 0x7f, off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = buf.readUInt32BE(6); off = 10; }
          if (buf.length < off + len) return;
          const payload = buf.subarray(off, off + len);
          buf = buf.subarray(off + len);
          if (op === 0x8) { api.close(); return; }
          if (op !== 0x1) continue;
          let m; try { m = JSON.parse(payload.toString('utf8')); } catch { continue; }
          if (m.type === 'exec' && onExec) {
            const r = onExec(m);
            api.send({ type: 'result', id: m.id, ok: r.ok !== false, data: r.data, error: r.error });
          }
        }
      });
      api.send({ type: 'hello', host, caps });
      resolve(api);
    });
    req.on('error', reject);
    req.end();
  });
}

// ── 起一个只带控制通道的临时 server ──────────────────
console.log('=== 控制通道自检 ===');
let lastState = null;
const hub = new ControlHub({
  log: () => {},
  onState: (rec, st) => { lastState = { host: rec.host, ...st }; },
});

const srv = http.createServer((req, res) => { res.writeHead(404); res.end(); });
srv.on('upgrade', (req, socket) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p !== '/control') { try { socket.destroy(); } catch {} return; }
  const conn = accept(req, socket);
  if (conn) hub.attach(conn);
});

await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
const url = 'ws://127.0.0.1:' + port + '/control';
console.log('临时服务 http://127.0.0.1:' + port + '  控制通道 ' + url + '\n');

// ── ① 连上 + hello ─────────────────────────────
const got = [];
const h = await fakeHost({
  url, host: 'fake-dsh', caps: ['followup', 'huanqi', 'pruner', 'state'],
  onExec: (m) => { got.push(m); return { ok: true, data: { echoed: m.action, at: Date.now() } }; },
});
await new Promise((r) => setTimeout(r, 120));

const snap1 = hub.snapshot();
ok('① 握手成立', h.socket && !h.socket.destroyed);
ok('② hello 注册成功', snap1.length === 1 && snap1[0].host === 'fake-dsh', JSON.stringify(snap1[0] ? snap1[0].caps : null));

// ── ③ v4 → 宿主 ───────────────────────────────
const targets = hub.whoHas('huanqi');
ok('③ 按能力找得到宿主', targets.length === 1, 'huanqi → ' + targets.length + ' 个');

let execResult = null, execErr = null;
try { execResult = await hub.exec(targets[0].id, 'huanqi', 'break-turn', { streak: 2 }, 5000); }
catch (e) { execErr = e.message; }
ok('④ exec 到达宿主并回执', !execErr && execResult && execResult.echoed === 'break-turn', execErr || JSON.stringify(execResult));
ok('   宿主真的收到了那条指令', got.length === 1 && got[0].cap === 'huanqi' && got[0].args.streak === 2);

// ── ⑤ nobody has this cap ──────────────────────
ok('⑤ 没人会的能力 → 空（不是报错）', hub.whoHas('teleport').length === 0);

// ── ⑥ 宿主上报 state ──────────────────────────
h.send({ type: 'state', contextTokens: 482000, contextWindow: 1048576, turnId: 'turn-7', outputTokens: 12 });
await new Promise((r) => setTimeout(r, 120));
ok('⑥ 宿主上报上下文水位，v4 收到', lastState && lastState.contextTokens === 482000,
   lastState ? lastState.contextTokens + ' / ' + lastState.contextWindow + '  turn=' + lastState.turnId : '(没收到)');

// ── ⑦ 广播：一个失败不影响其他 ─────────────────
const h2 = await fakeHost({ url, host: 'fake-codex', caps: ['exec'], onExec: () => ({ ok: false, error: '故意的' }) });
const h3 = await fakeHost({ url, host: 'fake-ok', caps: ['exec'], onExec: () => ({ ok: true, data: 'fine' }) });
await new Promise((r) => setTimeout(r, 120));
const bres = await hub.broadcast('exec', 'run', { cmd: 'x' }, 3000);
ok('⑦ 广播：一个失败不中断其他', bres.length === 2 && bres.some((x) => x.ok) && bres.some((x) => !x.ok),
   bres.map((x) => x.host + '=' + (x.ok ? 'ok' : 'fail')).join(' '));

// ── ⑧ exec 超时要 reject（不能永远挂着）──────────
const h4 = await fakeHost({ url, host: 'fake-mute', caps: ['hang'], onExec: () => ({ ok: true, data: null }) });
// 把它的 send 打断，模拟不回声
h4.send = () => {};
await new Promise((r) => setTimeout(r, 80));
const muteId = hub.snapshot().find((x) => x.host === 'fake-mute').id;
let timeoutErr = null;
try { await hub.exec(muteId, 'hang', 'nothing', {}, 400); } catch (e) { timeoutErr = e.message; }
ok('⑧ 宿主不回声 → 超时 reject（不会永远挂）', !!timeoutErr, String(timeoutErr).slice(0, 40));

// ── ⑩ canDo 与 whoHas 的区别（2026-11-07 加）────
// ★ 这一项存在的理由：bridge-dev 的插件在 hello.meta.stubs 里声明「huanqi/pruner 是桩」。
//   如果接收端只问 whoHas，就会**派了活、超时了、才发现对方做不到**。
//   canDo 看的是「声称会 + 没声明是桩」。
const h5 = await fakeHost({
  url, host: 'fake-stubby', caps: ['followup', 'huanqi'],
  onExec: () => ({ ok: true, data: null }),
});
await new Promise((r) => setTimeout(r, 120));
// 徒手发一条 hello 覆盖（fakeHost 只发了 host/caps，要补 meta.stubs）
h5.send({ type: 'hello', host: 'fake-stubby', caps: ['followup', 'huanqi'], meta: { stubs: ['huanqi'] } });
await new Promise((r) => setTimeout(r, 150));

const hasH = hub.whoHas('huanqi').filter((x) => x.host === 'fake-stubby').length;
const canH = hub.canDo('huanqi').filter((x) => x.host === 'fake-stubby').length;
const hasF = hub.whoHas('followup').filter((x) => x.host === 'fake-stubby').length;
const canF = hub.canDo('followup').filter((x) => x.host === 'fake-stubby').length;

ok('⑩a 声称会 huanqi 但声明是桩 → whoHas 为真', hasH === 1, 'whoHas=' + hasH);
ok('⑩b 同一能力 → canDo 为假（派活前该问它）', canH === 0, 'canDo=' + canH);
ok('⑩c 没声明是桩的能力 → canDo 也为真', hasF === 1 && canF === 1, 'whoHas=' + hasF + ' canDo=' + canF);
ok('⑩d snapshot 暴露 meta.stubs', (() => {
  const s = hub.snapshot().find((x) => x.host === 'fake-stubby');
  return s && Array.isArray(s.stubs) && s.stubs.includes('huanqi');
})(), (() => {
  const s = hub.snapshot().find((x) => x.host === 'fake-stubby');
  return s ? 'stubs=' + JSON.stringify(s.stubs) : '(找不到)';
})());
h5.close();

// ── ⑨ 断开后自动移除 ──────────────────────────
const before = hub.snapshot().length;
h2.close(); h3.close(); h4.close(); h.close();
await new Promise((r) => setTimeout(r, 300));
const after = hub.snapshot().length;
ok('⑨ 断开后从注册表移除', after < before, before + ' → ' + after);

srv.close();
console.log('');
console.log('────────────────────────────────────────────');
console.log('通过 ' + pass + ' 项 · 失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
