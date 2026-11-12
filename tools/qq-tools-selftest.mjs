// QQ 只读工具自检（第一批 8 个）—— 只打本地 mock，不连真 QQ、不读任何部署配置
//
// ★ 边界（这几条不是客气话，是证不了就别上线）：
//   · 不连 3000 / 3001 / 3002（活的 OneBot 网关），也不连 3100（活的桥接控制台）；
//   · 不读 D:\AI\SnowLuma\config\*，不读任何 config.json 里的 accessToken / consoleToken；
//   · 两个 mock 都 listen(0) 只绑 127.0.0.1；会话存储指向临时目录。
//
// ★ 六条要证的：
//   a) 每个要出口的工具，mock 回 {status:'ok',retcode:0,data} → 结构合法、不抛；
//   b) 网关 500 / 超时 / retcode≠0 / 端口没人 → 一律 {ok:false,error}，不抛；
//   c) 三个「说是不依赖网关」的工具，在没有 baseUrl 时也能**返回**（返回 ≠ 有数据，见下面的告示）；
//   d) 假 token 'TESTTOKEN' 到得了 mock（反向断言：正着断「没出现」是空断言），
//      且不出现在返回体 / view() / stdout 里；
//   e) 真 createServer 上 GET /api/qq → 200，响应里没有 token，工具清单 8 个；
//   f) 登记没漏：tools/list 的 TOOLS 与 write-manifest 的 MCP_TOOL_NAMES 逐名相同，
//      且 8 个都判成 write:false（只读）。
//
// 跑法：node tools/qq-tools-selftest.mjs

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOKEN = 'TESTTOKEN';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-soul-qq-selftest-'));
// ★ 必须在 import mcp-tools 之前设：它的 store() 会读 appRoot()/config.json，
//   而自检不该在仓库里造 data\sessions（那是「测一个读工具，顺手写了两个目录」）。
process.env.AGENT_SOUL_HOME = TMP;
process.env.AGENT_SOUL_SYNC = 'off';

// ── stdout 全量录一份（d 的后半条要靠它）──────────────────────────────
const origWrite = process.stdout.write.bind(process.stdout);
let captured = '';
process.stdout.write = function (chunk, enc, cb) {
  try { captured += typeof chunk === 'string' ? chunk : String(chunk); } catch {}
  return origWrite(chunk, enc, cb);
};

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n + (d ? '  ' + d : '')); }
  else { fail++; console.log('  ✗ ' + n + (d ? '  ' + d : '')); }
};
const head = (t) => console.log('\n' + t);

// ── mock OneBot（v11 HTTP 形状）────────────────────────────────────────
async function startMockOneBot() {
  const calls = [];
  const state = { mode: 'ok', delayMs: 0 };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
    const action = req.url.replace(/^\/+/, '').split('?')[0];
    calls.push({ action, body, auth: String(req.headers.authorization || ''), at: Date.now() });
    const send = (code, obj) => {
      try { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); } catch { /* 对端已掐断（超时用例） */ }
    };
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    if (state.mode === 'error500') return send(500, { status: 'failed', retcode: 1200, wording: 'mock 故意报错' });
    if (state.mode === 'retcode') return send(200, { status: 'failed', retcode: 100, wording: 'mock 风控拦截' });
    if (state.mode === 'badjson') { try { res.setHeader('content-type', 'text/plain'); res.end('not json'); } catch {} return; }
    if (action === 'get_login_info') return send(200, { status: 'ok', retcode: 0, data: { user_id: 10001, nickname: 'mock 机器人' } });
    if (action === 'get_status') return send(200, { status: 'ok', retcode: 0, data: { online: true, good: true } });
    if (action === 'get_group_list') return send(200, { status: 'ok', retcode: 0, data: [{ group_id: 661580035, group_name: 'mock 群' }, { group_id: 42, group_name: '另一个群' }] });
    if (action === 'get_group_member_list') return send(200, { status: 'ok', retcode: 0, data: [{ user_id: 7, nickname: '甲', card: '甲卡' }, { user_id: 8, nickname: '乙', card: '' }] });
    return send(200, { status: 'ok', retcode: 0, data: {} });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    calls,
    state,
    close: () => new Promise((r) => server.close(r)),
  };
}

// ── mock 桥接控制台（/api/socialV2/*）─────────────────────────────────
async function startMockConsole() {
  const calls = [];
  const state = { mode: 'ok' };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    calls.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), token: String(req.headers['x-agent-token'] || ''), at: Date.now() });
    const send = (code, obj) => {
      try { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); } catch {}
    };
    if (state.mode === 'error500') return send(500, { error: 'mock 控制台报错' });
    if (u.pathname === '/api/socialV2/recent') return send(200, { ok: true, messages: [{ seq: 3, text: '最近一条' }] });
    if (u.pathname === '/api/socialV2/unread') return send(200, { ok: true, unread: 2 });
    if (u.pathname === '/api/socialV2/slang/query') return send(200, { ok: true, items: [{ term: '笑死', meaning: '好笑' }] });
    if (u.pathname === '/api/socialV2/memory') return send(200, { ok: true, activeTopic: [{ content: 'mock 话题' }] });
    if (u.pathname === '/api/socialV2/state') return send(200, { ok: true, wakeConfig: { mode: 'diving' }, unread: 2, lastWakeReason: 'mock' });
    return send(404, { error: '没有这个 mock 路由：' + u.pathname });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    calls,
    state,
    close: () => new Promise((r) => server.close(r)),
  };
}

const onebot = await startMockOneBot();
const cs = await startMockConsole();
console.log('mock OneBot ' + onebot.url + ' · mock 控制台 ' + cs.url + '（都 listen(0)，只绑 127.0.0.1）');
console.log('临时 HOME ' + TMP);

const {
  QQ_READ_TOOLS, QQ_READ_TOOL_NAMES, createQqRuntime, setQqRuntime, qqRuntime,
} = await import('../src/adapters/qq/tools.mjs');
const { callTool, TOOLS } = await import('../src/adapters/mcp-tools.mjs');
const { MCP_TOOL_NAMES, classifyMcpCall } = await import('../src/security/write-manifest.mjs');
const { createQqClient, createQqConsoleClient } = await import('../src/adapters/qq/client.mjs');

// 生产形状的装配：token 只经「变量名」读进客户端
const rt = createQqRuntime({
  env: { QQ_ONEBOT_TOKEN: TOKEN, QQ_CONSOLE_TOKEN: TOKEN },
  onebot: { httpUrl: onebot.url, timeoutMs: 3000 },
  bridge: { baseUrl: cs.url, timeoutMs: 3000 },
});
setQqRuntime(rt);

const byName = (n) => QQ_READ_TOOLS.find((t) => t.name === n);

// ── a) 正常路径 ────────────────────────────────────────────────────────
head('a) mock 正常回 → 结构合法、不抛');
{
  const r = await byName('qq_status').run({});
  ok('qq_status：ok:true + user_id/nickname/online', r.ok === true && r.data.user_id === 10001 && r.data.nickname === 'mock 机器人' && r.data.online === true,
    JSON.stringify(r.data));
}
{
  const r = await byName('qq_list_groups').run({});
  ok('qq_list_groups：2 个群、形状 {group_id,group_name}', r.ok === true && r.count === 2 && r.groups[0].group_id === 661580035 && r.groups[0].group_name === 'mock 群',
    JSON.stringify(r.groups));
}
{
  const r = await byName('qq_get_group_members').run({ groupId: 661580035 });
  const sent = onebot.calls.filter((c) => c.action === 'get_group_member_list').pop();
  ok('qq_get_group_members：2 个成员，且 group_id 以**数字**发出',
    r.ok === true && r.count === 2 && r.members[0].user_id === 7 && sent && sent.body.group_id === 661580035,
    'body=' + JSON.stringify(sent && sent.body));
}
{
  const r = await byName('qq_get_recent_messages').run({ key: 'group:661580035', token: TOKEN, limit: 5, offset: 1 });
  const sent = cs.calls.filter((c) => c.path === '/api/socialV2/recent').pop();
  ok('qq_get_recent_messages：ok:true，且 key/limit/offset 真的进了 query',
    r.ok === true && sent && sent.query.key === 'group:661580035' && sent.query.limit === '5' && sent.query.offset === '1',
    sent ? JSON.stringify(sent.query) : '没打到 mock');
}
{
  const r = await byName('qq_get_unread_messages').run({ key: 'group:661580035', token: TOKEN });
  ok('qq_get_unread_messages：ok:true 且 data.unread 原样带回', r.ok === true && r.data.unread === 2);
}
{
  const r = await byName('qq_slang_query').run({ key: 'group:661580035', token: TOKEN, q: '笑' });
  const sent = cs.calls.filter((c) => c.path === '/api/socialV2/slang/query').pop();
  ok('qq_slang_query：ok:true 且 q 进了 query', r.ok === true && sent && sent.query.q === '笑', sent ? JSON.stringify(sent.query) : '没打到 mock');
}
{
  const r = await byName('qq_memory_query').run({ key: 'group:661580035', token: TOKEN, category: 'activeTopic' });
  ok('qq_memory_query：ok:true 且 category 进了 query', r.ok === true && r.data.activeTopic.length === 1);
}
{
  const r = await byName('qq_social_state').run({ key: 'group:661580035', token: TOKEN });
  ok('qq_social_state：在线读到 → source:live、stale:false', r.ok === true && r.source === 'live' && r.stale === false, 'source=' + r.source);
}

// ── b) 失败一律返回 ────────────────────────────────────────────────────
head('b) 网关/控制台失败 → {ok:false,error}，不抛');
const tryRun = async (name, args) => {
  let threw = null, r = null;
  try { r = await byName(name).run(args || {}); } catch (e) { threw = e; }
  return { threw, r };
};
{
  onebot.state.mode = 'error500';
  const { threw, r } = await tryRun('qq_status');
  ok('网关 500 → ok:false + code:QQ_HTTP，且不抛', !threw && r && r.ok === false && r.code === 'QQ_HTTP' && Boolean(r.error), threw ? String(threw.message) : r.code + ' / ' + String(r.error).slice(0, 40));
  onebot.state.mode = 'ok';
}
{
  onebot.state.mode = 'retcode';
  const { threw, r } = await tryRun('qq_list_groups');
  ok('HTTP 200 但 retcode≠0 → ok:false + code:QQ_RETCODE（不能当成功）', !threw && r && r.ok === false && r.code === 'QQ_RETCODE' && r.retcode === 100, r ? r.code + ' retcode=' + r.retcode : String(threw));
  onebot.state.mode = 'ok';
}
{
  onebot.state.mode = 'badjson';
  const { threw, r } = await tryRun('qq_list_groups');
  ok('回的不是 JSON → ok:false + code:QQ_BAD_BODY', !threw && r && r.ok === false && r.code === 'QQ_BAD_BODY', r ? r.code : String(threw));
  onebot.state.mode = 'ok';
}
{
  // 60ms 超时 vs 400ms 延迟：这是唯一能证明「超时也返回」的写法
  const fast = createQqRuntime({ env: { QQ_ONEBOT_TOKEN: TOKEN }, onebot: { httpUrl: onebot.url, timeoutMs: 60 }, bridge: { baseUrl: '', timeoutMs: 60 } });
  setQqRuntime(fast);
  onebot.state.delayMs = 400;
  const { threw, r } = await tryRun('qq_status');
  onebot.state.delayMs = 0;
  setQqRuntime(rt);
  ok('超时 → ok:false + code:QQ_TIMEOUT（和网络错分开报）', !threw && r && r.ok === false && r.code === 'QQ_TIMEOUT', r ? r.code : String(threw));
}
{
  const dead = http.createServer(() => {});
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const deadPort = dead.address().port;
  await new Promise((r) => dead.close(r));
  setQqRuntime(createQqRuntime({ env: {}, onebot: { httpUrl: 'http://127.0.0.1:' + deadPort, timeoutMs: 1500 }, bridge: { baseUrl: '' } }));
  const { threw, r } = await tryRun('qq_status');
  setQqRuntime(rt);
  ok('端口没人听 → ok:false + code:QQ_NETWORK，不抛', !threw && r && r.ok === false && r.code === 'QQ_NETWORK', r ? r.code : String(threw));
}
{
  cs.state.mode = 'error500';
  const { threw, r } = await tryRun('qq_get_recent_messages', { key: 'group:1', token: TOKEN });
  cs.state.mode = 'ok';
  ok('控制台 500 → ok:false + code:QQ_HTTP', !threw && r && r.ok === false && r.code === 'QQ_HTTP', r ? r.code : String(threw));
}
{
  const { threw, r } = await tryRun('qq_get_recent_messages', { key: 'not-a-session', token: TOKEN });
  ok('坏 key（不是 group:/private:）→ ok:false + QQ_BAD_ARG，且不发给控制台', !threw && r && r.ok === false && r.code === 'QQ_BAD_ARG', r ? r.code : String(threw));
}

// ── c) 三个「不依赖网关」的，在没有 baseUrl 时也能返回 ─────────────────
head('c) 没有 baseUrl 时也能返回（不抛）');
{
  // ★ 诚实告示：这一条证的是「不依赖 OneBot 网关、失败也返回结构化结果」，
  //   **不是**「它们能读到本地文件」—— 黑话/轻记忆/状态在本地根本没有文件，
  //   它们只能从桥接控制台读（见 adapters/qq/tools.mjs 头注释）。
  console.log('  （这一条证的是「不依赖网关且不抛」；它不等于「读得到数据」）');
  setQqRuntime(createQqRuntime({ env: {}, onebot: { httpUrl: '' }, bridge: { baseUrl: '' } }));
  const three = ['qq_slang_query', 'qq_memory_query', 'qq_social_state'];
  const got = [];
  let threwAny = null;
  for (const n of three) {
    try { got.push([n, await byName(n).run({ key: 'group:999' })]); } catch (e) { threwAny = e; }
  }
  ok('三个工具都没抛，且都返回了对象', !threwAny && got.length === 3 && got.every(([, r]) => r && typeof r === 'object'),
    threwAny ? String(threwAny.message) : got.map(([n, r]) => n + '=' + r.code).join(' '));
  ok('qq_slang_query → QQ_CONSOLE_UNCONFIGURED（不是抛，也不是「空库」）',
    got[0][1].ok === false && got[0][1].code === 'QQ_CONSOLE_UNCONFIGURED', got[0][1].code);
  ok('qq_memory_query → QQ_CONSOLE_UNCONFIGURED', got[1][1].ok === false && got[1][1].code === 'QQ_CONSOLE_UNCONFIGURED', got[1][1].code);
  // ★ 判据要能读出意思：code + stale + 错误话里真的带「读不到」三个字。
  //   「读不到」和「没有状态」是两件事，这一条就是钉住它俩不许混。
  ok('qq_social_state → QQ_STATE_UNCACHED + stale:true（「读不到」不许说成「没有状态」）',
    got[2][1].ok === false && got[2][1].code === 'QQ_STATE_UNCACHED' && got[2][1].stale === true && /读不到/.test(String(got[2][1].error || '')),
    got[2][1].code + ' stale=' + got[2][1].stale);
  setQqRuntime(rt);
}
{
  // 有缓存但在线读失败 → 给旧的，必须标 stale/source:cache（不假装是新的）
  cs.state.mode = 'error500';
  const { r } = await tryRun('qq_social_state', { key: 'group:661580035', token: TOKEN });
  cs.state.mode = 'ok';
  ok('在线读失败但有快照 → source:cache 且说明为什么', r && r.ok === true && r.source === 'cache' && typeof r.ageMs === 'number' && /在线读失败/.test(String(r.why || '')),
    r ? r.source + ' ageMs=' + r.ageMs : 'null');
}

// ── d) token 双向断言 ─────────────────────────────────────────────────
head('d) 假 token：到得了 mock（正向），但不出现在返回体 / view() / stdout（反向）');
{
  const statusCall = onebot.calls.filter((c) => c.action === 'get_login_info').pop();
  // ★ detail 里**不许**把 token 打出来：这条断言抓的就是「谁在漏 token」，
  //   而第一版就是我自己在 detail 里漏的 —— stdout 复检当场把它抓了。
  ok('正向：Authorization 头正好是 Bearer <token>', statusCall && statusCall.auth === 'Bearer ' + TOKEN,
    statusCall ? '已收到（值不回显，长度 ' + statusCall.auth.length + '）' : '没打到 mock');
  const stateCall = cs.calls.filter((c) => c.path === '/api/socialV2/state').pop();
  ok('正向：x-agent-token 头带着 <token>', stateCall && stateCall.token === TOKEN, stateCall ? (stateCall.token ? '收到（值不回显）' : '空') : '没打到 mock');

  const r1 = await byName('qq_status').run({});
  const r2 = await byName('qq_get_recent_messages').run({ key: 'group:661580035', token: TOKEN });
  const r3 = await byName('qq_social_state').run({ key: 'group:661580035', token: TOKEN });
  const blob = JSON.stringify([r1, r2, r3]);
  ok('反向：三个返回体里都没有 token', !blob.includes(TOKEN), blob.length + ' 字节返回体');
  const views = JSON.stringify([rt.client.view(), rt.bridge.view(), qqRuntime().client.view()]);
  ok('反向：client.view() / bridge.view() 里都没有 token', !views.includes(TOKEN), views.length + ' 字节视图');
  ok('view() 形状：configured / tokenSet / httpUrl / lastAt / calls 都在',
    ['configured', 'tokenSet', 'httpUrl', 'lastAt', 'calls'].every((k) => k in rt.client.view()) && rt.client.view().tokenSet === true && rt.client.view().calls > 0,
    JSON.stringify(rt.client.view()).slice(0, 120));
}
{
  // 没 token 时：给的是「缺令牌」，不是「没接线」
  const noTok = createQqRuntime({ env: {}, onebot: { httpUrl: onebot.url }, bridge: { baseUrl: cs.url } });
  setQqRuntime(noTok);
  const r = await byName('qq_get_recent_messages').run({ key: 'group:1' });
  setQqRuntime(rt);
  ok('有控制台但没令牌 → QQ_CONSOLE_TOKEN_MISSING（和「没接线」分开）', r.ok === false && r.code === 'QQ_CONSOLE_TOKEN_MISSING', r.code);
}

// ── 装配：没配环境变量时一条请求都不发 ─────────────────────────────────
head('装配：默认没配 → 一个请求都不发');
{
  const before = onebot.calls.length + cs.calls.length;
  setQqRuntime(createQqRuntime({ env: {} }));
  const r = await byName('qq_status').run({});
  setQqRuntime(rt);
  const after = onebot.calls.length + cs.calls.length;
  ok('默认 httpUrl 为空 → QQ_UNCONFIGURED，且网络调用数没变', r.ok === false && r.code === 'QQ_UNCONFIGURED' && after === before,
    'calls ' + before + ' → ' + after);
}

// ── e) 真 createServer 上的 GET /api/qq ────────────────────────────────
head('e) GET /api/qq（真 createServer，进程内 listen(0)）');
const { SessionStore } = await import('../src/session/store.mjs');
const { ToolRegistry } = await import('../src/tools/registry.mjs');
const { LlmClient } = await import('../src/llm/client.mjs');
const { AgentLoop } = await import('../src/agent/loop.mjs');
const { createServer } = await import('../src/web/server.mjs');
const { loadConfig } = await import('../src/config.mjs');
{
  const cfg = loadConfig();
  cfg.dataDir = path.join(TMP, 'data');
  const store = new SessionStore(cfg.dataDir);
  const tools = new ToolRegistry();
  const loop = new AgentLoop({ store, llm: new LlmClient(cfg.llm), tools, config: cfg });
  const srv = createServer({ store, loop, tools, config: cfg });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  try {
    const resp = await fetch(base + '/api/qq');
    const text = await resp.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = null; }
    ok('GET /api/qq → 200 + JSON', resp.status === 200 && body && body.port === 'qq-read-client', 'status=' + resp.status);
    ok('工具清单 8 个，且逐名对得上 QQ_READ_TOOLS', Array.isArray(body && body.tools) && body.tools.length === 8 && JSON.stringify(body.tools) === JSON.stringify(QQ_READ_TOOL_NAMES),
      body ? body.tools.length + ' 个' : 'null');
    ok('路由读的就是同一个 runtime（不是另算一份）', body && body.client.configured === true && body.client.calls === rt.client.view().calls,
      body ? 'configured=' + body.client.configured + ' calls=' + body.client.calls : 'null');
    ok('响应里没有 token', !text.includes(TOKEN), text.length + ' 字节');
    ok('响应里没有任何消息正文（只给接线状态与计数）', body && !('data' in body) && !JSON.stringify(body).includes('最近一条'));
  } finally {
    await new Promise((r) => srv.close(r));
  }
}

// ── f) 登记没漏 + 工具面接线 ───────────────────────────────────────────
head('f) 登记：tools/list ↔ manifest 逐名相同，8 个都判只读');
{
  const toolNames = TOOLS.map((t) => t.name).sort();
  const manNames = [...MCP_TOOL_NAMES].sort();
  ok('TOOLS 与 MCP_WRITE_MANIFEST 逐名相同（' + toolNames.length + ' 个）',
    toolNames.length === manNames.length && JSON.stringify(toolNames) === JSON.stringify(manNames),
    '只在 TOOLS：' + toolNames.filter((n) => !manNames.includes(n)).join(',') + ' · 只在 manifest：' + manNames.filter((n) => !toolNames.includes(n)).join(','));
  const allRead = QQ_READ_TOOL_NAMES.every((n) => classifyMcpCall(n, {}).write === false && classifyMcpCall(n, { action: 'whatever' }).write === false);
  ok('8 个全判 write:false（连「带个 action 参数」也判只读）', allRead);
  const schemaOk = TOOLS.filter((t) => t.name.startsWith('qq_')).every((t) => t.inputSchema && t.inputSchema.type === 'object' && t.inputSchema.properties && typeof t.description === 'string' && t.description.length > 10);
  ok('tools/list 里 8 个都有 object schema + 非空描述', schemaOk);
  const needKey = ['qq_get_recent_messages', 'qq_get_unread_messages', 'qq_slang_query', 'qq_memory_query', 'qq_social_state'];
  ok('五个会话工具都声明 key 为必填', needKey.every((n) => {
    const t = TOOLS.find((x) => x.name === n);
    return t && Array.isArray(t.inputSchema.required) && t.inputSchema.required.includes('key');
  }));
}
{
  // ★ 真正的接线证明：走 callTool 那条路，而且**不开会话存储**。
  //   ★ 第一版这里写错了断言前提：那时 runtime 还是接线的，跑到 mock 上当然成功 ——
  //     断言绿/红取决于「前面哪个用例留下什么状态」，那是最糟的一种断言。
  //     所以这里显式换成没接线的 runtime，让结果只由代码决定。
  setQqRuntime(createQqRuntime({ env: {}, onebot: { httpUrl: '' }, bridge: { baseUrl: '' } }));
  const r = await callTool('qq_slang_query', { key: 'group:1' });
  setQqRuntime(rt);
  ok('callTool 能分派到 qq 工具（返回 JSON 文本，不是抛 NO_TOOL）',
    typeof r === 'string' && JSON.parse(r).code === 'QQ_CONSOLE_UNCONFIGURED', String(r).slice(0, 60));
  let noTool = null;
  try { await callTool('qq_no_such_tool', {}); } catch (e) { noTool = e; }
  ok('不存在的 qq_* 不吞掉、照旧报错', noTool && (noTool.code === 'NO_TOOL' || /没有这个工具/.test(String(noTool.message))), noTool ? String(noTool.message).slice(0, 40) : '没抛');
}

await onebot.close();
await cs.close();

// ── d 的后半条：stdout 里没有 token ────────────────────────────────────
process.stdout.write = origWrite;
head('d) stdout 复检');
ok('整段 stdout 里没有出现过 token 字面量', !captured.includes(TOKEN), captured.length + ' 字节输出');
ok('captured 里确实有内容（不是因为没录到才「没出现」）', captured.length > 2000, captured.length + ' 字节');

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log('');
console.log('────────────────────────────────────────────');
console.log('通过 ' + pass + ' 项 · 失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
