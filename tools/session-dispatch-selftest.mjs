// 会话调度自检 —— 用假宿主逐条打「回执纪律」，不碰真 DSH、不碰生产服务
//
// ★ 为什么自己起 hub：本文件**不连 7521**。它在一个临时端口上起一个真的
//   ControlHub + 真的 WS 服务端（就是 src/control/ws.mjs 那一份），
//   假宿主从外面连进来发 hello。这样测的是**协议本身**，而不是「生产进程此刻的状态」。
//   ★ 也正因为如此，跑它不会重启任何服务、不会惊动任何真宿主。
//
// ★ 为什么假宿主手写 WS（不用 src/control/ws-client.mjs）：
//   用自家客户端只能证明「参考实现自洽」。手写一遍才能证明契约是自描述的。
//   （和 tools/cleanup-selftest.mjs 同一条理由，那一份也手写。）
//
// 打靶清单：
//   a) resolve：查得到 → sessionId；查不到 → NOT_FOUND，**且没有触发 create**（数指令条数）
//   b) followup：成功 → delivered:true；回执 sessionId 不等 → MISMATCH 且**不记账**
//   c) steer：没在跑 → NOT_RUNNING（帧级失败 + 载荷级失败两条路都认）
//   d) 宿主不回 → TIMEOUT（300ms 档），不抛、不挂死
//   e) 没有宿主 → NO_HOST，view() 能把「没人接」和「发了失败」分开
//   f) canary：正文不进 stdout、不进 view()、不进返回值（含「宿主把正文回显在 error 里」）
//
// 跑法：node tools/session-dispatch-selftest.mjs

import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import { accept } from '../src/control/ws.mjs';
import { ControlHub } from '../src/control/hub.mjs';
import { createSessionDispatch, CODES, SESSION_CAP } from '../src/organs/session-dispatch.mjs';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ✓ ' + n + (d ? '  ' + d : '')); } else { fail++; console.log('  ✗ ' + n + (d ? '  ' + d : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 起一个真的控制通道（临时端口）──────────────────────────────────
async function openHub() {
  const hub = new ControlHub({ log: () => {} });
  const srv = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  srv.on('upgrade', (req, socket) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p !== '/control') { try { socket.destroy(); } catch {} return; }
    const conn = accept(req, socket);
    if (conn) hub.attach(conn);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = 'ws://127.0.0.1:' + srv.address().port + '/control';
  return { hub, url, close: () => { try { srv.close(); } catch {} } };
}

// ── 假宿主（手写 WS 客户端，零依赖）────────────────────────────────
function fakeHost({ url, host, caps, meta, onExec }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    const expect = crypto.createHash('sha1').update(key + GUID).digest('base64');
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' },
    });
    req.on('upgrade', (res, socket) => {
      if (res.headers['sec-websocket-accept'] !== expect) { reject(new Error('握手 accept 不对')); return; }
      const api = {
        got: [],
        send(obj) {
          const data = Buffer.from(JSON.stringify(obj), 'utf8');
          const len = data.length;
          let head;
          if (len < 126) head = Buffer.from([0x81, 0x80 | len]);
          else if (len < 65536) { head = Buffer.allocUnsafe(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
          else { head = Buffer.allocUnsafe(10); head[0] = 0x81; head[1] = 0x80 | 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
          const mk = crypto.randomBytes(4);
          const masked = Buffer.allocUnsafe(len);
          for (let i = 0; i < len; i++) masked[i] = data[i] ^ mk[i & 3];
          socket.write(Buffer.concat([head, mk, masked]));
        },
        close() { try { socket.destroy(); } catch {} },
      };
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
          if (m.type === 'exec') {
            api.got.push({ cap: m.cap, action: m.action, args: m.args });
            if (!onExec) continue;
            const r = onExec(m);
            if (r === 'SILENT') continue;                 // 故意不回声（测超时）
            if (r && r.__frameFail) {                     // 帧级失败（走 hub.exec 的 reject 那条路）
              api.send({ type: 'result', id: m.id, ok: false, error: r.error, ...(r.hint ? { hint: r.hint } : {}) });
              continue;
            }
            api.send({ type: 'result', id: m.id, ok: r.ok !== false, data: r.data, error: r.error });
          }
        }
      });
      api.send({ type: 'hello', host, caps, meta: meta || {} });
      resolve(api);
    });
    req.on('error', reject);
    req.end();
  });
}

const logsAll = [];
const mkDispatch = (hub, extra) => createSessionDispatch({
  hub,
  log: (m) => { logsAll.push(m); },
  ...(extra || {}),
});

console.log('=== 会话调度自检 ===');

// ── a) resolve：查得到 / 查不到 / 不新建 ──────────────────────────
{
  const { hub, url, close } = await openHub();
  const h = await fakeHost({
    url, host: 'fake-session', caps: [SESSION_CAP],
    onExec: (m) => {
      if (m.cap !== SESSION_CAP) return { ok: false, data: { ok: false, code: 'BAD_REQUEST' } };
      if (m.action === 'resolve') {
        if (m.args.chatId === 'chat-known') return { ok: true, data: { ok: true, sessionId: 'session-known-1' } };
        return { ok: true, data: { ok: false, code: 'NOT_FOUND' } };
      }
      return { ok: false, data: { ok: false, code: 'BAD_REQUEST' } };
    },
  });
  await sleep(120);
  const d = mkDispatch(hub);

  const r1 = await d.resolve({ chatId: 'chat-known', preset: 'lead' });
  ok('a1 resolve 查得到 → sessionId', r1.ok === true && r1.sessionId === 'session-known-1',
    JSON.stringify({ ok: r1.ok, sessionId: r1.sessionId, host: r1.host }));
  ok('a2 指令形状 = cap:session / action:resolve', h.got[0] && h.got[0].cap === SESSION_CAP && h.got[0].action === 'resolve',
    JSON.stringify(h.got[0] && h.got[0].args));

  const r2 = await d.resolve({ chatId: 'chat-unknown' });
  ok('a3 查不到 → NOT_FOUND（不猜一个）', r2.ok === false && r2.code === CODES.NOT_FOUND, r2.code + ' / ' + r2.detail);

  // ★ 关键：查不到之后**没有**任何 create 发出去。数的是假宿主真收到的指令条数。
  const actions = h.got.map((g) => g.action);
  ok('a4 没有触发 create（宿主只收到 2 条，都是 resolve，create 计数 0）',
    h.got.length === 2 && actions.every((a) => a === 'resolve') && h.got.filter((g) => g.action === 'create').length === 0,
    '收到 ' + h.got.length + ' 条：' + actions.join(','));

  const v = d.view();
  ok('a5 记账：counts.resolve=1 / failed=1', v.counts.resolve === 1 && v.counts.failed === 1, JSON.stringify(v.counts));
  ok('a6 view() 看到这一个宿主', v.hostCount === 1 && v.hosts[0].host === 'fake-session', JSON.stringify(v.hosts[0].caps));
  h.close(); close();
}

// ── a′) 宿主用**帧级失败**表达 NOT_FOUND（另一条合法路径）──────────
{
  const { hub, url, close } = await openHub();
  const h = await fakeHost({
    url, host: 'fake-frame-fail', caps: [SESSION_CAP],
    onExec: () => ({ __frameFail: true, error: '[code:NOT_FOUND] 这个 chat 没有对应的会话' }),
  });
  await sleep(120);
  const d = mkDispatch(hub);
  const r = await d.resolve({ chatId: 'chat-x' });
  ok('a7 帧级 ok:false + [code:NOT_FOUND] → 同样归成 NOT_FOUND', r.ok === false && r.code === CODES.NOT_FOUND, r.code);
  ok('a8 返回值里**没有**宿主 error 原文（只留机器码）',
    !JSON.stringify(r).includes('这个 chat 没有对应'), JSON.stringify(r));
  h.close(); close();
}

// ── b) followup：成功 / sessionId 不等 → MISMATCH 且不记账 ─────────
{
  const { hub, url, close } = await openHub();
  const texts = [];
  const h = await fakeHost({
    url, host: 'fake-session', caps: [SESSION_CAP],
    onExec: (m) => {
      texts.push(m.args.text);
      if (m.action === 'followup') {
        if (m.args.text === 'MISMATCH-CASE') {
          return { ok: true, data: { ok: true, delivered: true, sessionId: 'session-OTHER' } };
        }
        if (m.args.text === 'NOT-DELIVERED-CASE') {
          return { ok: true, data: { ok: true, delivered: false, sessionId: m.args.sessionId } };
        }
        return { ok: true, data: { ok: true, delivered: true, sessionId: m.args.sessionId } };
      }
      return { ok: true, data: { ok: true, delivered: true, sessionId: m.args.sessionId } };
    },
  });
  await sleep(120);
  const d = mkDispatch(hub);

  const r1 = await d.followup({ sessionId: 'session-known-1', text: '自检投递：一句话', meta: { why: 'selftest' } });
  ok('b1 followup 成功 → delivered:true + sessionId 逐字对上',
    r1.ok === true && r1.delivered === true && r1.sessionId === 'session-known-1', JSON.stringify({ ok: r1.ok, sessionId: r1.sessionId }));
  ok('b2 宿主收到的正文逐字等于发出的（证明真发了，不是被吞了）', texts[0] === '自检投递：一句话', '');
  ok('b3 meta 透传了', h.got[0].args.meta && h.got[0].args.meta.why === 'selftest', JSON.stringify(h.got[0].args.meta));

  const before = d.view().counts.followup;
  const r2 = await d.followup({ sessionId: 'session-known-1', text: 'MISMATCH-CASE' });
  ok('b4 回执 sessionId 不等 → MISMATCH', r2.ok === false && r2.code === CODES.MISMATCH, r2.code + ' / ' + r2.detail);
  ok('b5 **不记账**：counts.followup 没有增加', d.view().counts.followup === before, 'followup=' + d.view().counts.followup + '（原 ' + before + '）');
  ok('b6 但 counts.failed +1', d.view().counts.failed === 1, JSON.stringify(d.view().counts));

  const r3 = await d.followup({ sessionId: 'session-known-1', text: 'NOT-DELIVERED-CASE' });
  ok('b7 delivered 不为 true → NOT_DELIVERED（不认）', r3.ok === false && r3.code === CODES.NOT_DELIVERED, r3.code);

  // ★ 逐字：差一个空格就是 MISMATCH（不做 trim 规范化）
  const h2 = await fakeHost({
    url: 'ws://127.0.0.1:' + new URL(url).port + '/control', host: 'fake-whitespace', caps: [SESSION_CAP],
    onExec: () => ({ ok: true, data: { ok: true, delivered: true, sessionId: 'session-known-1 ' } }),
  });
  await sleep(120);
  const r4 = await mkDispatch(hub).followup({ sessionId: 'session-known-1', text: '尾空格' });
  ok('b8 回执多一个尾空格 → MISMATCH（逐字，不 trim）', r4.ok === false && r4.code === CODES.MISMATCH, r4.code);
  h2.close();

  const v = d.view();
  ok('b9 view() 不含正文', !JSON.stringify(v).includes('自检投递') && !JSON.stringify(v).includes('MISMATCH-CASE'), '');
  h.close(); close();
}

// ── c) steer：没在跑 → NOT_RUNNING（两条路都认）──────────────────
{
  const { hub, url, close } = await openHub();
  const h = await fakeHost({
    url, host: 'fake-session', caps: [SESSION_CAP],
    onExec: (m) => {
      if (m.action !== 'steer') return { ok: true, data: { ok: true, delivered: true } };
      // 第一条用帧级失败，第二条用载荷级失败 —— 宿主两种写法都要被认成同一件事
      if (m.args.text === 'frame-fail') return { __frameFail: true, error: '[code:NOT_RUNNING] 没在跑' };
      return { ok: true, data: { ok: false, code: 'NOT_RUNNING' } };
    },
  });
  await sleep(120);
  const d = mkDispatch(hub);

  const r1 = await d.steer({ sessionId: 'session-known-1', text: 'frame-fail' });
  ok('c1 steer 没在跑（帧级）→ NOT_RUNNING', r1.ok === false && r1.code === CODES.NOT_RUNNING, r1.code);
  const r2 = await d.steer({ sessionId: 'session-known-1', text: 'payload-fail' });
  ok('c2 steer 没在跑（载荷级）→ NOT_RUNNING', r2.ok === false && r2.code === CODES.NOT_RUNNING, r2.code);

  // steer 成功：回执不必自报 sessionId；报了就必须对上
  const h2 = await fakeHost({
    url: 'ws://127.0.0.1:' + new URL(url).port + '/control', host: 'fake-steer-ok', caps: [SESSION_CAP],
    onExec: () => ({ ok: true, data: { ok: true, delivered: true } }),
  });
  await sleep(120);
  const r3 = await mkDispatch(hub).steer({ sessionId: 'session-known-1', text: '打断一下' });
  ok('c3 steer 成功（回执不自报 sessionId 也认）', r3.ok === true && r3.delivered === true, JSON.stringify({ ok: r3.ok, sessionId: r3.sessionId }));
  h2.close();

  const r4 = await d.steer({ sessionId: '', text: 'x' });
  ok('c4 缺 sessionId → BAD_REQUEST（不发出去）', r4.ok === false && r4.code === CODES.BAD_REQUEST, r4.code);
  h.close(); close();
}

// ── d) 宿主不回 → TIMEOUT（300ms 档），不抛、不挂死 ────────────────
{
  const { hub, url, close } = await openHub();
  const h = await fakeHost({ url, host: 'fake-mute', caps: [SESSION_CAP], onExec: () => 'SILENT' });
  await sleep(120);
  const d = mkDispatch(hub, { timeoutMs: 300 });
  const t0 = Date.now();
  let threw = null;
  let r = null;
  try { r = await d.followup({ sessionId: 'session-known-1', text: '不会有人回' }); }
  catch (e) { threw = e; }
  const ms = Date.now() - t0;
  ok('d1 宿主不回 → TIMEOUT（不抛）', threw === null && r && r.ok === false && r.code === CODES.TIMEOUT,
    threw ? '抛了：' + threw.message : (r && r.code) + ' / ' + (r && r.detail));
  ok('d2 用的是 300ms 档，没有挂到默认 8s', ms < 1500, ms + 'ms');
  ok('d3 超时也记账（failed+1）', d.view().counts.failed === 1, JSON.stringify(d.view().counts));
  h.close(); close();
}

// ── e) 没有宿主 → NO_HOST，且能区分「没人接」与「发了失败」────────
{
  const hub = new ControlHub({ log: () => {} });     // 一条连接都没 attach
  const d = mkDispatch(hub);
  const r = await d.resolve({ chatId: 'chat-1' });
  ok('e1 没有宿主 → NO_HOST', r.ok === false && r.code === CODES.NO_HOST, r.code + ' / ' + r.detail);
  const v0 = d.view();
  ok('e2 view()：noHost.count=1 / hosts 空 / lastOutcome.code=NO_HOST',
    v0.noHost.count === 1 && v0.hostCount === 0 && v0.lastOutcome && v0.lastOutcome.code === CODES.NO_HOST,
    JSON.stringify({ noHost: v0.noHost, lastOutcome: v0.lastOutcome }));

  // 现在造一次「发了但被拒」，证明两件事在 view 里长得不一样
  const { hub: hub2, url, close } = await openHub();
  const h = await fakeHost({
    url, host: 'fake-session', caps: [SESSION_CAP],
    onExec: () => ({ __frameFail: true, error: '宿主内部炸了' }),
  });
  await sleep(120);
  const d2 = mkDispatch(hub2);
  await d2.followup({ sessionId: 'session-known-1', text: '会被拒' });
  const v1 = d2.view();
  ok('e3 「发了失败」：noHost.count=0，但 failed=1，code=HOST_ERROR',
    v1.noHost.count === 0 && v1.counts.failed === 1 && v1.lastOutcome.code === CODES.HOST_ERROR,
    JSON.stringify({ noHost: v1.noHost, counts: v1.counts, code: v1.lastOutcome.code }));
  ok('e4 两者可分辨（noHost.count 不同）', v0.noHost.count === 1 && v1.noHost.count === 0, '');

  // 宿主连着但自报 session 是桩 —— 也算「没人接」，但 detail 说得更准
  // ★ 这里必须用一个**干净的 hub**：hub2 上还连着能干活的 fake-session，
  //   混在一起就测不到「只有桩」这一种局面（第一次写这段时正是这里红了）。
  const { hub: hub3, url: url3, close: close3 } = await openHub();
  const h2 = await fakeHost({ url: url3, host: 'fake-stub', caps: [SESSION_CAP], meta: { stubs: [SESSION_CAP] }, onExec: () => 'SILENT' });
  await sleep(120);
  const r2 = await mkDispatch(hub3).resolve({ chatId: 'chat-1' });
  ok('e5 只有桩宿主 → NO_HOST，detail 指出是桩', r2.ok === false && r2.code === CODES.NO_HOST && /桩/.test(r2.detail), r2.code + ' / ' + r2.detail);
  ok('e6 桩宿主一次 exec 都没收到', h2.got.length === 0, 'got=' + h2.got.length);
  h.close(); h2.close(); close(); close3();
}

// ── g) create：四个动作里唯一会新建容器的那个 ──────────────────────
{
  const { hub, url, close } = await openHub();
  const h = await fakeHost({
    url, host: 'fake-session', caps: [SESSION_CAP],
    onExec: (m) => {
      if (m.action !== 'create') return { ok: false, data: { ok: false, code: 'BAD_REQUEST' } };
      if (m.args.chatId === 'chat-new') return { ok: true, data: { ok: true, sessionId: 'session-fresh-1', chatId: 'chat-new' } };
      if (m.args.chatId === 'chat-lying') return { ok: true, data: { ok: true, sessionId: 'session-fresh-2', chatId: 'chat-other' } };
      return { ok: true, data: { ok: true, sessionId: 'session-fresh-3' } };
    },
  });
  await sleep(120);
  const d = mkDispatch(hub);

  const r1 = await d.create({ chatId: 'chat-new', preset: 'lead', level: 2 });
  ok('g1 create 成功 → 新 sessionId', r1.ok === true && r1.sessionId === 'session-fresh-1',
    JSON.stringify({ ok: r1.ok, sessionId: r1.sessionId }));
  ok('g2 指令带上了 preset / level', h.got[0].args.preset === 'lead' && h.got[0].args.level === 2, JSON.stringify(h.got[0].args));

  const r2 = await d.create({ chatId: 'chat-lying' });
  ok('g3 回执自报的 chatId 与请求不一致 → MISMATCH（不认这个新会话）', r2.ok === false && r2.code === CODES.MISMATCH, r2.code);
  ok('g4 MISMATCH 不记账：counts.create 仍是 1', d.view().counts.create === 1, JSON.stringify(d.view().counts));

  const before = h.got.length;
  const r3 = await d.create({});
  ok('g5 没有 chatId → BAD_REQUEST，且一条指令都不发（不凭空开容器）',
    r3.ok === false && r3.code === CODES.BAD_REQUEST && h.got.length === before, '发出 ' + h.got.length + ' 条');
  h.close(); close();
}

// ── f) canary：正文不进 stdout / view() / 返回值 ──────────────────
{
  const CANARY = 'CANARY-9f3c-must-not-leak';
  const logs = [];
  const { hub, url, close } = await openHub();

  // ① 正常投递
  const h = await fakeHost({
    url, host: 'fake-session', caps: [SESSION_CAP],
    onExec: (m) => ({ ok: true, data: { ok: true, delivered: true, sessionId: m.args.sessionId } }),
  });
  await sleep(120);
  const d = createSessionDispatch({ hub, log: (m) => logs.push(m) });

  // 捕获真实 stdout（console.log 最终也走 process.stdout.write）
  const cap = { buf: '' };
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s, ...rest) => { cap.buf += String(s); return origWrite(s, ...rest); };
  let r1 = null, r2 = null;
  try {
    // ★ 哨兵：先证明这段真的在截流。否则「缓冲区 0 字节所以没泄漏」是假绿 ——
    //   捕获根本没生效也会得到同样的结论。
    console.log('canary-capture-sentinel');
    r1 = await d.followup({ sessionId: 'session-known-1', text: '前缀 ' + CANARY + ' 后缀' });
    // ② 宿主把正文回显在 error 里（最坏的泄漏形态）
    h.close();
    const hBad = await fakeHost({
      url, host: 'fake-echo', caps: [SESSION_CAP],
      onExec: (m) => ({ __frameFail: true, error: '拒绝投递：' + m.args.text }),
    });
    await sleep(120);
    r2 = await d.followup({ sessionId: 'session-known-1', text: '再试 ' + CANARY });
    hBad.close();
  } finally {
    process.stdout.write = origWrite;
  }

  ok('f1 正常投递成功（canary 确实发出去了）', r1 && r1.ok === true, '');
  ok('f2 宿主回显正文时 → HOST_ERROR（不认）', r2 && r2.ok === false && r2.code === CODES.HOST_ERROR, r2 && r2.code);
  ok('f3 捕获链路有效（哨兵在里面）且 stdout 无 canary',
    cap.buf.includes('canary-capture-sentinel') && cap.buf.indexOf(CANARY) === -1,
    '捕获 ' + cap.buf.length + ' 字节');
  ok('f4 调度日志无 canary', logs.join('\n').indexOf(CANARY) === -1, logs.length + ' 行');
  ok('f5 view() 无 canary', JSON.stringify(d.view()).indexOf(CANARY) === -1, '');
  ok('f6 返回值无 canary', JSON.stringify([r1, r2]).indexOf(CANARY) === -1, '');
  ok('f7 内存里所有日志行也扫一遍（含前面各用例）', logsAll.join('\n').indexOf(CANARY) === -1, logsAll.length + ' 行');
  close();
}

// ── h) 结构性断言：没有内部退路、没有周期任务 ────────────────────
{
  const src = fs.readFileSync(new URL('../src/organs/session-dispatch.mjs', import.meta.url), 'utf8');
  const code = src.replace(/\/\/[^\n]*/g, '');            // 只查代码行：注释里写「不许」不算
  ok('h1 没有 loop.turn / agent loop（不自己跑）', !/loop\.turn|agent\/loop\.mjs/.test(code), '');
  ok('h2 没有 session store / frame 写入口（不自己造容器、不自己写帧）',
    !/session\/store|organs\/frame|compaction|compactRange/.test(code), '');
  ok('h3 没有周期任务（无 setInterval）', !/setInterval/.test(code), '');
  ok('h4 唯一的 setTimeout 是单次超时兜底', (code.match(/setTimeout/g) || []).length === 1,
    (code.match(/setTimeout/g) || []).length + ' 处');
  ok('h5 没有重试循环（无 while/for 里 await exec）', !/for\s*\([^)]*\)\s*\{[^}]*await/.test(code), '');
}

console.log('');
console.log('────────────────────────────────────────────');
console.log('通过 ' + pass + ' 项 · 失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
