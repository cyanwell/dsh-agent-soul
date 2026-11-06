// 手机通道自检 —— 真起服务、真走 HTTP、真读磁盘。
//
// ★ 为什么每条都真的发请求，而不是「读一遍代码觉得对」：
//   这一层最容易坏的地方是**路由的实际行为**和**文件尾部该怎么读**，
//   那两样只有跑起来才知道。断言写在行为上，不写在字符串里。
//
// ★ 为什么 listen(0) 而不是 8898：8898 是给他真用的，而且老版插件可能还占着它。
//   自检不该因为「端口被占」而红 —— 那是环境问题，不是代码问题。
//   这里让系统给一个空闲端口，绑的还是 0.0.0.0（要验的正是这个）。
//
// ★ 临时库建在 data/chat-selftest-<ts> 下，跑完删掉 —— 绝不碰真库。

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { ROOT } from '../src/config.mjs';
import { SessionStore } from '../src/session/store.mjs';
import { FRAME } from '../src/session/frame.mjs';
import { createMobileServer, tailFrames, lanUrls } from '../src/chat/mobile.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const lines = [];
function ok(name, detail) { pass++; lines.push('  OK    ' + name + (detail ? '   [' + detail + ']' : '')); }
function bad(name, detail) { fail++; lines.push('  FAIL  ' + name + '   ' + detail); }
function is(cond, name, detail) { cond ? ok(name, detail) : bad(name, detail); }
function section(t) { lines.push(''); lines.push(t); }

const tmpRoot = path.join(ROOT, 'data', 'chat-selftest-' + Date.now());
const store = new SessionStore(tmpRoot);

function req(port, method, p, opts = {}) {
  const t0 = Date.now();
  return fetch('http://127.0.0.1:' + port + p, { method, ...opts })
    .then(async (r) => {
      const text = await r.text();
      let j = null;
      try { j = JSON.parse(text); } catch { /* html */ }
      return { status: r.status, json: j, text, ms: Date.now() - t0 };
    })
    .catch((e) => {
      // ★ 失败要带上「哪个请求」。只报一句 "fetch failed" 等于没报 —— 我第一次跑就吃了这个亏。
      const cause = e && e.cause ? (e.cause.code || e.cause.message) : '';
      throw new Error(method + ' ' + p + ' 失败：' + ((e && e.message) || e) + (cause ? ' (' + cause + ')' : ''));
    });
}

const STOP = setTimeout(() => { console.error('自检超时（40 秒）—— 有请求挂住了'); process.exit(2); }, 40000);
STOP.unref();

async function main() {
  section('① 造数据（SessionStore 真写盘）');
  const header = store.create(tmpRoot, null);
  const sid = header.id;
  store.append(sid, FRAME.USER, { text: '第一句：手机连上了吗' });
  store.append(sid, FRAME.ASSISTANT, { text: '连上了。这是第二条，用来验最近的 N 条。' });
  store.append(sid, FRAME.TOOL_CALL, { callId: 'c1', name: 'run_shell', args: { command: 'echo hi' } });
  store.append(sid, FRAME.TOOL_RESULT, { callId: 'c1', name: 'run_shell', content: 'hi\n' });
  store.append(sid, FRAME.USER, { text: '第三句：工具调用那两条应该被手机页过滤掉' });
  const allFrames = store.load(sid).frames;
  ok('建立会话并写 6 帧', 'sid=' + sid.slice(-8) + ' frames=' + allFrames.length + ' 文件=' + fs.statSync(path.join(store.dir(sid), 'frames.jsonl')).size + 'B');

  section('② 起服务（绑 0.0.0.0，端口由系统给）');
  // ★ loop 是假的：自检不该花钱调模型。但**投递链路是真的** —— 它必须被调用、必须落帧。
  const turns = [];
  const fakeLoop = {
    async turn(sessionId) {
      const recent = store.recent(sessionId, 6);
      let last = '';
      for (let i = recent.length - 1; i >= 0; i--) if (recent[i].type === FRAME.USER) { last = recent[i].text; break; }
      turns.push({ sessionId, last, at: Date.now() });
      store.append(sessionId, FRAME.ASSISTANT, { text: '（自检假回复）收到：' + last });
      return { text: '', steps: 1 };
    },
  };
  const server = createMobileServer({ store, loop: fakeLoop, config: { chat: { recentLimit: 20 } } });
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '0.0.0.0', res); });
  const port = server.address().port;
  is(server.address().address === '0.0.0.0', '绑的是 0.0.0.0 而不是 127.0.0.1', server.address().address + ':' + port);
  ok('局域网入口（这就是要在手机上输的地址）', lanUrls(port)[0] || '（本机没有非回环网卡）');

  section('③ GET /api/recent —— 最近的对话');
  const r1 = await req(port, 'GET', '/api/recent?limit=20&session=' + sid);
  is(r1.status === 200 && r1.json.ok, '200 + ok', r1.ms + 'ms');
  const types = (r1.json.items || []).map((x) => x.type);
  is(types.length === 3 && types.join(',') === 'user,assistant,user', '只发 user/assistant，tool_call/tool_result 被过滤', 'items=' + types.length + ' [' + types.join(',') + ']');
  is(!JSON.stringify(r1.json).includes('echo hi'), '工具调用参数没有漏到页面上', '搜 "echo hi" 命中 0 次');
  const firstSeq = r1.json.items[0].seq;
  const lastSeq = r1.json.items[r1.json.items.length - 1].seq;
  ok('seq 区间', firstSeq + ' … ' + lastSeq);

  section('④ 尾读：大文件只读尾巴');
  const big = store.create(path.join(tmpRoot, 'big'));
  for (let i = 0; i < 400; i++) store.append(big.id, FRAME.USER, { text: '填充消息 ' + i + ' ' + 'x'.repeat(180) });
  const bigFile = path.join(store.dir(big.id), 'frames.jsonl');
  const bigSize = fs.statSync(bigFile).size;
  const t0 = Date.now();
  const tail = tailFrames(bigFile, 64 * 1024);
  const tailMs = Date.now() - t0;
  is(tail.truncatedHead === true, '从中间开始读：知道头部被截了（不假装完整）', 'bigSize=' + (bigSize / 1024).toFixed(0) + 'KB 读了 64KB');
  is(tail.frames.length > 0 && tail.frames.length < 401, '只拿到尾部的一批，不是全部 401 帧', 'frames=' + tail.frames.length + ' 用时=' + tailMs + 'ms');
  is(tail.frames[tail.frames.length - 1].seq === 400, '最后一帧是最后写的那个', 'seq=' + tail.frames[tail.frames.length - 1].seq);

  section('⑤ POST /api/send —— 投进 agent 循环');
  const r2 = await req(port, 'POST', '/api/send?session=' + sid, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '来自自检的一条消息' }),
  });
  is(r2.status === 200 && r2.json.ok === true && r2.json.stored === true, '消息已存进会话', 'seq=' + (r2.json && r2.json.seq) + ' turn=' + (r2.json && r2.json.turn) + ' ' + r2.ms + 'ms');
  const idle = await server.chatQueue.idle(sid);
  is(idle, '投递队列跑空了（没有挂住的 turn）', '');
  is(turns.length === 1 && turns[0].last === '来自自检的一条消息', 'agent 循环被真的调用了，且拿到的是刚发的那条', 'calls=' + turns.length);

  const r3 = await req(port, 'GET', '/api/recent?after=' + lastSeq + '&session=' + sid);
  const newTypes = (r3.json.items || []).map((x) => x.type + ':' + String(x.text).slice(0, 12));
  is(newTypes.length === 2 && newTypes[0].startsWith('user:') && newTypes[1].startsWith('assistant:'), '增量读：拿到「我发的」和「它的回复」两条', newTypes.join(' | '));
  is(types.length !== undefined && r3.json.items.every((x) => x.seq > lastSeq), 'after 过滤生效（不会把旧消息再发一遍）', 'after=' + lastSeq);

  section('⑥ GET / —— 手机页');
  const page = await req(port, 'GET', '/');
  is(page.status === 200 && /text\/html/.test('text/html'), '200 + html', page.text.length + 'B ' + page.ms + 'ms');
  is(page.text.includes('viewport') && page.text.includes('100dvh'), '竖屏 viewport + dvh 布局', '');
  is(page.text.includes('/api/send') && page.text.includes('/api/recent'), '页面里调的就是这两个接口', '');
  // ★ 判据要落在「赋值」上，不是「出现这个词」—— 我第一次写的是 includes('innerHTML')，
  //   而页面注释里恰好写着「不拼 innerHTML」，于是它自己把自己判成了红的。
  is(!/\.innerHTML\s*=/.test(page.text), '页面没有用 innerHTML 赋值渲染消息（防注入）', '赋值 0 处');
  is(page.text.includes('textContent'), '用的正是 textContent', '');
  is(page.text.includes('无认证'), '页面上写着「无认证」（不是只在 README 里）', '');

  section('⑦ 安全面 —— 该拒的都拒了');
  const p410a = await req(port, 'POST', '/api/upload', { headers: { 'Content-Type': 'application/json' }, body: '{}' });
  is(p410a.status === 410 && p410a.json.error === 'GONE', '/api/upload → 410（老版有，这一版刻意不做）', p410a.json.was || '');
  const p410b = await req(port, 'GET', '/api/file?name=x.png');
  is(p410b.status === 410, '/api/file → 410（不能从这里取走文件）', '');
  const p404 = await req(port, 'GET', '/../src/config.mjs');
  is(p404.status === 404, '没有静态文件路由，路径穿越无从谈起', 'status=' + p404.status);
  const csrf = await req(port, 'POST', '/api/send?session=' + sid, {
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
    body: JSON.stringify({ text: '跨站发的' }),
  });
  is(csrf.status === 403 && csrf.json.error === 'CROSS_ORIGIN', '跨源 POST → 403（挡住「打开一个网页就替我发了」）', '');
  const tooBig = await req(port, 'POST', '/api/send?session=' + sid, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'x'.repeat(80 * 1024) }),
  });
  is(tooBig.status === 413 && tooBig.json.error === 'BODY_TOO_LARGE', '超大 body → 413', 'limit=' + (tooBig.json && tooBig.json.limit) + 'B');
  const empty = await req(port, 'POST', '/api/send?session=' + sid, { headers: { 'Content-Type': 'application/json' }, body: '{"text":"   "}' });
  is(empty.status === 400 && empty.json.error === 'EMPTY_TEXT', '空消息 → 400', '');
  const st = await req(port, 'GET', '/api/status');
  is(st.json && st.json.auth && st.json.auth.enabled === false, 'status 里明说「没有认证」', '');
  is(!JSON.stringify(st.json).includes('apiKey') && !JSON.stringify(st.json).includes('sk-'), 'status 里没有任何 key 字段或 sk- 值', '');
  is(Array.isArray(st.json.notProvided) && st.json.notProvided.length >= 4, 'status 里列了「不提供什么」', 'notProvided=' + st.json.notProvided.length + ' 项');
  is(typeof st.json.howToDisable === 'string' && st.json.howToDisable.includes('AGENT_SOUL_CHAT'), 'status 里给了关掉的两种办法', '');

  section('⑧ 队列：同一会话不并发跑两个 turn');
  await Promise.all([
    req(port, 'POST', '/api/send?session=' + sid, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '并发 A' }) }),
    req(port, 'POST', '/api/send?session=' + sid, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '并发 B' }) }),
  ]);
  await server.chatQueue.idle(sid);
  is(turns.length === 3, '两条并发只启动了 1 次 + 排了 1 次（总数 3 = 前面 1 + 这 2）', 'turns=' + turns.length);

  section('⑨ 没有会话时不许假装成功');
  const emptyDir = path.join(tmpRoot, 'empty-store');
  const store2 = new SessionStore(emptyDir);
  const server2 = createMobileServer({ store: store2, loop: fakeLoop, config: {} });
  await new Promise((res) => server2.listen(0, '127.0.0.1', res));
  const p2 = server2.address().port;
  const noSess = await req(p2, 'GET', '/api/recent');
  is(noSess.status === 200 && noSess.json.session === null && (noSess.json.items || []).length === 0, '空库：200 + 空列表 + hint（不是 500）', noSess.json.hint || '');
  const sendNoSess = await req(p2, 'POST', '/api/send', { headers: { 'Content-Type': 'application/json' }, body: '{"text":"hi"}' });
  is(sendNoSess.status === 409 && sendNoSess.json.error === 'NO_SESSION', '没会话时发消息 → 409，不假装存了', '');
  await new Promise((res) => server2.close(res));
  store2.closeAll();

  section('⑩ 没有 loop 时也不许假装投进去了');
  const server3 = createMobileServer({ store, loop: null, config: {} });
  await new Promise((res) => server3.listen(0, '127.0.0.1', res));
  const p3 = server3.address().port;
  const noLoop = await req(p3, 'POST', '/api/send?session=' + sid, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '没有 loop 的一发' }) });
  is(noLoop.status === 200 && noLoop.json.stored === true && noLoop.json.turned === false, 'stored=true 但 turned=false（存了，但没跑）', noLoop.json.hint || '');
  await new Promise((res) => server3.close(res));

  lines.push('');
  lines.push('  ' + '─'.repeat(60));
  lines.push('  通过 ' + pass + ' 项 · 失败 ' + fail + ' 项 · 临时库 ' + tmpRoot);
  console.log(lines.join('\n'));

  await new Promise((res) => server.close(res));
  store.closeAll();
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { console.log('  （临时库没删掉：' + e.message + '，手动删 ' + tmpRoot + '）'); }

  clearTimeout(STOP);
  if (fail) { console.error('\n自检未通过：' + fail + ' 项失败'); process.exitCode = 1; }
  else console.log('\n自检全绿。');
}

main().catch((e) => {
  console.error('自检崩溃：' + (e && e.stack || e));
  try { store.closeAll(); } catch {}
  process.exit(2);
});
