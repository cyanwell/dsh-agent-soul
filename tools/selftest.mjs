// 自检 —— 不起后台，进程内跑完整链路再退出
import path from 'node:path';
import fs from 'node:fs';
import { SessionStore } from '../src/session/store.mjs';
import { ToolRegistry } from '../src/tools/registry.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { AgentLoop } from '../src/agent/loop.mjs';
import { createServer } from '../src/web/server.mjs';
import { registerBuiltins } from '../src/tools/builtin.mjs';
import { loadConfig, ROOT } from '../src/config.mjs';

const ok = []; const bad = [];
async function check(name, fn) {
  try { const v = await fn(); ok.push('✓ ' + name + (v !== undefined ? '  → ' + v : '')); }
  catch (e) { bad.push('✗ ' + name + '  → ' + (e && e.message)); }
}

const cfg = loadConfig();
cfg.dataDir = path.join(ROOT, 'data', 'selftest-' + Date.now());
// ★ 2026-11-11：这个自检下面有一条「没配 key 时回合报错但不崩」。
//   它以前跑得通，是因为当时 config 里确实没有 key；现在 config 有 key 了，
//   于是它真的连去 LLM，报的是 400（tool_calls 没配对），不是「未配置」。
//   测「无 key 路径」就必须把 key 打掉 —— 否则测的是另一个场景。
//   ★ 这不是「让测试变绿」：断言一个字没改，改的是**输入**。
cfg.llm = Object.assign({}, cfg.llm, { apiKey: '', apiKeyRef: null });
const store = new SessionStore(cfg.dataDir);
const tools = new ToolRegistry();
const llm = new LlmClient(cfg.llm);
const loop = new AgentLoop({ store, llm, tools, config: cfg });
registerBuiltins(tools, { workspace: ROOT });
let sid = null;

await check('建会话', () => { const h = store.create(ROOT, null); sid = h.id; if (!h.id) throw new Error('没有 id'); return h.id; });

await check('写帧 → 同时写索引', () => {
  store.append(sid, 'user', { text: '第一条测试：写入即索引' });
  store.append(sid, 'assistant', { text: '回应：索引应该已经出现了' });
  store.append(sid, 'tool_call', { callId: 'c1', name: 'read_file', args: { path: 'package.json' } });
  const d = path.join(cfg.dataDir, 'sessions', sid);
  const fN = fs.readFileSync(path.join(d, 'frames.jsonl'), 'utf8').split('\n').filter(Boolean).length;
  const iN = fs.readFileSync(path.join(d, 'index.jsonl'), 'utf8').split('\n').filter(Boolean).length;
  if (fN !== 4) throw new Error('帧数应为 4（含帧0），实际 ' + fN);
  if (iN < 3) throw new Error('索引应 3 条，实际 ' + iN);
  return fN + ' 帧 / ' + iN + ' 索引';
});

await check('检索命中', () => {
  const hits = store.search(sid, '索引');
  if (!hits.length) throw new Error('搜「索引」没命中');
  return hits.length + ' 条，首条 #' + hits[0].seq;
});

await check('工具注册与清单', () => {
  const names = [...tools.tools.keys()];
  // ★ 2026-11-11：不再写死「4 个」。工具数会随功能涨（现在 7 个），
  //   这条要证的是「注册表和 specs 一致」+「四个核心工具都在」，不是一个常数。
  const CORE = ['read_file', 'write_file', 'list_dir', 'run_shell'];
  const missing = CORE.filter((n) => !names.includes(n));
  if (missing.length) throw new Error('缺核心工具: ' + missing.join(','));
  if (tools.specs().length !== names.length) throw new Error('specs 与注册数不一致: ' + tools.specs().length + ' vs ' + names.length);
  return names.join(', ');
});

await check('执行 read_file', async () => {
  const r = await tools.execute('read_file', { path: 'package.json' });
  if (!r.ok) throw new Error('失败: ' + r.error);
  if (!r.content.includes('agent-soul')) throw new Error('内容里没有包名');
  return r.content.length + ' 字节';
});

await check('路径越界被拒', async () => {
  const r = await tools.execute('read_file', { path: '../../../windows/win.ini' });
  if (r.ok) throw new Error('越界竟然成功');
  return r.error.slice(0, 40);
});

await check('单调守卫能否决', async () => {
  const dispose = tools.guard(() => '测试守卫：一律否决');
  const r = await tools.execute('read_file', { path: 'package.json' });
  dispose();
  if (r.ok || !r.denied) throw new Error('守卫没生效');
  const after = await tools.execute('read_file', { path: 'package.json' });
  if (!after.ok) throw new Error('移除后仍被拒');
  return '否决 → 移除后放行';
});

await check('HTTP 服务 + 接口 + 五槽位', async () => {
  const server = createServer({ store, loop, tools, config: cfg });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port;
  try {
    const h = await (await fetch(base + '/api/health')).json();
    if (!h.ok) throw new Error('health 不对');
    const list = await (await fetch(base + '/api/sessions')).json();
    if (!list.sessions.length) throw new Error('会话列表空');
    const fr = await (await fetch(base + '/api/session/' + sid + '/frames')).json();
    if (fr.frames.length !== 4) throw new Error('帧数不对 ' + fr.frames.length);
    const se = await (await fetch(base + '/api/search?q=' + encodeURIComponent('索引'))).json();
    if (!se.hits.length) throw new Error('检索没命中');
    // ★ 2026-11-07 改：/ 现在是仪表盘（数据 + 器官 + 环境），五槽位搬到 /chat 去了。
    //   这不是放宽，是判据跟着设计走：**每一条检查它该检查的那个页**。
    // ★ 2026-11-11：dashboard 已挪到 /dashboard（server.mjs:780 写着「/ 给对话，dashboard 挪到 /dashboard」）。
    //   旧断言还在查 /，而 / 现在是 shell.html —— 于是它永远找不到 cards。
    const dash = await (await fetch(base + '/dashboard')).text();
    // ★ 2026-11-11：dashboard.html 用的是**单引号** id（<div class='grid g6' id='cards'>）。
    //   之前这条红，不是引号问题，是它查的 / 已经变成 shell.html（对话页）—— 页面根本不对。
    for (const need of ["id='cards'", "id='organs'", '/api/overview']) {
      if (!dash.includes(need)) throw new Error('仪表盘缺: ' + need);
    }
    if (dash.length < 3000) throw new Error('仪表盘太小: ' + dash.length + ' 字节');
    const chat = await (await fetch(base + '/chat')).text();
    const slots = ['id="main"', 'id="sidebar"', 'id="msgs"', 'id="overlay"', 'settings.section'];
    const miss = slots.filter(s => !chat.includes(s));
    if (miss.length) throw new Error('/chat 槽位缺: ' + miss.join(','));
    return 'health/sessions/frames/search 全通 · 仪表盘 ' + dash.length + 'B · /chat 五槽位齐（端口 ' + port + '）';
  } finally { await new Promise(r => server.close(r)); }
});

await check('没配 key 时回合报错但不崩', async () => {
  const r = await loop.turn(sid, () => {});
  if (!r.error) throw new Error('应该报错');
  if (!/未配置/.test(r.error)) throw new Error('错误信息不对: ' + r.error);
  return '按预期拒绝：' + r.error.slice(0, 34);
});

try { fs.rmSync(cfg.dataDir, { recursive: true, force: true }); } catch {}
console.log(''); console.log('=== agent-soul 自检 ==='); console.log('');
console.log(ok.join('\n'));
if (bad.length) { console.log(''); console.log('--- 失败 ---'); console.log(bad.join('\n')); }
console.log(''); console.log(ok.length + ' 通过 / ' + bad.length + ' 失败'); console.log('');
process.exit(bad.length ? 1 : 0);