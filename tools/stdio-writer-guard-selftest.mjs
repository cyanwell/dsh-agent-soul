// stdio 写者收口自检（2026-11-09）
//
// ★ 这个自检只证明一件事：**这台机器上不会同时有两个写者。**
//   所以它全部在临时目录 + 随机端口里跑，**不碰 7310、不碰生产 data**：
//     · SOUL_HUB_URL 指向一个随机端口的假主服务（或在测试里把它关掉）
//     · AGENT_SOUL_DATA 指向 mkdtemp 出来的临时目录
//     · 生产账本只**数行数**（读），前后必须一模一样
//
// 五个场景：
//   1) 假主服务在线  → tools/call 全部转发，本进程不建任何 jsonl
//   2) 主服务不在线  → 写工具 SOUL_OFFLINE/rejected，账本行数不变
//   3) 主服务不在线  → 读工具仍返回（只读打开）+ 挂 degraded 块
//   4) 主服务中途挂掉 → 报错，**绝不静默写本机**
//   5) SOUL_STDIO_MODE 显式 proxy / standalone → 行为可强制，用来对照
//
// 跑法：node tools/stdio-writer-guard-selftest.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP = path.join(ROOT, 'src/adapters/mcp.mjs');
const PROD_LEDGER = 'D:/AI/yanqing-soul/02-墨.jsonl';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-stdio-guard-'));

const ok = [];
const bad = [];
function push(name, cond, extra) {
  (cond ? ok : bad).push((cond ? '✓ ' : '✗ ') + name + (extra ? '  → ' + extra : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ledgerLines() {
  try { return fs.readFileSync(PROD_LEDGER, 'utf8').split('\n').filter(Boolean).length; }
  catch { return -1; }
}
function jsonlFiles(dir) {
  const out = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(jsonl|json|cache|fp)$/.test(e.name)) out.push(f);
    }
  };
  walk(dir);
  return out;
}

/** 假主服务：认 /api/health 与 /mcp，把收到的每条 tools/call 记下来。 */
function fakeHub() {
  const hub = { calls: [], probes: 0, hits: [] };
  hub.srv = http.createServer((req, res) => {
    const u = (req.url || '').split('?')[0];
    if (u === '/api/health') {
      hub.probes++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, sessions: 1, tools: ['soul_ledger'], model: 'fake' }));
    }
    if (u === '/mcp' && req.method === 'POST') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let msg = null;
        try { msg = JSON.parse(body); } catch {}
        hub.hits.push({ method: msg && msg.method, name: msg && msg.params && msg.params.name });
        const method = msg && msg.method;
        const id = msg && msg.id;
        if (method === 'tools/call') {
          const name = (msg.params && msg.params.name) || '';
          hub.calls.push({ name, args: (msg.params && msg.params.arguments) || {} });
          const text = 'FAKE-HUB 已处理 ' + name + ' :: ' + JSON.stringify((msg.params && msg.params.arguments) || {});
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id, result: {} }));
      });
      return;
    }
    res.writeHead(404); res.end('nope');
  });
  hub.start = () => new Promise((resolve) => hub.srv.listen(0, '127.0.0.1', () => {
    hub.port = hub.srv.address().port;
    hub.url = 'http://127.0.0.1:' + hub.port;
    resolve(hub);
  }));
  hub.stop = () => new Promise((resolve) => {
    try { hub.srv.closeAllConnections && hub.srv.closeAllConnections(); } catch {}
    hub.srv.close(() => resolve());
  });
  return hub;
}

/** 拿一个「确定没人监听」的端口：开一个临时 server 记下端口再关掉。 */
function deadPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

/** 起一个 stdio MCP 子进程（就是 DSH 起的那条腿），行分隔 JSON-RPC。 */
function startServer(env) {
  const clean = { ...process.env };
  for (const k of ['SOUL_STDIO_MODE', 'SOUL_HUB_URL', 'AGENT_SOUL_DATA', 'SOUL_PROBE_TTL_MS', 'SOUL_PROBE_TIMEOUT_MS']) delete clean[k];
  const child = spawn(process.execPath, [MCP], { cwd: ROOT, env: { ...clean, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const h = { child, out: '', err: '', seq: 0, closed: false };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { h.out += d; });
  child.stderr.on('data', (d) => { h.err += d; });
  child.on('exit', () => { h.closed = true; });
  h.rpc = (method, params) => {
    const id = ++h.seq;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return id;
  };
  h.waitFor = (id, ms = 12000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      for (const line of h.out.split('\n')) {
        if (!line.trim()) continue;
        let m = null;
        try { m = JSON.parse(line); } catch { continue; }
        if (m && m.id === id) { resolve(m); return; }
      }
      if (Date.now() - t0 > ms) { reject(new Error('等 id=' + id + ' 超时；stderr=' + h.err.trim())); return; }
      setTimeout(tick, 40);
    };
    tick();
  });
  h.call = async (name, args) => {
    const id = h.rpc('tools/call', { name, arguments: args || {} });
    return h.waitFor(id);
  };
  h.stop = () => { try { child.kill(); } catch {} };
  return h;
}

/** 从 result 里抠出正文与结构化尾巴。 */
function texts(res) {
  const c = (res && res.result && Array.isArray(res.result.content)) ? res.result.content : [];
  return c.map((x) => String((x && x.text) || ''));
}
function tailJson(t) {
  try { return JSON.parse(t); } catch { return null; }
}
function isErr(res) { return Boolean(res && res.result && res.result.isError); }

// ── 预检：先静态证明「哪些算写」，再让任何子进程启动 ──────────────────
// ★ 顺序有讲究：下面只有一条调用会真的碰到生产账本（soul_ledger write）。
//   分类错了 = 测试自己往《墨》里写一行。所以先证明判据，再跑。
// ★ Windows 上动态 import 绝对路径必须给 file:// URL —— 直接喂 D:\... 会 ERR_UNSUPPORTED_ESM_URL_SCHEME
const { isWriteCall } = await import(pathToFileURL(path.join(ROOT, 'src/adapters/mcp-proxy.mjs')).href);
// ★★ 2026-11-10（G2a）改了这里的一格：soul_autonomy 从 MUST_WRITE 挪到 MUST_READ。
//   依据是读代码读出来的：它只调 Autonomy.check()（organs/autonomy.mjs:174-184 纯判定），
//   会写 autonomy.json 的 recordRun() 没有任何 MCP 入口。原先那一格是 fail-closed 的误判。
//   ★ 这份自检**本轮没有跑** —— 它会跑 soul_ledger write 真写真账（见下一条注释），
//     按 G2a 的隔离要求不许碰生产账本。改的是判据表，不是它的结论。
const MUST_WRITE = [
  ['soul_index', { session: 'x', type: 'user', text: 'y' }],
  ['soul_compact', { session: 'x' }],
  ['soul_ask_host', { cap: 'followup', action: 'say' }],
  ['soul_ledger', { action: 'write', text: 'x' }],
  ['soul_waker', { action: 'ingest' }],
  ['soul_waker', { action: 'decide', key: 'k' }],
];
const MUST_READ = [
  ['soul_autonomy', {}],
  ['soul_ledger', { action: 'list' }],
  ['soul_ledger', {}],
  ['soul_waker', { action: 'state' }],
  ['soul_recall', { query: 'x' }],
  ['soul_frame', { session: 'x', seq: 1 }],
  ['soul_sessions', {}],
  ['soul_query', { terms: ['x'] }],
  ['soul_health', {}],
  ['soul_diagnose', {}],
  ['soul_context', {}],
  ['soul_file', { terms: ['x'] }],
  ['soul_persona', {}],
];
const badClass = [];
for (const [n, a] of MUST_WRITE) if (!isWriteCall(n, a)) badClass.push(n + ' 该算写');
for (const [n, a] of MUST_READ) if (isWriteCall(n, a)) badClass.push(n + ' 该算读');
if (badClass.length) {
  console.error('✗ 写/读分类错了，拒绝继续（否则测试本身会碰生产账本）：' + badClass.join(' / '));
  process.exit(3);
}
console.log('✓ 预检：' + MUST_WRITE.length + ' 个写工具 / ' + MUST_READ.length + ' 个读工具分类正确');

const LEDGER0 = ledgerLines();
if (LEDGER0 < 0) { console.error('读不到生产账本（' + PROD_LEDGER + '），本自检拒绝在看不见账本的情况下跑。'); process.exit(2); }
console.log('');
console.log('=== stdio 写者收口自检 ===');
console.log('临时根：' + TMP);
console.log('生产账本基线：' + LEDGER0 + ' 行（只读，不改）');
console.log('');

// ────────────────────────────────────────────────────────────────
// 1) 假主服务在线 → 全部转发，本进程不建任何文件
const hub = await fakeHub().start();
const D1 = path.join(TMP, 'case1-proxy');
fs.mkdirSync(D1, { recursive: true });
const s1 = startServer({ AGENT_SOUL_DATA: D1, SOUL_HUB_URL: hub.url });
await sleep(300);
const init1 = await s1.waitFor(s1.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} }));
push('1a initialize 由本进程直接答（不依赖主服务）',
  Boolean(init1.result && init1.result.serverInfo && init1.result.serverInfo.name === 'agent-soul'),
  init1.result && init1.result.serverInfo ? init1.result.serverInfo.name : '无');
const tl1 = await s1.waitFor(s1.rpc('tools/list', {}));
push('1b tools/list 由本进程直接答', ((tl1.result && tl1.result.tools) || []).length >= 15,
  ((tl1.result && tl1.result.tools) || []).length + ' 个工具');
const r1a = await s1.call('soul_ledger', { action: 'stats' });
const t1a = texts(r1a).join(' ');
push('1c 读工具被转发（不是本机执行）', t1a.includes('FAKE-HUB'), t1a.slice(0, 70));
const r1b = await s1.call('soul_index', { session: 'guard-case1', type: 'user', text: '写工具也必须转发' });
const t1b = texts(r1b).join(' ');
push('1d 写工具也被转发（本进程不落盘）', t1b.includes('FAKE-HUB'), t1b.slice(0, 70));
push('1e 假主服务收到 2 条 tools/call', hub.calls.length === 2, hub.calls.map((c) => c.name).join(','));
push('1f 假主服务没收到 initialize/tools/list（元信息本地答）',
  hub.hits.every((x) => x.method === 'tools/call'), hub.hits.map((x) => x.method).join(','));
const d1Files = jsonlFiles(D1);
push('1g 本进程没有创建任何 jsonl/json/cache 文件', d1Files.length === 0, d1Files.join(' | ') || '0 个');
push('1h 连 sessions 目录都没建（没有 store 构造）', !fs.existsSync(path.join(D1, 'sessions')),
  fs.existsSync(path.join(D1, 'sessions')) ? '存在（不该）' : '不存在 ✓');
push('1i 横幅声明 proxy 且说了「不写任何文件」', s1.err.includes('proxy') && s1.err.includes('不写任何文件'),
  s1.err.trim().split('\n')[0]);
s1.stop();
await hub.stop();

// ────────────────────────────────────────────────────────────────
// 2) 主服务不在线 → 写工具全拒 + 账本行数不变
const P2 = await deadPort();
const D2 = path.join(TMP, 'case2-offline');
fs.mkdirSync(D2, { recursive: true });
const s2 = startServer({ AGENT_SOUL_DATA: D2, SOUL_HUB_URL: 'http://127.0.0.1:' + P2 });
await sleep(300);
await s2.waitFor(s2.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} }));
const w1 = await s2.call('soul_index', { session: 'guard-case2', type: 'user', text: '这条不许落盘' });
const w1t = texts(w1)[0] || '';
const w1j = tailJson(w1t) || {};
push('2a soul_index → SOUL_OFFLINE / rejected', w1j.code === 'SOUL_OFFLINE' && w1j.status === 'rejected', w1j.code + '/' + w1j.status);
push('2b 写拒绝是 isError（宿主看得见）', isErr(w1), String(isErr(w1)));
const w2 = await s2.call('soul_ledger', { action: 'write', type: 'fact', text: '这条不许进账本' });
const w2j = tailJson(texts(w2)[0] || '') || {};
push('2c soul_ledger write → SOUL_OFFLINE / rejected', w2j.code === 'SOUL_OFFLINE' && w2j.status === 'rejected', w2j.code + '/' + w2j.status);
const w3 = await s2.call('soul_waker', { action: 'ingest', title: '不许收' });
const w3j = tailJson(texts(w3)[0] || '') || {};
push('2d soul_waker ingest → SOUL_OFFLINE', w3j.code === 'SOUL_OFFLINE', w3j.code);
const w4 = await s2.call('soul_compact', { session: 'guard-case2' });
const w4j = tailJson(texts(w4)[0] || '') || {};
push('2e soul_compact → SOUL_OFFLINE', w4j.code === 'SOUL_OFFLINE', w4j.code);
const w5 = await s2.call('soul_ask_host', { cap: 'followup', action: 'say', args: { text: 'x' } });
const w5j = tailJson(texts(w5)[0] || '') || {};
push('2f soul_ask_host → SOUL_OFFLINE', w5j.code === 'SOUL_OFFLINE', w5j.code);
// ★★ 2026-11-10（G2a）这一格换了层：原先在这里断言 soul_autonomy 离线时回 SOUL_OFFLINE，
//   依据是「它会写 autonomy.json」—— 那个写点在 recordRun()，不在 soul_autonomy 的调用链上。
//   现在它是读工具：离线时会**真的去只读打开存储**，于是「回不回 SOUL_OFFLINE」取决于
//   临时目录里有没有 sessions/（有就跑通、没有就 SOUL_OFFLINE）—— 那个变量与本条要验的事无关。
//   所以改断言**判据本身**（同一份 manifest 的 isWriteCall），而不是被存储状态污染的线上表现。
//   ★ 这份自检本轮没有跑（它会真的往生产账本写一行，见预检第 161-163 行注释）。
push('2g soul_autonomy 不再算写工具（G2a 改判为只读）', isWriteCall('soul_autonomy', {}) === false, String(isWriteCall('soul_autonomy', {})));
const d2Files = jsonlFiles(D2);
push('2h 临时数据目录里一个 jsonl 都没有', d2Files.length === 0, d2Files.join(' | ') || '0 个');
const LEDGER1 = ledgerLines();
push('2i 生产账本行数不变（' + LEDGER0 + ' 行）', LEDGER1 === LEDGER0, '现在 ' + LEDGER1 + ' 行');

// ────────────────────────────────────────────────────────────────
// 3) 离线读工具：返回结果 + degraded 块
const D3 = path.join(TMP, 'case3-read');
fs.mkdirSync(D3, { recursive: true });
// 用真实的 SessionStore 在临时目录里种一个会话（本进程写临时目录，与子进程无关）
// ★ seq 不猜：用 append 的真实回执。猜错了断言会红，而红得没道理。
let SEED_SEQ = null;
{
  const { SessionStore } = await import(pathToFileURL(path.join(ROOT, 'src/session/store.mjs')).href);
  const st = new SessionStore(D3);
  st.create('D:/tmp', null, { id: 'seed-1' });
  SEED_SEQ = st.append('seed-1', 'user', { text: 'guard-seed-可检索的一句话' }).seq;
  try { st.saveIndexCache(); } catch {}
  try { st.closeAll(); } catch {}
}
const s3 = startServer({ AGENT_SOUL_DATA: D3, SOUL_HUB_URL: 'http://127.0.0.1:' + P2 });
await sleep(300);
await s3.waitFor(s3.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} }));
const rd1 = await s3.call('soul_sessions', {});
const rd1t = texts(rd1);
push('3a soul_sessions 离线仍返回数据', rd1t.join(' ').includes('seed-1'), (rd1t[0] || '').slice(0, 60));
push('3b 返回不是 isError（读是降级，不是失败）', !isErr(rd1), String(isErr(rd1)));
const rd1Tail = rd1t.length > 1 ? tailJson(rd1t[1]) : null;
push('3c 第二条 content 是 degraded 块', Boolean(rd1Tail && rd1Tail.degraded === true && rd1Tail.code === 'SOUL_OFFLINE'),
  rd1Tail ? (rd1Tail.degraded + '/' + rd1Tail.code) : '没有第二条 content');
push('3d degraded 块带 staleSince 字段', Boolean(rd1Tail && Object.prototype.hasOwnProperty.call(rd1Tail, 'staleSince')),
  rd1Tail ? 'staleSince=' + String(rd1Tail.staleSince) : '无');
const rd2 = await s3.call('soul_recall', { query: 'guard-seed' });
const rd2t = texts(rd2);
push('3e soul_recall 离线可检索到种子帧', rd2t.join(' ').includes('guard-seed'), (rd2t[0] || '').slice(0, 60));
const rd3 = await s3.call('soul_frame', { session: 'seed-1', seq: SEED_SEQ });
const rd3t = texts(rd3)[0] || '';
push('3f soul_frame 离线可读原文', rd3t.includes('guard-seed-可检索的一句话'), rd3t.slice(0, 60));
push('3g 读的过程中没有新增 jsonl 文件数（种子的 2 个之外）',
  jsonlFiles(D3).filter((f) => f.endsWith('index.jsonl')).length === 1,
  jsonlFiles(D3).map((f) => path.basename(f)).join(','));
const rd4 = await s3.call('soul_ledger', { action: 'stats' });
push('3h soul_ledger stats 离线可读（读生产账本，只读）', !isErr(rd4) && texts(rd4)[0].includes('共 '), (texts(rd4)[0] || '').slice(0, 50));
const LEDGER2 = ledgerLines();
push('3i 读了一路之后账本行数仍不变', LEDGER2 === LEDGER0, '现在 ' + LEDGER2 + ' 行');
s3.stop();

// ────────────────────────────────────────────────────────────────
// 4) 主服务中途挂掉 → 报错，绝不静默写本机
const hub4 = await fakeHub().start();
const D4 = path.join(TMP, 'case4-dies');
fs.mkdirSync(D4, { recursive: true });
const s4 = startServer({ AGENT_SOUL_DATA: D4, SOUL_HUB_URL: hub4.url });
await sleep(300);
await s4.waitFor(s4.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} }));
const pre = await s4.call('soul_index', { session: 'guard-case4', type: 'user', text: '先转发一次，锁定代理' });
push('4a 主服务在时写工具被转发', texts(pre).join(' ').includes('FAKE-HUB'), texts(pre).join(' ').slice(0, 60));
await hub4.stop();
await sleep(400);
const post = await s4.call('soul_index', { session: 'guard-case4', type: 'user', text: '主服务挂了，这条更不许写本机' });
const postJ = tailJson(texts(post)[0] || '') || {};
push('4b 主服务挂掉后报错而不是落回本机', isErr(post) && postJ.code === 'SOUL_HUB_DOWN', postJ.code + ' / ' + String(postJ.error || '').slice(0, 60));
push('4c 拒绝体明说「没有落回本机」', String(postJ.why || '').includes('没有') && String(postJ.why || '').includes('落回本机'), String(postJ.why || '').slice(0, 50));
const d4Files = jsonlFiles(D4);
push('4d 主服务挂掉后本机仍然 0 个 jsonl', d4Files.length === 0, d4Files.join(' | ') || '0 个');
const LEDGER3 = ledgerLines();
push('4e 账本行数仍不变', LEDGER3 === LEDGER0, '现在 ' + LEDGER3 + ' 行');
s4.stop();

// ────────────────────────────────────────────────────────────────
// 5) SOUL_STDIO_MODE 可强制（对照：证明 2/3 的「全拒」不是代码写死了）
const D5a = path.join(TMP, 'case5-force-proxy');
fs.mkdirSync(D5a, { recursive: true });
const s5a = startServer({ AGENT_SOUL_DATA: D5a, SOUL_HUB_URL: 'http://127.0.0.1:' + P2, SOUL_STDIO_MODE: 'proxy' });
await sleep(300);
await s5a.waitFor(s5a.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} }));
const fp = await s5a.call('soul_index', { session: 'guard-case5a', type: 'user', text: '强制代理，主服务不在' });
const fpJ = tailJson(texts(fp)[0] || '') || {};
push('5a SOUL_STDIO_MODE=proxy + 主服务不在 → SOUL_HUB_DOWN（不落回本机）', fpJ.code === 'SOUL_HUB_DOWN', fpJ.code);
push('5b 强制代理也不建 jsonl', jsonlFiles(D5a).length === 0, jsonlFiles(D5a).join(' | ') || '0 个');
push('5c 横幅说 proxy', s5a.err.includes('proxy'), s5a.err.trim().split('\n')[0]);
s5a.stop();

const D5b = path.join(TMP, 'case5-standalone');
fs.mkdirSync(D5b, { recursive: true });
const s5b = startServer({ AGENT_SOUL_DATA: D5b, SOUL_HUB_URL: 'http://127.0.0.1:' + P2, SOUL_STDIO_MODE: 'standalone' });
await sleep(300);
await s5b.waitFor(s5b.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} }));
const sa = await s5b.call('soul_index', { session: 'guard-case5b', type: 'user', text: '显式 standalone，我就是唯一写者' });
push('5d SOUL_STDIO_MODE=standalone → 恢复旧行为（本机写入）', texts(sa).join(' ').includes('已索引'), texts(sa).join(' ').slice(0, 60));
push('5e standalone 确实在临时目录里建了 jsonl', jsonlFiles(D5b).length >= 2,
  jsonlFiles(D5b).map((f) => path.basename(f)).join(',') || '0 个');
push('5f 横幅说 standalone', s5b.err.includes('standalone'), s5b.err.trim().split('\n')[0]);
s5b.stop();

await sleep(200);
const LEDGER4 = ledgerLines();
push('★ 全程生产账本行数不变（' + LEDGER0 + ' 行）', LEDGER4 === LEDGER0, '现在 ' + LEDGER4 + ' 行');

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log('');
console.log(ok.join('\n'));
if (bad.length) { console.log(''); console.log(bad.join('\n')); }
console.log('');
console.log(ok.length + ' 通过 / ' + bad.length + ' 失败');
console.log('');
process.exit(bad.length ? 1 : 0);
