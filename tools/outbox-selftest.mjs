// 出站口自检（唯一出站入口）—— 只打本地 mock，不连真 QQ、不读任何部署配置
//
// ★ 五条要证的（缺一条这段代码就不该上线）：
//   a) 一条真的落到网关的 send_group_msg 上，retcode 0 → ok:true；
//   b) 同一内容再发 → **网关只收到一次**，返回 deduped:true，messageId 沿用第一次的；
//   c) group / private 打的是两个不同的 action（打错类型不会报错，只会发到错的地方，
//      所以断言必须落在 action 名和 id 字段上，不是「有没有发出去」）；
//   d) 网关 500 → ok:false + stats.failed+1（失败要**返回**，不能抛给调用方）；
//   e) token 到得了网关的 Authorization 头，却不出现在任何日志 / 视图 / 记录里
//      —— 两半都要断：只断「没出现」而 token 其实根本没发，那是一条空断言。
//
// ★ 为什么 mock 自己写、不复用 tools/events-mock-onebot.mjs：
//   入站那个 mock 记的是帧与去重；出站要验的是**action 名与请求体字面**。
//   混用会让「断言绿了」和「这件事真的成立」脱钩。
//
// 跑法：node tools/outbox-selftest.mjs

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createOutbox, outboxView, currentOutbox, parseChatId, normalizeSegments } from '../src/adapters/outbox.mjs';
import { SessionStore } from '../src/session/store.mjs';
import { ToolRegistry } from '../src/tools/registry.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { AgentLoop } from '../src/agent/loop.mjs';
import { createServer } from '../src/web/server.mjs';
import { loadConfig } from '../src/config.mjs';

const TOKEN = 'TESTTOKEN';

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n + (d ? '  ' + d : '')); }
  else { fail++; console.log('  ✗ ' + n + (d ? '  ' + d : '')); }
};

// ── 本地 mock 网关（OneBot v11 HTTP 形状）────────────────────────────
async function startMock() {
  const calls = [];
  const state = { mode: 'ok' };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
    const action = req.url.replace(/^\/+/, '').split('?')[0];
    calls.push({ action, body, auth: String(req.headers.authorization || ''), at: Date.now() });
    res.setHeader('content-type', 'application/json');
    if (state.mode === 'error500') {
      res.statusCode = 500;
      return res.end(JSON.stringify({ status: 'failed', retcode: 1200, wording: 'mock 故意报错' }));
    }
    // HTTP 200 但业务层失败 —— OneBot 的常态（风控 / 被禁言），也是最容易被当成成功的那种
    if (state.mode === 'retcode') {
      return res.end(JSON.stringify({ status: 'failed', retcode: 100, wording: 'mock 风控拦截' }));
    }
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 7000 + calls.length } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    calls, state,
    url: 'http://127.0.0.1:' + port,
    async close() { await new Promise((r) => server.close(r)); },
  };
}

/** 抓 stdout/stderr：出站口自己的日志必须过这一关（token 只许在 header 里）。 */
function tapOutput() {
  const bufs = [];
  const outW = process.stdout.write;
  const errW = process.stderr.write;
  const wrap = (orig) => function (chunk, ...rest) { bufs.push(String(chunk)); return orig.call(this, chunk, ...rest); };
  process.stdout.write = wrap(outW);
  process.stderr.write = wrap(errW);
  return () => {
    process.stdout.write = outW;
    process.stderr.write = errW;
    return bufs.join('');
  };
}

const mock = await startMock();
const stopTap = tapOutput();
const ob = createOutbox({ baseUrl: mock.url, token: TOKEN, timeoutMs: 3000, log: (m) => console.log(m) });

// ── a) 发一条 ──────────────────────────────────────────────────────
const textA = '出站自检第一条';
const r1 = await ob.send('group:100', textA);
const call1 = mock.calls[0] || null;
ok('a) 发一条：ok:true / retcode 0', r1.ok === true && r1.retcode === 0 && r1.deduped === false, 'ok=' + r1.ok + ' retcode=' + r1.retcode + ' messageId=' + r1.messageId);
ok('a) mock 恰好收到 1 次', mock.calls.length === 1, '收到 ' + mock.calls.length + ' 次');
ok('a) 落到 send_group_msg，group_id=100，正文原样',
  Boolean(call1) && call1.action === 'send_group_msg' && call1.body && call1.body.group_id === 100
    && Array.isArray(call1.body.message) && call1.body.message[0].type === 'text' && call1.body.message[0].data.text === textA,
  call1 ? call1.action + ' group_id=' + (call1.body && call1.body.group_id) : '无请求');

// ── b) 幂等：同一内容再发 ─────────────────────────────────────────
const r2 = await ob.send('group:100', textA);
ok('b) 再发同一内容：网关仍然只收到 1 次', mock.calls.length === 1, '收到 ' + mock.calls.length + ' 次');
ok('b) 返回 deduped:true，且 messageId 沿用第一次',
  r2.ok === true && r2.deduped === true && String(r2.messageId) === String(r1.messageId),
  'deduped=' + r2.deduped + ' messageId=' + r2.messageId + '（首次 ' + r1.messageId + '）');
ok('b) stats：sent=1 deduped=1', ob.stats().sent === 1 && ob.stats().deduped === 1,
  JSON.stringify(ob.stats()));

// ── c) group / private 两个 action ───────────────────────────────
const r3 = await ob.send('private:200', '私聊一条');
const call3 = mock.calls[mock.calls.length - 1] || null;
ok('c) private → send_private_msg，user_id=200',
  r3.ok === true && Boolean(call3) && call3.action === 'send_private_msg' && call3.body && call3.body.user_id === 200,
  call3 ? call3.action + ' user_id=' + (call3.body && call3.body.user_id) : '无请求');
ok('c) 两个 action 各 1 次（群/私聊没有串）',
  mock.calls.filter((x) => x.action === 'send_group_msg').length === 1
  && mock.calls.filter((x) => x.action === 'send_private_msg').length === 1,
  'group=' + mock.calls.filter((x) => x.action === 'send_group_msg').length + ' private=' + mock.calls.filter((x) => x.action === 'send_private_msg').length);

// ── d) 网关 500 ──────────────────────────────────────────────────
const failedBefore = ob.stats().failed;
mock.state.mode = 'error500';
const before500 = mock.calls.length;
const r4 = await ob.send('group:300', '这条会撞 500');
mock.state.mode = 'ok';
ok('d) 500 → ok:false（不抛）', r4.ok === false && before500 + 1 === mock.calls.length, 'ok=' + r4.ok + ' error=' + r4.error);
ok('d) stats.failed +1', ob.stats().failed === failedBefore + 1, 'failed ' + failedBefore + ' → ' + ob.stats().failed);

// ── d2) HTTP 200 + retcode≠0：业务层失败也是失败 ─────────────────
const beforeBiz = mock.calls.length;
const failedBiz = ob.stats().failed;
mock.state.mode = 'retcode';
const r5 = await ob.send('group:600', '这条会被风控');
const again = await ob.send('group:600', '这条会被风控');
mock.state.mode = 'ok';
ok('d2) 200 + retcode=100 → ok:false，带 retcode',
  r5.ok === false && r5.retcode === 100 && ob.stats().failed === failedBiz + 2,
  'ok=' + r5.ok + ' retcode=' + r5.retcode + ' error=' + String(r5.error).slice(0, 30));
ok('d2) 失败不进幂等表：同一内容重试仍然真的发出去（2 次请求）',
  again.ok === false && mock.calls.length === beforeBiz + 2,
  '网关收到 ' + (mock.calls.length - beforeBiz) + ' 次');

// ── e) token 的两半 ──────────────────────────────────────────────
const captured = stopTap();
const viewJson = JSON.stringify(ob.view(20));
const statsJson = JSON.stringify(ob.stats());
const sharedJson = JSON.stringify(outboxView({ limit: 5 }));
const hits = [];
if (captured.includes(TOKEN)) hits.push('stdout/stderr');
if (viewJson.includes(TOKEN)) hits.push('view');
if (statsJson.includes(TOKEN)) hits.push('stats');
if (sharedJson.includes(TOKEN)) hits.push('outboxView');
ok('e) token 不出现在日志 / view / stats 里', hits.length === 0, hits.length ? '命中：' + hits.join(',') : '扫了 ' + captured.length + ' 字符输出 + 三份视图');
ok('e) 但 token 确实到了网关（否则上一条是空断言）',
  mock.calls.length > 0 && mock.calls.every((x) => x.auth === 'Bearer ' + TOKEN),
  mock.calls.length + ' 个请求全部带 Bearer');
const tokView = outboxView({ limit: 5 });
ok('e) 视图只说 tokenSet，不给值', tokView.tokenSet === true && !JSON.stringify(tokView).includes(TOKEN));

// ── 附加：视图、预览脱敏、拒发、网络错、close ────────────────────
const longText = '很长的一条消息'.repeat(20);
await ob.send('group:400', longText);
const rec = ob.view(1).recent[0];
ok('视图：预览 ≤40 字，但长度仍是真的（脱敏只截显示）',
  Boolean(rec) && rec.preview.length <= 40 && rec.preview.length < longText.length && rec.len === longText.length,
  'preview=' + rec.preview.length + ' 字 / len=' + (rec && rec.len) + ' 字');
ok('视图：最近记录带 chatId/action/messageId', Boolean(rec) && rec.chatId === 'group:400' && rec.action === 'send_group_msg' && rec.messageId != null,
  rec ? rec.chatId + ' ' + rec.action + ' ' + rec.messageId : '无');

const callsBeforeEmpty = mock.calls.length;
const rEmpty = await ob.send('group:100', '');
const rBadChat = await ob.send('not-a-chat', 'x');
ok('拒发：空消息 / 坏 chatId 都不上网关',
  rEmpty.ok === false && rBadChat.ok === false && mock.calls.length === callsBeforeEmpty,
  '空=' + rEmpty.ok + ' 坏chatId=' + rBadChat.ok + ' 网关收到 ' + (mock.calls.length - callsBeforeEmpty) + ' 次');

const keyed1 = await ob.send('group:500', '带幂等键的一条', { idempotencyKey: 'job-42' });
const keyed2 = await ob.send('group:500', '带幂等键的一条', { idempotencyKey: 'job-42' });
ok('幂等键：同一 key 重放不重发', keyed1.deduped === false && keyed2.deduped === true && String(keyed1.messageId) === String(keyed2.messageId));

// 网络错：拿一个「刚关掉」的端口，保证连不上
const dead = http.createServer(() => {});
await new Promise((r) => dead.listen(0, '127.0.0.1', r));
const deadPort = dead.address().port;
await new Promise((r) => dead.close(r));
const obDead = createOutbox({ baseUrl: 'http://127.0.0.1:' + deadPort, token: TOKEN, timeoutMs: 2000, register: false });
let threw = false;
let rDead = null;
try { rDead = await obDead.send('group:1', '发不出去的一条'); } catch { threw = true; }
ok('网络错：返回 ok:false 且不抛', threw === false && rDead && rDead.ok === false && Boolean(rDead.error), rDead ? String(rDead.error).slice(0, 60) : 'threw=' + threw);
ok('网络错：错误串里没有 token', Boolean(rDead) && !String(rDead.error).includes(TOKEN));

ok('共享视图读的就是 createOutbox 出来的那个实例', currentOutbox() === ob && outboxView({ limit: 1 }).stats.sent === ob.stats().sent,
  'sent=' + outboxView({ limit: 1 }).stats.sent);

// ── 路由：GET /api/outbox（真 createServer，进程内 listen(0)）───────
// ★ 为什么这条也得在自检里：只测 outboxView() 等于测函数，不测接线 ——
//   而「没接上的路由」正是这次交付最容易假装成功的那一步。
const cfg = loadConfig();
cfg.dataDir = path.join(os.tmpdir(), 'agent-soul-outbox-selftest-' + Date.now());
const store = new SessionStore(cfg.dataDir);
const tools = new ToolRegistry();
const loop = new AgentLoop({ store, llm: new LlmClient(cfg.llm), tools, config: cfg });
const srv = createServer({ store, loop, tools, config: cfg });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + srv.address().port;
try {
  const resp = await fetch(base + '/api/outbox');
  const routeText = await resp.text();
  const routeBody = JSON.parse(routeText);
  ok('路由：GET /api/outbox 200 + JSON', resp.status === 200 && routeBody.port === 'outbox-core', 'status=' + resp.status + ' port=' + routeBody.port);
  ok('路由：数字与出站口同一个来源（不是另算一份）',
    routeBody.stats.sent === ob.stats().sent && routeBody.stats.deduped === ob.stats().deduped && routeBody.stats.failed === ob.stats().failed,
    'sent=' + routeBody.stats.sent + ' deduped=' + routeBody.stats.deduped + ' failed=' + routeBody.stats.failed);
  ok('路由：带最近记录，且正文只有前 40 字',
    routeBody.recent.length >= 1 && routeBody.recent.every((x) => String(x.preview || '').length <= 40),
    routeBody.recent.length + ' 条，最长 preview=' + Math.max(...routeBody.recent.map((x) => String(x.preview || '').length)));
  ok('路由：响应里没有 token', !routeText.includes(TOKEN), '响应 ' + routeText.length + ' 字节');
} finally {
  await new Promise((r) => srv.close(r));
  try { fs.rmSync(cfg.dataDir, { recursive: true, force: true }); } catch { /* 没建过目录 */ }
}

ob.close();
const afterClose = await ob.send('group:100', '关掉之后的一条');
ok('close() 之后不再发，但计数保留（关停不该把真话抹成「没接线」）',
  afterClose.ok === false && outboxView().closed === true && outboxView().mode === 'closed' && outboxView().stats.sent === ob.stats().sent,
  'afterClose.ok=' + afterClose.ok + ' mode=' + outboxView().mode + ' sent=' + outboxView().stats.sent);

ok('parseChatId：group/private 认得出，别的拒',
  parseChatId('group:1').action === 'send_group_msg' && parseChatId('private:2').field === 'user_id' && parseChatId('x:1') === null);
ok('normalizeSegments：字符串包成 text 段，坏段拒', JSON.stringify(normalizeSegments('hi')) === JSON.stringify([{ type: 'text', data: { text: 'hi' } }]) && normalizeSegments([{ data: {} }]) === null);

await mock.close();

console.log('');
console.log('────────────────────────────────────────────');
console.log('通过 ' + pass + ' 项 · 失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
