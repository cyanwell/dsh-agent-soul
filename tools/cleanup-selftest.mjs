// 定点清理自检（E 切片）—— 证明「成功只来自宿主回执」，且**没有内部退路**
//
// ★ 为什么用假宿主而不是真 DSH：
//   真 bridge 的 pruner 现在**明确是桩**（D:\AI\dsh-tools\dsh-agent-soul-bridge\index.js:393
//   「未实现：要 hook 才能裁剪」）。所以：
//     · 真机跑这一条，**必然**失败（stage=stub）—— 那证明的是「v4 没瞎报成功」，不是主链通；
//     · v4 侧的契约（参数形状 / 回执核对 / 门牌 / 落盘）只能由假宿主逐条打靶。
//   报告里要把这件事说清：**fake host 证明的是契约，不是生产可用。**
//
// 打靶清单（对应验收）：
//   ① 成功：targetSession / opId / 起止 seq / framesAffected 全对上 → ok:true + 门牌可回取
//   ② target 不匹配 → ok:false（target-mismatch），不产生成功回执
//   ③ 没有 pruner 能力 → ok:false（no-host），宿主一次都没收到 exec
//   ④ 没有 seq → ok:false（no-seq），宿主一次都没收到 exec
//   ⑤ 超时 → ok:false（timeout）
//   ⑥ 声明是桩 → ok:false（stub），并且**没有发过去等超时**
//   ⑦ 没有目标 → ok:false（no-target）；有 autonomy.targetSession 时回落到它
//   ⑧ **禁止内部 fallback**：源码里不许出现 loop.turn / compactRange；失败的清理不写任何会话帧
//   ⑨ **动态目标（2026-11-11）**：留空 = 跟随当前 lead（与自主同一个解析器）；
//      固定/显式目标**一次心跳都不读**；缺 seq **连心跳都不读**；解析不出 = no-target 不派活
//
// 跑法：node tools/cleanup-selftest.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { accept } from '../src/control/ws.mjs';
import { ControlHub } from '../src/control/hub.mjs';
import { createTargetedCleanup, readCleanupState, CLEANUP_CAP, CLEANUP_ACTION } from '../src/organs/cleanup.mjs';
import { SessionStore } from '../src/session/store.mjs';
import { Query } from '../src/tools/query.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ✓ ' + n + (d ? '  ' + d : '')); } else { fail++; console.log('  ✗ ' + n + (d ? '  ' + d : '')); } };

// ── 临时目录（系统 tmp，绝不碰仓库 data/）─────────────────────────────
const TMP_ROOT = fs.realpathSync(os.tmpdir());
const DATA = fs.mkdtempSync(path.join(TMP_ROOT, 'agent-soul-cleanup-'));
{
  const real = fs.realpathSync(DATA);
  const prod = (() => { try { return fs.realpathSync(path.join(ROOT, 'data')); } catch { return path.join(ROOT, 'data'); } })();
  if (!(real === TMP_ROOT || real.startsWith(TMP_ROOT + path.sep)) || real === prod || real.startsWith(prod + path.sep)) {
    throw new Error('临时目录不在 os.tmpdir() 下（或落进了生产 data/）：' + real);
  }
}
console.log('临时数据 ' + DATA);

// ── 假宿主（与 tools/control-selftest.mjs 同一份手写 WS 客户端）────────
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
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
        socket,
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
          if (m.type === 'exec' && onExec) {
            const r = onExec(m);
            if (r === 'SILENT') return;               // 故意不回声（测超时）
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 本地会话（供门牌回取验证）────────────────────────────────────────
const store = new SessionStore(DATA);
store.create(ROOT, null, { id: 'sess-target' });
for (let i = 1; i <= 6; i++) store.append('sess-target', i % 2 ? 'user' : 'assistant', { text: '第 ' + i + ' 帧：这一段是要被定点清理的内容' });
store.create(ROOT, null, { id: 'sess-other' });
store.append('sess-other', 'user', { text: '另一个会话，用来证明 target 不匹配会被拒' });
const targetFrames = store.load('sess-target').frames.map((f) => f.seq);
const START = targetFrames[1], END = targetFrames[targetFrames.length - 1];
console.log('sess-target 帧 seq = ' + targetFrames.join(',') + '；本次清理请求 ' + START + '–' + END + '\n');

const mkOrgan = (hub, cfg, extra) => createTargetedCleanup({
  control: hub,
  autonomy: { config: cfg || {} },
  dataDir: DATA,
  timeoutMs: 1500,
  log: (m) => console.log('    [清理] ' + m),
  ...(extra || {}),
});

console.log('=== 定点清理自检（E）===');

// ── ① 成功 ────────────────────────────────────────────────
{
  const { hub, url, close } = await openHub();
  const got = [];
  const h = await fakeHost({
    url, host: 'fake-pruner', caps: ['followup', CLEANUP_CAP],
    onExec: (m) => {
      got.push(m);
      if (m.cap !== CLEANUP_CAP || m.action !== CLEANUP_ACTION) return { ok: false, error: '不认识：' + m.cap + '/' + m.action };
      const a = m.args || {};
      return { ok: true, data: {
        targetSession: a.targetSession, opId: a.opId,
        startSeq: a.startSeq, endSeq: a.endSeq,
        framesAffected: a.endSeq - a.startSeq + 1, bytesAffected: 4321,
        at: new Date().toISOString(),
      } };
    },
  });
  await sleep(120);
  const organ = mkOrgan(hub, { targetSession: null });
  const r = await organ.run({ sessionId: 'sess-target', startSeq: START, endSeq: END, reason: '自检：清一段' });

  ok('①a 成功（宿主回执逐字对上）', r.ok === true && r.stage === 'cleaned', JSON.stringify({ ok: r.ok, stage: r.stage, reason: r.reason }));
  ok('①b 宿主收到的是 pruner/targeted-cleanup', got.length === 1 && got[0].cap === CLEANUP_CAP && got[0].action === CLEANUP_ACTION, got.length ? got[0].cap + '/' + got[0].action : '(没收到)');
  ok('①c args 带上了 sessionId / opId / 起止 seq', !!(got[0] && got[0].args.sessionId === 'sess-target' && got[0].args.opId && got[0].args.startSeq === START && got[0].args.endSeq === END), JSON.stringify(got[0] && got[0].args));
  ok('①d 回执里 opId 是 v4 下发的那个（不是宿主自己编的）', r.opId === got[0].args.opId, r.opId);
  ok('①e 影响帧数/字节来自回执', r.framesAffected === (END - START + 1) && r.bytesAffected === 4321, r.framesAffected + ' 帧 / ' + r.bytesAffected + ' B');
  ok('①f 门牌 = log:<session>#seq=<start> + 覆盖范围', r.pointer === 'log:sess-target#seq=' + START && /seq \d+–\d+/.test(r.coverage || ''), r.pointer + '（' + r.coverage + '）');
  ok('①g 时间来源标成 host', r.atSource === 'host' && Number.isFinite(Date.parse(r.at)), r.at + ' ← ' + r.atSource);
  ok('①h 回执落盘了（隔离 data）', r.receiptPersisted === true && fs.existsSync(path.join(DATA, 'cleanup-receipts.json')), String(r.receiptFile));

  const st = readCleanupState({ dataDir: DATA });
  ok('①i 回执账可读，last 就是这一条', st.ok && st.last && st.last.ok === true && st.last.opId === r.opId, st.ok ? 'history ' + st.history.length + ' 条' : st.why);

  // ★ 门牌必须**真的能回取** —— 否则它只是一段好看的字符串。
  const q = new Query(store, null);
  const opened = q.open(r.pointer);
  ok('①j 门牌可回取（Query.open → 真帧）', opened.ok === true && opened.kind === 'log' && opened.seq === START, opened.ok ? opened.type + ' · ' + String(opened.text || '').slice(0, 24) : opened.code + ' ' + opened.hint);

  h.close(); close();
}

// ── ② target 不匹配 ───────────────────────────────────────
{
  const { hub, url, close } = await openHub();
  const h = await fakeHost({
    url, host: 'fake-wrong-target', caps: [CLEANUP_CAP],
    onExec: (m) => ({ ok: true, data: {
      targetSession: 'sess-other', opId: m.args.opId,
      startSeq: m.args.startSeq, endSeq: m.args.endSeq,
      framesAffected: 3, at: new Date().toISOString(),
    } }),
  });
  await sleep(120);
  const r = await mkOrgan(hub, {}).run({ sessionId: 'sess-target', startSeq: START, endSeq: END });
  ok('②a target 不匹配 → 失败（target-mismatch）', r.ok === false && r.stage === 'target-mismatch', r.reason);
  const st = readCleanupState({ dataDir: DATA });
  ok('②b 失败回执照样落盘，且 last.ok=false', st.ok && st.last && st.last.ok === false && st.last.stage === 'target-mismatch', st.ok ? st.last.stage : st.why);
  ok('②c 失败回执仍带请求的门牌（便于核对「本来要清哪一段」）', st.last.pointer === 'log:sess-target#seq=' + START, st.last.pointer);
  h.close(); close();
}

// ── ③ 没有 pruner 能力 ────────────────────────────────────
{
  const { hub, url, close } = await openHub();
  let execs = 0;
  const h = await fakeHost({ url, host: 'fake-followup-only', caps: ['followup'], onExec: () => { execs++; return { ok: true, data: null }; } });
  await sleep(120);
  const r = await mkOrgan(hub, {}).run({ sessionId: 'sess-target', startSeq: START, endSeq: END });
  ok('③a 没有 pruner → 失败（no-host）', r.ok === false && r.stage === 'no-host', r.reason);
  ok('③b 宿主一次都没收到 exec（没瞎派）', execs === 0, 'execs=' + execs);
  h.close(); close();
}

// ── ④ 没有 seq ────────────────────────────────────────────
{
  const { hub, url, close } = await openHub();
  let execs = 0;
  const h = await fakeHost({ url, host: 'fake-pruner-2', caps: [CLEANUP_CAP], onExec: () => { execs++; return { ok: true, data: null }; } });
  await sleep(120);
  const r = await mkOrgan(hub, {}).run({ sessionId: 'sess-target', endSeq: END });
  ok('④a 缺 startSeq → 失败（no-seq）', r.ok === false && r.stage === 'no-seq', r.reason);
  ok('④b 缺 seq 时不派活（没有可核对的范围就不发）', execs === 0, 'execs=' + execs);
  const r2 = await mkOrgan(hub, {}).run({ sessionId: 'sess-target', startSeq: END, endSeq: START });
  ok('④c startSeq > endSeq → 失败（bad-request）', r2.ok === false && r2.stage === 'bad-request', r2.reason);
  h.close(); close();
}

// ── ⑤ 超时 ────────────────────────────────────────────────
{
  const { hub, url, close } = await openHub();
  const h = await fakeHost({ url, host: 'fake-mute', caps: [CLEANUP_CAP], onExec: () => 'SILENT' });
  await sleep(120);
  const r = await mkOrgan(hub, {}).run({ sessionId: 'sess-target', startSeq: START, endSeq: END, timeoutMs: 300 });
  ok('⑤a 宿主不回声 → 失败（timeout），不挂死', r.ok === false && r.stage === 'timeout', r.reason);
  ok('⑤b 超时也落一条失败回执', (() => { const st = readCleanupState({ dataDir: DATA }); return st.ok && st.last.stage === 'timeout'; })(), '');
  h.close(); close();
}

// ── ⑥ 声明是桩 ────────────────────────────────────────────
{
  const { hub, url, close } = await openHub();
  let execs = 0;
  const h = await fakeHost({
    url, host: 'fake-stub', caps: [CLEANUP_CAP], meta: { stubs: [CLEANUP_CAP] },
    onExec: () => { execs++; return { ok: true, data: null }; },
  });
  await sleep(120);
  const r = await mkOrgan(hub, {}).run({ sessionId: 'sess-target', startSeq: START, endSeq: END });
  ok('⑥a 宿主自报 pruner 是桩 → 失败（stub）', r.ok === false && r.stage === 'stub', r.reason);
  ok('⑥b 桩不发过去等超时（提前拒）', execs === 0, 'execs=' + execs);
  h.close(); close();
}

// ── ⑦ 目标来源 ────────────────────────────────────────────
{
  const { hub, url, close } = await openHub();
  const h = await fakeHost({
    url, host: 'fake-pruner-3', caps: [CLEANUP_CAP],
    onExec: (m) => ({ ok: true, data: {
      targetSession: m.args.targetSession, opId: m.args.opId,
      startSeq: m.args.startSeq, endSeq: m.args.endSeq, framesAffected: 1,
    } }),
  });
  await sleep(120);

  const r0 = await mkOrgan(hub, { targetSession: null }).run({ startSeq: START, endSeq: END });
  ok('⑦a 没有 sessionId 也没有 autonomy.targetSession → no-target（fail-closed）', r0.ok === false && r0.stage === 'no-target', r0.reason);

  const r1 = await mkOrgan(hub, { targetSession: 'sess-target' }).run({ startSeq: START, endSeq: END });
  ok('⑦b 回落到 autonomy.targetSession', r1.ok === true && r1.targetSession === 'sess-target' && r1.targetSource === 'autonomy.targetSession', r1.targetSource + ' → ' + r1.targetSession);

  const r2 = await mkOrgan(hub, { targetSession: 'sess-target' }).run({ sessionId: 'sess-other', targetSession: 'sess-target', startSeq: START, endSeq: END });
  ok('⑦c 两个目标不一致 → bad-request（不替你选）', r2.ok === false && r2.stage === 'bad-request', r2.reason);
  h.close(); close();
}

// ── ⑨ 动态目标（2026-11-11：留空 = 跟随当前 lead）────────────
{
  const { createLeadTargetResolver } = await import('../src/organs/lead-target.mjs');
  // ★ 心跳是**注入的 fetch**，地址只填一个不会有人监听的端口 —— 这些用例一次真实网络都不发。
  const RESOLVER_CFG = { integrations: { heartbeatUrl: 'http://127.0.0.1:1/heartbeat/auto' } };
  const mkHB = (payload) => {
    const hb = { fetches: 0 };
    hb.resolver = createLeadTargetResolver({
      config: RESOLVER_CFG,
      fetchImpl: async () => {
        hb.fetches++;
        if (payload === 'throw') throw new Error('connect ECONNREFUSED 127.0.0.1:1');
        return { ok: true, status: 200, json: async () => payload };
      },
    });
    return hb;
  };
  const lead = (id) => ({ ok: true, primaryFound: true, primarySessionId: id, primaryCandidates: 1, leadSource: '02-墨.jsonl:last-lead' });

  const { hub, url, close } = await openHub();
  const got = [];
  const h = await fakeHost({
    url, host: 'fake-pruner-4', caps: [CLEANUP_CAP],
    onExec: (m) => {
      got.push(m);
      const a = m.args || {};
      return { ok: true, data: { targetSession: a.targetSession, opId: a.opId, startSeq: a.startSeq, endSeq: a.endSeq, framesAffected: 1 } };
    },
  });
  await sleep(120);

  const hbA = mkHB(lead('sess-other'));
  const r1 = await mkOrgan(hub, { targetSession: null }, { leadTarget: hbA.resolver })
    .run({ sessionId: 'sess-target', startSeq: START, endSeq: END });
  ok('⑨a 显式 sessionId → 成功，且一次心跳都不读', r1.ok === true && r1.targetSource === 'caller' && hbA.fetches === 0,
    r1.targetSource + ' / fetches=' + hbA.fetches);

  // ★ 心跳坏着也不影响固定覆盖 —— 「人钉死的东西」不该被一个读不到的接口拖失效
  const hbB = mkHB('throw');
  const r2 = await mkOrgan(hub, { targetSession: 'sess-target' }, { leadTarget: hbB.resolver })
    .run({ startSeq: START, endSeq: END });
  ok('⑨b 固定 autonomy.targetSession → 成功，心跳坏着也不读', r2.ok === true && r2.targetSource === 'autonomy.targetSession' && hbB.fetches === 0,
    r2.targetSource + ' / fetches=' + hbB.fetches);

  const hbC = mkHB(lead('sess-other'));
  got.length = 0;
  const r3 = await mkOrgan(hub, { targetSession: null }, { leadTarget: hbC.resolver })
    .run({ startSeq: START, endSeq: END });
  ok('⑨c 留空 → 跟随心跳给的当前 lead', r3.ok === true && r3.targetSession === 'sess-other' && r3.targetSource === 'heartbeat-lead',
    r3.targetSource + ' → ' + r3.targetSession);
  ok('⑨d 同一次调用：args 与门牌用的是同一个 resolved id',
    !!(got[0] && got[0].args.targetSession === 'sess-other' && r3.pointer === 'log:sess-other#seq=' + START), r3.pointer);

  const hbD = mkHB({ ok: true, primaryFound: false, primaryWhy: '账本里没有 lead 记录' });
  got.length = 0;
  const r4 = await mkOrgan(hub, { targetSession: null }, { leadTarget: hbD.resolver })
    .run({ startSeq: START, endSeq: END });
  ok('⑨e 没有 lead → no-target，宿主一次都没收到 exec',
    r4.ok === false && r4.stage === 'no-target' && got.length === 0, r4.stage + ' / execs=' + got.length);

  const hbE = mkHB(lead('sess-other'));
  const r5 = await mkOrgan(hub, { targetSession: null }, { leadTarget: hbE.resolver }).run({ endSeq: END });
  ok('⑨f 缺 seq → no-seq，且**不读心跳**（这一次注定不派活）',
    r5.ok === false && r5.stage === 'no-seq' && hbE.fetches === 0, r5.stage + ' / fetches=' + hbE.fetches);
  h.close(); close();
}

// ── ⑧ 禁止内部 fallback ───────────────────────────────────
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'organs', 'cleanup.mjs'), 'utf8');
  const code = src.replace(/\/\/[^\n]*/g, '');   // 只查代码行，注释里提到「不许」不算
  ok('⑧a 源码里没有 loop.turn（不自己跑）', !/loop\.turn|agent\/loop\.mjs/.test(code), '');
  ok('⑧b 源码里没有 compactRange / compaction（不拿内部压缩冒充）', !/compactRange|organs\/compaction/.test(code), '');

  // 失败的清理不许写任何会话帧 —— 前后目录指纹必须一样。
  const framesBefore = fs.readdirSync(path.join(DATA, 'sessions'))
    .map((d) => { const f = path.join(DATA, 'sessions', d, 'frames.jsonl'); try { const s = fs.statSync(f); return d + ':' + s.size + ':' + Math.round(s.mtimeMs); } catch { return d + ':none'; } })
    .sort().join('|');
  const { hub, url, close } = await openHub();
  const h = await fakeHost({ url, host: 'fake-fail', caps: [CLEANUP_CAP], onExec: () => ({ ok: false, error: '故意的失败' }) });
  await sleep(120);
  await mkOrgan(hub, {}).run({ sessionId: 'sess-target', startSeq: START, endSeq: END });
  const framesAfter = fs.readdirSync(path.join(DATA, 'sessions'))
    .map((d) => { const f = path.join(DATA, 'sessions', d, 'frames.jsonl'); try { const s = fs.statSync(f); return d + ':' + s.size + ':' + Math.round(s.mtimeMs); } catch { return d + ':none'; } })
    .sort().join('|');
  ok('⑧c 失败的清理不碰任何会话帧（目录指纹不变）', framesBefore === framesAfter, framesBefore === framesAfter ? '未变' : framesBefore + ' → ' + framesAfter);
  h.close(); close();
}

store.saveIndexCache?.(); store.closeAll();
// ★ 取证模式：SOUL_KEEP_TMP=1 时保留临时目录（只给「把回执样本抄进 _verify」用），默认仍然清掉。
if (process.env.SOUL_KEEP_TMP === '1') console.log('保留临时数据：' + DATA);
else { try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {} }

console.log('');
console.log('────────────────────────────────────────────');
console.log('通过 ' + pass + ' 项 · 失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
