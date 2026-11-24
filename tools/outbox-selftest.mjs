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
import { createOutbox, outboxView, currentOutbox, parseChatId, normalizeSegments, OUTBOX_PORT, resolveActTimeoutMs, ACT_DEFAULT_TIMEOUT_MS } from '../src/adapters/outbox.mjs';
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
    // ★ 资料类动作（act 白名单）回的 data 形状与发消息不同 —— 自检要能验「data 原样回来」
    const isAct = !/^send_/.test(action);
    const data = action === 'send_qzone_msg'
      ? { tid: 'mock-qzone-' + calls.length }
      : (isAct ? { emoji_id: 'MOCK-EMOJI-' + calls.length } : { message_id: 7000 + calls.length });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
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
// ★ 2026-11-24：createOutbox 的默认模式是 off（安全默认）。自检就是要验「真发得出去」，
//   所以这里必须显式打开 —— 不写就等于一条都发不出去，而那正是它该抓的错。
const ob = createOutbox({ mode: 'onebot-http', baseUrl: mock.url, token: TOKEN, timeoutMs: 3000, log: (m) => console.log(m) });

// ── 0) 端口自述：动作清单就是这 22 个名字（3 发送/戳 + 19 ACT 白名单） ──
// ★ 为什么要在一个「能发包」的自检里断这个：这口唯一的对外自述就是 actions ——
//   多写一个名字，等于对外承诺了一条不存在的通道；少写一个，等于有路却没人知道。
// ★ comment_qzone 经单独授权追加；本轮再追加 ban/kick/like 三个已授权动作。
//   未知 / 自定义 action 仍留在白名单外，由第 f) 段验证。
// ★ 第六片追加上传那一对；第七片只再加 set_group_special_title / _send_group_notice。
//   ban/kick 与 like_qzone 已进白名单；近似串仍留外部并由第 f) 段逐项验证。
ok('0) OUTBOX_PORT 只广告 3 个发送动作 + 19 个 act 动作（共 22 个）',
  JSON.stringify(OUTBOX_PORT.actions) === JSON.stringify([
    'send_group_msg', 'send_private_msg', 'send_poke',
    'set_input_status', 'modify_custom_face', 'delete_custom_face', 'set_self_longnick', 'set_qq_profile',
    'set_qq_avatar', 'add_custom_face',
    'set_friend_add_request', 'set_doubt_friends_add_request',
    'delete_qzone_msg',
    'upload_group_file', 'upload_private_file',
    'set_group_special_title', '_send_group_notice', 'send_qzone_msg', 'comment_qzone',
    'set_group_ban', 'set_group_kick', 'like_qzone',
  ]),
  OUTBOX_PORT.actions.join(' / '));
ok('0) 端口自述逐字写出每个改道动作（只报个数读不出「哪几个」）',
  OUTBOX_PORT.actions.every((name) => OUTBOX_PORT.note.includes(name)),
  '缺：' + OUTBOX_PORT.actions.filter((name) => !OUTBOX_PORT.note.includes(name)).join(',') || '无');
ok('0) 自述明说没有通用 call(action, params) 通道', /没有通用 call/.test(OUTBOX_PORT.note), OUTBOX_PORT.note.slice(0, 40) + '…');
ok('0) 视图里的 actions 与端口自述同一份', JSON.stringify(ob.view().actions) === JSON.stringify(OUTBOX_PORT.actions));

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
const obDead = createOutbox({ mode: 'onebot-http', baseUrl: 'http://127.0.0.1:' + deadPort, token: TOKEN, timeoutMs: 2000, register: false });
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
//
// ★★ 2026-11-24（隔离修复）：这里原来写的是 `loadConfig()` —— 无参默认读
//   appRoot()/config.json，那是**部署配置**；它还会再叠同目录的 config.local.json，
//   再把 AGENT_SOUL_KEY 等环境变量盖到 cfg.llm 上。一个只该打本地 mock 的自检读它 = bug。
//   现在三条一起把这条路堵死（缺一条都还会漏）：
//     ① 配置只从**临时根下的临时 config.json** 读（下面刚写进去的那几个键，没有任何秘密）；
//     ② AGENT_SOUL_HOME 指向临时根 —— 因为 createServer 会动态 import
//        adapters/mcp-http.mjs → mcp-tools.mjs，而那边**模块级**自己
//        loadConfig(appRoot()/config.json)。判据在 config.mjs 的 appRoot()（认 AGENT_SOUL_HOME），
//        于是那条路也落到同一个临时文件上，而不是仓库根目录里的那份真配置；
//     ③ 摘掉 loadConfig 会无条件应用的五个部署环境变量（只 delete，**不读值**）。
//   ★ 为什么「传一个临时路径给 loadConfig」不够：①治不了 ②（那条路是 createServer
//     自己走出来的，不看参数）；③不做，真实的 API Key 会被 loadConfig 塞进 cfg.llm.apiKey。
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-soul-outbox-selftest-'));
// 前置判据（不靠注释保证）：临时根必须真的在系统临时目录下。不在就**停手** ——
// 不带着「可能是真实目录」的路径往下走。
if (!path.resolve(tmpRoot).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
  throw new Error('临时根不在系统临时目录下，停手：' + tmpRoot);
}
const tmpConfig = path.join(tmpRoot, 'config.json');
const prevHome = process.env.AGENT_SOUL_HOME;
let srv = null;
try {
  process.env.AGENT_SOUL_HOME = tmpRoot;
  for (const k of ['AGENT_SOUL_KEY', 'AGENT_SOUL_BASE_URL', 'AGENT_SOUL_MODEL', 'AGENT_SOUL_PORT', 'AGENT_SOUL_DATA']) delete process.env[k];
  // 合成配置：数据目录 / 状态目录都相对临时根解析（config.mjs 的 resolvePath 相对 appRoot()）。
  fs.writeFileSync(tmpConfig, JSON.stringify({
    dataDir: 'data', statusDir: 'status', host: '127.0.0.1', port: 0, quiet: true,
    llm: { apiKey: '', apiKeyRef: '', baseUrl: '' },
  }, null, 2));
  const cfg = loadConfig(tmpConfig);
  console.log('  隔离：临时根 ' + tmpRoot + '（config 由自检自己写，不读部署配置）');
  const store = new SessionStore(cfg.dataDir);
  const tools = new ToolRegistry();
  const loop = new AgentLoop({ store, llm: new LlmClient(cfg.llm), tools, config: cfg });
  srv = createServer({ store, loop, tools, config: cfg });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  // 这一条断的是「自检只打本机回环」——它和 cfg 那三条是同一件事的两半：
  // 配置没读真文件、流量也没出本机。
  ok('路由：只打本机 127.0.0.1（不连真网关）', /^http:\/\/127\.0\.0\.1:\d+$/.test(base), base);

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
  // 收尾三件事都要做，缺一件就是「本次运行在机器上留了痕迹」：
  //   ① 关服务（close() 只停止接收新连接；fetch 的 keep-alive 连接会让回调一直不返回，
  //      所以先掐掉存量连接再等 —— 否则自检会在最后几秒卡成一个假死）；
  //   ② 删临时根（配置、dataDir、statusDir 全在它下面，一次 rm 清干净）；
  //   ③ 把 AGENT_SOUL_HOME 还原（被删掉的五个凭据类环境变量**不还原**：还原就得先把值读进内存）。
  if (srv) {
    await new Promise((r) => { srv.close(r); if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections(); });
  }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 临时根可能已经被删过 */ }
  if (prevHome === undefined) delete process.env.AGENT_SOUL_HOME; else process.env.AGENT_SOUL_HOME = prevHome;
}

// ── f) act：白名单资料动作（2026-11-24 第二片）────────────────────
// ★ 只打本地 mock。验的是：路由 / 请求体 / data 原样 / 无幂等 / 白名单外拒绝 / mode 闸 /
//   参数不落日志。**不验**任何真网关行为 —— 这个脚本从头到尾不出本机。
const actBase = mock.calls.length;
const statsBeforeAct = ob.stats();
const actLogTap = tapOutput();
const rAct1 = await ob.act('modify_custom_face', { emoji_id: 'E-1', desc: '偷图备注' });
const callAct1 = mock.calls[mock.calls.length - 1] || null;
const actLog1 = actLogTap();
ok('f) act 落到 modify_custom_face，请求体原样（emoji_id / desc 都在）',
  rAct1.ok === true && Boolean(callAct1) && callAct1.action === 'modify_custom_face'
  && JSON.stringify(callAct1.body) === JSON.stringify({ emoji_id: 'E-1', desc: '偷图备注' }),
  callAct1 ? callAct1.action + ' body=' + JSON.stringify(callAct1.body) : '无请求');
ok('f) data 原样回来（emoji_id 留着 —— 调用方就是靠它）',
  Boolean(rAct1.data) && String(rAct1.data.emoji_id).startsWith('MOCK-EMOJI-'),
  'data=' + JSON.stringify(rAct1.data));
ok('f) 动作名进了日志，参数没进（备注是用户内容）',
  actLog1.includes('modify_custom_face') && !actLog1.includes('偷图备注'),
  '日志 ' + actLog1.length + ' 字符');

const rAct2 = await ob.act('modify_custom_face', { emoji_id: 'E-1', desc: '偷图备注' });
ok('f) 同样参数做两次 = 两次请求（资料动作不进幂等表）',
  rAct2.ok === true && mock.calls.length === actBase + 2 && ob.stats().deduped === statsBeforeAct.deduped,
  '网关收到 ' + (mock.calls.length - actBase) + ' 次，deduped ' + statsBeforeAct.deduped + ' → ' + ob.stats().deduped);

// 另外八个动作：各落各的 URL，请求体逐字
// ★ 第三片的两个（set_qq_avatar / add_custom_face）也在这一圈里：它们和其它五个一样，
//   走的是同一个 act() 通道 —— 没有为它们开特例，只是名字进了白名单。
// ★ 第四片的好友申请两个（set_friend_add_request / set_doubt_friends_add_request）同理：
//   同样是这一个通道，只是名字进了白名单；它们的两条专属契约在下面单独验（这里只验路由与请求体）。
// ★ 第五片的 delete_qzone_msg 同理：走的是这同一个 act() 通道，没有第二条路。
//   它的专属契约（{ tid } 逐字 / 失败不写本地 deletedAt）在 test/qzone-delete-guard.test.mjs 里；
//   这里只验「路由到 /delete_qzone_msg 且请求体逐字是 { tid }」。
const actRoutes = [];
for (const [action, params] of [
  ['set_input_status', { user_id: 10001, event_type: 1 }],
  ['delete_custom_face', { emoji_id: 'E-2' }],
  ['set_self_longnick', { longNick: '签名一行' }],
  ['set_qq_profile', { nickname: '砚青' }],
  ['set_qq_avatar', { file: 'base64://YXZhdGFy' }],
  ['add_custom_face', { file: 'base64://QkM=' }],
  ['set_friend_add_request', { flag: 'event-flag-selftest-1', approve: true }],
  ['set_doubt_friends_add_request', { flag: 'doubt-uid-selftest-2', approve: false }],
  ['delete_qzone_msg', { tid: 'selftest-post-5a1c' }],
  // ★ 第六片：上传那一对也走**同一个** act() 通道 —— 这里只验「落到 /<动作名>，请求体逐字」。
  //   大小上限 / 允许目录 / base64 回落那些判据在 hub.sendFile 上，由 node --test 那边钉；
  //   自检不再造第二份判据（两份判据只会在某个边界值上分叉）。
  ['upload_group_file', { group_id: 100, file: 'selftest-local/a.pdf', name: 'a.pdf' }],
  ['upload_private_file', { user_id: 200, file: 'base64://QkM=', name: 'b.pdf' }],
]) {
  const before = mock.calls.length;
  const r = await ob.act(action, params);
  const c = mock.calls[mock.calls.length - 1] || null;
  actRoutes.push({
    action,
    good: r.ok === true && mock.calls.length === before + 1 && Boolean(c)
      && c.action === action && JSON.stringify(c.body) === JSON.stringify(params),
  });
}
ok('f) 其余十一个白名单动作各落各的 URL，请求体原样',
  actRoutes.every((x) => x.good),
  actRoutes.every((x) => x.good) ? '11/11' : '错：' + actRoutes.filter((x) => !x.good).map((x) => x.action).join(','));

// 第五片专属：delete_qzone_msg 落对了 URL、请求体只有 { tid }、且 tid 逐字
// ★ 第六片之后这条**不能再取 last**：上传那一对排在它后面，最后一次调用已经不是它了。
//   改成往回找那一条 —— 「某个动作落到哪」这件事本来就不该依赖调用顺序。
const qzoneDeleteCall = [...mock.calls].reverse().find((c) => c.action === 'delete_qzone_msg') || null;
ok('f) delete_qzone_msg 落到 /delete_qzone_msg，请求体逐字是 { tid }',
  Boolean(qzoneDeleteCall) && qzoneDeleteCall.action === 'delete_qzone_msg'
  && JSON.stringify(qzoneDeleteCall.body) === JSON.stringify({ tid: 'selftest-post-5a1c' }),
  qzoneDeleteCall ? qzoneDeleteCall.action + ' body=' + JSON.stringify(qzoneDeleteCall.body) : '无请求');
ok('f) delete_qzone_msg 之后 acting 记录里没有 tid（投影不比权威方便）',
  !JSON.stringify(ob.view(20)).includes('selftest-post-5a1c'),
  '扫了视图 ' + JSON.stringify(ob.view(20)).length + ' 字符');

// 第六片专属：上传的 file（本机路径 / base64 正文）一个字都不许进日志 / 视图 / 记录
// ★ 这条比 tid 那条更硬：路径里带用户名和目录，base64 里是**文件本身**。
const uploadEntriesBefore = ob.view().dedupe.entries;
const uploadProbePath = 'C:\\Users\\PRIVATE-UPLOAD-PATH-7f3a\\probe.pdf';
const uploadProbeB64 = 'PRIVATE-UPLOAD-BODY-9d2f1e';
const uploadProbeTap = tapOutput();
const rUp1 = await ob.act('upload_group_file', { group_id: 100, file: uploadProbePath, name: 'probe.pdf' });
const rUp2 = await ob.act('upload_private_file', { user_id: 200, file: 'base64://' + uploadProbeB64, name: 'probe.pdf' });
const uploadProbeLog = uploadProbeTap();
const uploadEntriesAfter = ob.view().dedupe.entries;
const uploadProbeView = JSON.stringify(ob.view(20));
ok('f) 上传一对：路由到各自的动作名，请求体逐字是 params',
  rUp1.ok === true && rUp2.ok === true
  && mock.calls.slice(-2)[0].action === 'upload_group_file'
  && mock.calls.slice(-2)[1].action === 'upload_private_file'
  && JSON.stringify(mock.calls.slice(-2)[0].body) === JSON.stringify({ group_id: 100, file: uploadProbePath, name: 'probe.pdf' })
  && JSON.stringify(mock.calls.slice(-2)[1].body) === JSON.stringify({ user_id: 200, file: 'base64://' + uploadProbeB64, name: 'probe.pdf' }),
  mock.calls.slice(-2).map((c) => c.action).join(' → '));
ok('f) 上传的路径 / base64 正文 / 文件名都不进日志与视图（只有动作名）',
  !uploadProbeLog.includes(uploadProbePath) && !uploadProbeLog.includes(uploadProbeB64)
  && !uploadProbeView.includes('PRIVATE-UPLOAD-PATH-7f3a') && !uploadProbeView.includes(uploadProbeB64)
  && !uploadProbeView.includes('probe.pdf')
  && uploadProbeLog.includes('upload_group_file'),
  '扫了 ' + uploadProbeLog.length + ' 字符日志 + 视图 ' + uploadProbeView.length + ' 字符');
ok('f) 上传的 timeoutMs=120000 原样生效（不是 30s 默认）',
  resolveActTimeoutMs(120000) === 120000 && resolveActTimeoutMs(120000) !== ACT_DEFAULT_TIMEOUT_MS,
  '120000 → ' + resolveActTimeoutMs(120000) + '，默认 ' + ACT_DEFAULT_TIMEOUT_MS);
ok('f) 上传不进幂等表（entries 在两次上传前后没有变化）',
  uploadEntriesBefore === uploadEntriesAfter,
  '上传前 ' + uploadEntriesBefore + ' → 上传后 ' + uploadEntriesAfter + '（这些条目来自之前的发消息，不是上传）');

// 第三片专属：头像的三种 file 形态 + 收藏表情的 emoji_id
const avatarForms = [
  'base64://iVBORw0KGgoAAAANSUhEUg',
  'C:\\Users\\pc\\AppData\\Local\\Temp\\avatar-9-1.jpg',
  'https://example.invalid/avatar.png',
];
const avatarGood = [];
for (const file of avatarForms) {
  const before = mock.calls.length;
  const r = await ob.act('set_qq_avatar', { file });
  const c = mock.calls[mock.calls.length - 1] || null;
  avatarGood.push(r.ok === true && mock.calls.length === before + 1 && Boolean(c)
    && c.action === 'set_qq_avatar' && String(c.body && c.body.file) === file);
}
ok('f) set_qq_avatar 三种 file 形态（base64 / 本机路径 / 网址）逐字到网关，一个字符都没改',
  avatarGood.every(Boolean),
  avatarGood.filter(Boolean).length + '/3');

const rFace = await ob.act('add_custom_face', { file: 'base64://QkM=' });
ok('f) add_custom_face 的 data.emoji_id 原样回来（stickers.js 拿它去写备注）',
  rFace.ok === true && Boolean(rFace.data) && String(rFace.data.emoji_id).startsWith('MOCK-EMOJI-'),
  'emoji_id=' + String(rFace.data && rFace.data.emoji_id));

// ── 第四片专属（2026-11-24）：好友申请审批的两个名字 ──────────────────────
// 三条要证的，缺一条这次迁移就不该算成立：
//   ① flag **逐字**进请求体（网关签发的凭据，改一个字符就是批了另一条申请）；
//   ② approve 保持布尔（true 通过 / false 拒绝），不许被压成 1/0 或 'false'；
//   ③ flag 与 approve 都不进日志 / 视图（标了谁、批没批，只看动作名读不出来）。
const FRIEND_SECRET_FLAG = 'SELFTEST-FLAG-PRIVATE-5a1c'
const friendParams = [
  ['set_friend_add_request', { flag: FRIEND_SECRET_FLAG, approve: true }],
  ['set_doubt_friends_add_request', { flag: FRIEND_SECRET_FLAG + '-doubt', approve: false }],
]
const friendGood = []
const friendTap = tapOutput()
for (const [action, params] of friendParams) {
  const before = mock.calls.length
  const r = await ob.act(action, params)
  const c = mock.calls[mock.calls.length - 1] || null
  const body = c ? c.body : null
  friendGood.push(
    r.ok === true && mock.calls.length === before + 1 && Boolean(c) && c.action === action
    && body && body.flag === params.flag && body.approve === params.approve
    && typeof body.approve === 'boolean',
  )
}
const friendLog = friendTap()
ok('f) set_friend_add_request / set_doubt_friends_add_request：flag 逐字、approve 仍是布尔',
  friendGood.every(Boolean), friendGood.filter(Boolean).length + '/2')
ok('f) 好友申请的 flag / approve 不进日志（记录里只有动作名）',
  friendLog.includes('set_friend_add_request') && !friendLog.includes(FRIEND_SECRET_FLAG)
  && !JSON.stringify(ob.view(20)).includes(FRIEND_SECRET_FLAG),
  '扫了 ' + friendLog.length + ' 字符日志 + 视图')

// 同一条申请批两次 = 两次请求（审批类不挂摘要幂等：去重会让「第一次失败」被静默吞掉）
const sameFlag = { flag: 'SELFTEST-SAME-FLAG-9e3b', approve: true }
const beforeSame = mock.calls.length
const sameA = await ob.act('set_friend_add_request', sameFlag)
const sameB = await ob.act('set_friend_add_request', sameFlag)
ok('f) 同一条好友申请批两次 → 网关收到两次（不进幂等表）',
  sameA.ok === true && sameB.ok === true && mock.calls.length === beforeSame + 2,
  '网关收到 ' + (mock.calls.length - beforeSame) + ' 次')

const titleNotice = [
  ['set_group_special_title', { group_id: 100, user_id: 200, special_title: '头衔' }],
  ['_send_group_notice', { group_id: 100, content: '公告' }],
];
const beforeTitleNotice = mock.calls.length;
const titleNoticeGood = [];
for (const [action, params] of titleNotice) {
  const result = await ob.act(action, params);
  const call = mock.calls[mock.calls.length - 1] || null;
  titleNoticeGood.push(result.ok === true && Boolean(call) && call.action === action
    && JSON.stringify(call.body) === JSON.stringify(params));
}
ok('f) title / notice 分别命中严格路由且参数逐字一致',
  titleNoticeGood.every(Boolean) && mock.calls.length === beforeTitleNotice + 2,
  titleNotice.map(([action]) => action).join(' / '));

// 白名单外：一个请求都不许出去
// ★ Qzone 评论走 strict ACT；like 及 ban/kick 仍被严格白名单拒绝。
const qzoneParams = { content: '一条仅自己可见的说说', ugc_right: 64 };
const beforeQzone = mock.calls.length; const qzoneDedupeBefore = ob.view().dedupe.entries;
const qzone1 = await ob.act('send_qzone_msg', qzoneParams);
const qzone2 = await ob.act('send_qzone_msg', qzoneParams);
const qzoneCalls = mock.calls.slice(beforeQzone);
ok('f) send_qzone_msg 走严格 ACT：params 原样，重复调用两次、无去重',
  qzone1.ok === true && qzone1.data.tid === 'mock-qzone-' + (beforeQzone + 1)
    && qzone2.ok === true && qzone2.data.tid === 'mock-qzone-' + (beforeQzone + 2)
    && qzoneCalls.length === 2 && qzoneCalls.every((call) => call.action === 'send_qzone_msg'
      && JSON.stringify(call.body) === JSON.stringify(qzoneParams))
    && ob.view().dedupe.entries === qzoneDedupeBefore,
  'calls=' + qzoneCalls.length + ' dedupe=' + ob.view().dedupe.entries);
const commentContent = 'COMMENT-CONTENT-MUST-NOT-LEAK-5a2d';
const commentParams = { tid: 'comment-post-1', content: commentContent, target_uin: 200 };
const beforeComment = mock.calls.length;
const commentTap = tapOutput();
const commentResult = await ob.act('comment_qzone', commentParams);
const commentLog = commentTap();
const commentCalls = mock.calls.slice(beforeComment);
const commentView = JSON.stringify(ob.view(20));
const commentStats = JSON.stringify(ob.stats());
ok('f) comment_qzone 走严格 ACT：请求恰好一次且 body 原样',
  commentResult.ok === true && commentCalls.length === 1 && commentCalls[0].action === 'comment_qzone'
    && JSON.stringify(commentCalls[0].body) === JSON.stringify(commentParams),
  'calls=' + commentCalls.length + ' action=' + (commentCalls[0] && commentCalls[0].action));
ok('f) comment content 不进入 outbox logs / views / records',
  !commentLog.includes(commentContent) && !commentView.includes(commentContent) && !commentStats.includes(commentContent),
  'log/view/stats content leak=' + [commentLog, commentView, commentStats].some((x) => x.includes(commentContent)));
const finalWriteRoutes = [
  ['set_group_ban', { group_id: 100, user_id: 200, duration: 600 }],
  ['set_group_ban', { group_id: 100, user_id: 200, duration: 0 }],
  ['set_group_kick', { group_id: 100, user_id: 200, reject_add_request: false }],
  ['like_qzone', { tid: 'post-1', target_uin: 200, abstime: 1732530000 }],
];
const finalDedupeBefore = ob.view().dedupe.entries;
const finalCallsBefore = mock.calls.length;
const finalWriteResults = [];
for (const [action, params] of finalWriteRoutes) {
  const result = await ob.act(action, params);
  const call = mock.calls[mock.calls.length - 1] || null;
  finalWriteResults.push(result.ok === true && Boolean(call) && call.action === action
    && JSON.stringify(call.body) === JSON.stringify(params));
}
ok('f) ban / unban / kick / like 各走一次ACT，body逐字且无幂等',
  finalWriteResults.every(Boolean) && mock.calls.length === finalCallsBefore + 4
    && ob.view().dedupe.entries === finalDedupeBefore,
  finalWriteRoutes.map(([action]) => action).join(' / '));

const beforeBan = mock.calls.length;
// ★ 第六片之后上传那一对已经进白名单，所以它们**不再**出现在这份「必须被拒」的清单里 ——
//   留在这里会变成一条永远绿的假测试。反向证据改由「群管理 ban/kick + like_qzone 仍被拒」承担。
const banNames = [
  ['set_group_ban_extra', { group_id: 100, user_id: 200, duration: 600 }],
  ['Set_Group_Ban', { group_id: 100, user_id: 200, duration: 600 }],
  ['set_group_kick_extra', { group_id: 100, user_id: 200 }],
  ['Like_Qzone', { tid: 'p-1' }],
  ['like_qzone_extra', { tid: 'p-1' }],
  // 上传的近似串仍然必须在外面（名字逐字相等）
  ['upload_file', { group_id: 100, file: 'x.pdf' }],
  ['Upload_Group_File', { group_id: 100, file: 'x.pdf' }],
];
const banResults = [];
for (const [action, params] of banNames) banResults.push([action, await ob.act(action, params)]);
ok('f) 未知动作/近似串全拒，网关一次都没收到',
  banResults.every(([, r]) => r.ok === false && /白名单/.test(String(r.error))) && mock.calls.length === beforeBan,
  banResults.map(([n, r]) => n + '=' + r.ok).join(' ') + '，网关多收 ' + (mock.calls.length - beforeBan) + ' 次');

// 业务失败：一次只记一次
const failedActBefore = ob.stats().failed;
const sentActBefore = ob.stats().sent;
mock.state.mode = 'retcode';
const rActFail = await ob.act('set_qq_profile', { nickname: '会被风控' });
mock.state.mode = 'ok';
ok('f) act 业务失败（retcode=100）→ ok:false、failed 只 +1、sent 不动',
  rActFail.ok === false && rActFail.retcode === 100
  && ob.stats().failed === failedActBefore + 1 && ob.stats().sent === sentActBefore,
  'failed ' + failedActBefore + ' → ' + ob.stats().failed + ' / sent=' + ob.stats().sent);

// mode=off：19 个ACT全拒，一个请求都不发（这道闸必须覆盖新动作）
const obOff = createOutbox({ mode: 'off', baseUrl: mock.url, token: TOKEN, timeoutMs: 500, register: false });
const beforeOff = mock.calls.length;
const offResults = [];
for (const [action, params] of [
  ['set_input_status', { user_id: 10001, event_type: 1 }],
  ['modify_custom_face', { emoji_id: 'E-1', desc: 'x' }],
  ['delete_custom_face', { emoji_id: 'E-2' }],
  ['set_self_longnick', { longNick: '签名' }],
  ['set_qq_profile', { nickname: '砚青' }],
  ['set_qq_avatar', { file: 'base64://YXZhdGFy' }],
  ['add_custom_face', { file: 'base64://QkM=' }],
  ['set_friend_add_request', { flag: 'off-flag-1', approve: true }],
  ['set_doubt_friends_add_request', { flag: 'off-flag-2', approve: false }],
  ['delete_qzone_msg', { tid: 'off-post-9e3b' }],
  ['upload_group_file', { group_id: 100, file: 'C:\\tmp\\off-a.pdf', name: 'a.pdf' }],
  ['upload_private_file', { user_id: 200, file: 'base64://QkM=', name: 'b.pdf' }],
  ['set_group_special_title', { group_id: 100, user_id: 200, special_title: '头衔' }],
  ['_send_group_notice', { group_id: 100, content: '公告' }],
  ['send_qzone_msg', { content: '仅自己可见', ugc_right: 64 }],
  ['comment_qzone', { tid: 'off-post', content: 'off 评论', target_uin: 200 }],
   ['set_group_ban', { group_id: 100, user_id: 200, duration: 600 }],
   ['set_group_kick', { group_id: 100, user_id: 200, reject_add_request: false }],
   ['like_qzone', { tid: 'off-like', target_uin: 200, abstime: 1732530000 }],
]) offResults.push(await obOff.act(action, params));
ok('f) mode=off + 已配置 baseUrl：19个全拒，网关一次都没收到',
  offResults.every((r) => r.ok === false) && mock.calls.length === beforeOff,
  '拒绝 ' + offResults.filter((r) => r.ok === false).length + '/19，网关多收 ' + (mock.calls.length - beforeOff) + ' 次');

// 参数（备注 / 表情 id）不许落进日志或视图
const probeEmoji = 'PROBE-EMOJI-9c1d';
const probeDesc = 'PROBE-DESC-7f3a';
const probeTap = tapOutput();
await ob.act('modify_custom_face', { emoji_id: probeEmoji, desc: probeDesc });
const probeLog = probeTap();
const probeView = JSON.stringify(ob.view(20));
ok('f) 资料动作的参数不进日志 / 视图（备注与表情 id 是用户内容）',
  !probeLog.includes(probeEmoji) && !probeLog.includes(probeDesc)
  && !probeView.includes(probeEmoji) && !probeView.includes(probeDesc) && !probeView.includes(TOKEN),
  '扫了 ' + probeLog.length + ' 字符日志 + 视图 ' + probeView.length + ' 字符');

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
