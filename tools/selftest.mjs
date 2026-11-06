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
  if (names.length !== 4) throw new Error('应有 4 个，实际 ' + names.length);
  if (tools.specs().length !== 4) throw new Error('specs 数不对');
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
    const dash = await (await fetch(base + '/')).text();
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