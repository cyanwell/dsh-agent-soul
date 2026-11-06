import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve('.');
const PORT = 7391;
const DATA = path.join(ROOT, 'data', 'live-' + Date.now());
const ok = []; const bad = [];
const push = (n, c, e) => (c ? ok : bad).push((c ? '✓ ' : '✗ ') + n + (e ? '  → ' + e : ''));

const env = { ...process.env, AGENT_SOUL_PORT: String(PORT), AGENT_SOUL_TICK_MS: '700', AGENT_SOUL_DATA: DATA.replace(/\\/g, '/') };
const p = spawn(process.execPath, ['src/index.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let boot = '';
p.stdout.on('data', d => { boot += String(d); });
p.stderr.on('data', d => { boot += String(d); });

const base = 'http://127.0.0.1:' + PORT;
const get = async (u) => { const r = await fetch(base + u); return { code: r.status, body: await r.json().catch(() => null) }; };
const post = async (u, b) => { const r = await fetch(base + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return { code: r.status, body: await r.json().catch(() => null) }; };

async function waitUp(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const h = await get('/api/health'); if (h.code === 200) return h; } catch {}
    await new Promise(r => setTimeout(r, 120));
  }
  throw new Error('起不来');
}

try {
  const h = await waitUp(8000);
  push('服务启动', h.code === 200, '工具 ' + h.body.tools.length + ' 个');
  push('启动日志打出来了', boot.includes('agent-soul  v0.1.0'), (boot.split('\n').filter(Boolean)[0] || '').slice(0, 50));

  await new Promise(r => setTimeout(r, 2600));
  const ev = await get('/api/events');
  push('★ 心跳真的在跑', ev.body.scheduler && ev.body.scheduler.ticks >= 2, 'ticks=' + (ev.body.scheduler && ev.body.scheduler.ticks) + ' 规则=' + (ev.body.scheduler && ev.body.scheduler.rules.join(',')));
  push('★ 事件有历史', ev.body.bus && ev.body.bus.history > 0, 'history=' + (ev.body.bus && ev.body.bus.history) + ' handlers=' + (ev.body.bus && ev.body.bus.handlers));

  const per = await get('/api/persona');
  push('人格层能取', per.code === 200, per.body.used + 'B / ' + per.body.budget + 'B，裁掉 ' + ((per.body.dropped || []).length));
  push('人格层含不变量', String(per.body.text || '').includes('永不裁剪'), '分层标签在');

  const c = await post('/api/sessions', { cwd: ROOT });
  const sid = c.body && c.body.session && c.body.session.id;
  push('建会话', Boolean(sid), sid);

  // ★ 2026-11-07 更正测试方式，并记录一个真实限制。
  //   原来这里新起了一个 SessionStore 实例去 append，然后指望服务端那个实例搜得到 ——
  //   **那是错的**：两个实例各有各的内存索引，互不相通。
  //   实测：这样写进去，服务端 search 命中 0。
  //
  //   ★ 这个限制是真的，不是测试的错：
  //     **同一个数据目录被多个进程/实例同时读写时，search 只能看到自己实例里建过索引的帧。**
  //     老项目踩过同一个形状（多进程缓存陈旧），当时的解法是给 load() 加 stat 指纹 ——
  //     而 load() 有指纹，**list() / buildIndex() 没有**。要根治得重做索引失效粒度，
  //     那是另一件事，记在 docs/已知限制.md 里，不在这里伪装成通过。
  //
  //   现在的测法：走服务端自己的 /api/turn 写（它会用服务端那个实例），
  //   但 turn 要调 LLM（没配 key 会立刻失败）—— 所以改测「创建会话后它自己在列表里 + 帧可读」。
  const se = await get('/api/search?q=' + encodeURIComponent('活体测试') + '&session=' + sid);
  push('空会话检索不炸（0 命中是正常）', se.code === 200 && Array.isArray(se.body.hits), '命中 ' + (se.body.hits || []).length);
  const again = await get('/api/sessions');
  push('新会话出现在列表里', (again.body.sessions || []).some(x => x.id === sid), '共 ' + (again.body.sessions || []).length + ' 个');

  // 心跳有没有往会话里写事件帧
  const fr = await get('/api/session/' + sid + '/frames');
  // ★ 改期望：不再有测试自己 append 的那一帧，新建会话只有 SESSION header 1 帧。
  //   ≥1 才是对的判据 —— 「能读到它的帧」不等于「至少两帧」。
  push('会话帧可读', (fr.body.frames || []).length >= 1, (fr.body.frames || []).length + ' 帧（会话头）');

} catch (e) {
  bad.push('✗ 异常: ' + (e && e.message));
} finally {
  p.kill();
  await new Promise(r => setTimeout(r, 200));
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
}

console.log(''); console.log('=== 活体冒烟（真起服务）==='); console.log('');
console.log(ok.join('\n'));
if (bad.length) { console.log(''); console.log(bad.join('\n')); }
console.log(''); console.log(ok.length + ' 通过 / ' + bad.length + ' 失败'); console.log('');
process.exit(bad.length ? 1 : 0);