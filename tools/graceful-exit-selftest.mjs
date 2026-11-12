#!/usr/bin/env node
// 优雅退出自测（G2a 硬前置③ · 2026-11-09）
//
// 要证明的四件事（一条一条都能对着输出看）：
//   ① 收到 SIGINT / SIGTERM 之后，进程会**把索引缓存写回磁盘**并在日志里留下 cacheSaved
//   ② 退出日志只有一行（结构化 JSON），重复信号不会写第二行
//   ③ 超时兜底存在，进程一定会在「超时 + 余量」之内退出，且端口被释放
//   ④ 下次启动**不重建索引**（ixReindexed = 0 / ixReused = 缓存行数）—— 这才是 G2a 要的东西
//
// ★★ 为什么用 launcher + process.emit 而不是真的 child.kill('SIGINT')：
//   Windows 上**没有可捕获的 SIGINT 交给另一个进程**。Node 的 child.kill('SIGINT')
//   走的是 TerminateProcess —— 处理器一行都跑不到（这正是生产上 taskkill /F 杀不干净的原因）。
//   而 Ctrl+C 那条路要控制台事件（GenerateConsoleCtrlEvent），后台跑的自测里没有控制台。
//   所以这里 launcher 先真的 import src/index.mjs（真代码、真 server、真 store、真信号处理器），
//   再由它自己 process.emit('SIGINT') —— 那正是 node 收到 SIGINT 时做的事情，
//   绕过的只有「内核把信号交给 node」这一跳，被测的那段代码一行没换。
//   ★ 代价要说清：这一条**没有**验证「操作系统真能递到我们手上」，它验证的是
//     「递到之后我们做得对不对」。前者在 Windows 上只能靠 Ctrl+C 实测。
//
// 用法：node tools/graceful-exit-selftest.mjs [--verbose]
//   退出码 0 = 全过；1 = 有用例没过（每条都会打印实际读数）

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SessionStore } from '../src/session/store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const INDEX = path.join(ROOT, 'src', 'index.mjs');
const NODE = process.execPath;
const VERBOSE = process.argv.includes('--verbose');

if (process.argv[2] === '--child') {
  await childMain();
} else {
  await driverMain();
}

// ───────────────────────────────────────────────────────────────────────────
// 子进程：起真服务，等 driver 说 go，然后自己发信号
// ───────────────────────────────────────────────────────────────────────────
async function childMain() {
  const argv = process.argv.slice(3);            // --child <dataDir> <port> <mode>
  const [dataDir, port, mode] = argv;
  await import(pathToFileURL(INDEX).href);       // ★ 被测的真身
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    if (!String(chunk).includes('go')) return;
    process.stdin.removeAllListeners('data');
    try { process.stdin.pause(); } catch {}
    fire(mode);
  });
}

function fire(mode) {
  console.log('SIGNAL ' + Date.now());
  if (mode === 'sigterm') return process.emit('SIGTERM');
  if (mode === 'double') {
    process.emit('SIGINT');
    setTimeout(() => process.emit('SIGINT'), 40);   // 重复信号：不许写第二行日志
    return;
  }
  if (mode === 'exit') return process.exit(0);       // 不走信号：测 exit 兜底
  return process.emit('SIGINT');
}

// ───────────────────────────────────────────────────────────────────────────
// 驱动：起场景 → 断言 → 收证据
// ───────────────────────────────────────────────────────────────────────────
async function driverMain() {
  const results = [];
  const t = (name, ok, detail) => {
    results.push({ name, ok: !!ok, detail });
    console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   [' + detail + ']' : ''));
  };

  console.log('优雅退出自测 · ' + new Date().toISOString());
  console.log('node ' + process.version + ' · ' + INDEX);
  console.log('');

  // ① SIGINT（主场景：先把索引弄脏，再关，看缓存有没有写回去）
  const s1 = await runScenario({ name: 'SIGINT', mode: 'sigint', dirty: true });
  t('SIGINT · 进程在超时+余量内退出', s1.exited && s1.dt !== null && s1.dt <= s1.timeoutMs + 3000,
    'dt=' + s1.dt + 'ms 上限=' + (s1.timeoutMs + 3000) + 'ms exitCode=' + s1.code);
  t('SIGINT · 退出码 0', s1.code === 0, 'code=' + s1.code);
  t('SIGINT · 写了一条退出日志', s1.logLines === 1, 'shutdown.log 行数=' + s1.logLines);
  t('SIGINT · 日志 reason=SIGINT / graceful=true', s1.rec && s1.rec.reason === 'SIGINT' && s1.rec.graceful === true,
    s1.rec ? ('reason=' + s1.rec.reason + ' graceful=' + s1.rec.graceful) : '没有日志');
  t('SIGINT · 有 cacheSaved 布尔字段', s1.rec && typeof s1.rec.cacheSaved === 'boolean', 'cacheSaved=' + (s1.rec && s1.rec.cacheSaved));
  t('SIGINT · 脏索引被写回（cacheSaved=true 且 cacheDirty=true）',
    s1.rec && s1.rec.cacheSaved === true && s1.rec.cacheDirty === true,
    s1.rec ? ('cacheSaved=' + s1.rec.cacheSaved + ' cacheDirty=' + s1.rec.cacheDirty + ' rows=' + s1.rec.cacheRows) : '');
  t('SIGINT · 缓存文件在退出后变了（指纹变了）', s1.stampAfter !== s1.stampBefore,
    s1.stampBefore + ' → ' + s1.stampAfter);
  t('SIGINT · 端口已释放（没有残留监听）', s1.portFree, 'port=' + s1.port);
  t('SIGINT · 下次启动不重建索引', s1.reused > 0 && s1.reindexed === 0,
    'ixReused=' + s1.reused + ' ixReindexed=' + s1.reindexed + ' cacheRows=' + (s1.rec && s1.rec.cacheRows));
  t('SIGINT · 退出前写进去的那一帧重启后搜得到', s1.found >= 1, 'search 命中=' + s1.found);

  // ② SIGTERM
  const s2 = await runScenario({ name: 'SIGTERM', mode: 'sigterm', dirty: true });
  t('SIGTERM · 也会优雅退出并写日志', s2.rec && s2.rec.reason === 'SIGTERM' && s2.rec.graceful === true && s2.rec.cacheSaved === true,
    s2.rec ? ('reason=' + s2.rec.reason + ' graceful=' + s2.rec.graceful + ' cacheSaved=' + s2.rec.cacheSaved + ' ms=' + s2.rec.ms) : '没有日志');

  // ③ exit 兜底（不走信号）
  const s3 = await runScenario({ name: 'exit', mode: 'exit', dirty: true });
  t('exit 兜底 · process.exit 也留下了日志', s3.logLines === 1, 'shutdown.log 行数=' + s3.logLines);
  t('exit 兜底 · reason 以 exit: 开头 / graceful=false / 缓存仍落盘',
    s3.rec && String(s3.rec.reason).startsWith('exit:') && s3.rec.graceful === false && s3.rec.cacheSaved === true,
    s3.rec ? ('reason=' + s3.rec.reason + ' graceful=' + s3.rec.graceful + ' cacheSaved=' + s3.rec.cacheSaved) : '没有日志');
  t('exit 兜底 · 下次启动仍不重建索引', s3.reindexed === 0, 'ixReindexed=' + s3.reindexed + ' ixReused=' + s3.reused);

  // ④ 重复信号只执行一次
  const s4 = await runScenario({ name: 'double', mode: 'double', dirty: false });
  t('重复 SIGINT · 只写一行日志（once 标志生效）', s4.logLines === 1, 'shutdown.log 行数=' + s4.logLines);

  // ⑤ 留一条 keep-alive 连接在外面（GUI 真实长什么样）
  //   ★ 这条是「不无限等」那条要求的实测：老写法 server.close(回调) 在 keep-alive 下永远不回调，
  //     于是进程会挂在那儿 —— 这不是理论，是 node 文档写明的行为。
  const s5 = await runScenario({ name: 'keepalive', mode: 'sigint', dirty: true, holdOpen: true });
  t('keep-alive · 那条连接确实是活的', s5.held === 200, 'GET /api/overview = ' + s5.held);
  t('keep-alive · 不会把关闭吊住（优雅退出仍然完成）',
    s5.exited && s5.dt !== null && s5.dt <= 3000 && s5.rec && s5.rec.graceful === true,
    'dt=' + s5.dt + 'ms graceful=' + (s5.rec && s5.rec.graceful) + ' httpDrained=' + (s5.rec && s5.rec.httpDrained));
  t('keep-alive · 端口照样被释放', s5.portFree, 'port=' + s5.port);

  const bad = results.filter((r) => !r.ok);
  console.log('');
  console.log('── 汇总 ' + (results.length - bad.length) + '/' + results.length + ' 通过 ──');
  for (const r of results) if (!r.ok) console.log('  ✗ ' + r.name + '  ' + (r.detail || ''));
  if (VERBOSE) console.log(JSON.stringify(results, null, 2));
  process.exit(bad.length ? 1 : 0);
}

async function runScenario({ name, mode, dirty, holdOpen = false, timeoutMs = 5000 }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'asoul-graceful-' + name + '-'));
  const home = path.join(base, 'home');
  const dataDir = path.join(base, 'data');
  const workspace = path.join(base, 'ws');
  for (const d of [home, dataDir, workspace]) fs.mkdirSync(d, { recursive: true });

  const port = await pickPort();
  // ★ 用 AGENT_SOUL_HOME 指一份临时 config.json：不读生产配置（也不碰生产 data），
  //   sync / chat / 书房全关掉 —— 自测要快、要隔离，不要去扫 1000 个真会话。
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    dataDir, workspace, port, host: '127.0.0.1', quiet: false,
    sync: { enabled: false },
    chat: { enabled: false },
    soul: { root: null },
    persona: { files: [] },
    llm: { apiKey: '' },
    events: { intervalMs: 600000, silenceMs: 900000, session: null },
    autonomy: { enabled: false },
  }, null, 2), 'utf8');

  seedSessions(dataDir, workspace);

  const stampBefore = stampOf(dataDir);
  const child = spawn(NODE, [fileURLToPath(import.meta.url), '--child', dataDir, String(port), mode], {
    cwd: ROOT,
    env: {
      ...process.env,
      AGENT_SOUL_HOME: home,
      AGENT_SOUL_DATA: dataDir,
      AGENT_SOUL_PORT: String(port),
      AGENT_SOUL_CHAT: 'off',
      AGENT_SOUL_SHUTDOWN_TIMEOUT_MS: String(timeoutMs),
      AGENT_SOUL_PARENT: '',            // 不装父进程看门狗
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let out = '';
  let err = '';
  const childSaid = (s) => { out += s; if (VERBOSE) process.stdout.write('    [child] ' + s); };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', childSaid);
  child.stderr.on('data', (s) => { err += s; if (VERBOSE) process.stdout.write('    [child:err] ' + s); });

  const ready = await waitFor(() => /GUI\s+http:\/\//.test(out), 30000);
  if (!ready) console.log('    [警告] 没等到 GUI 就绪：' + (out.slice(-300) || err.slice(-300)));

  // ★ 把索引弄脏：走真实 HTTP 接口追加一帧（/api/turn 会 store.append 一条 USER 帧）。
  //   不弄脏的话「退出时写缓存」跟「启动时已经写过」分不开，这条用例就没有信息量。
  let turn = null;
  if (dirty) {
    turn = await postTurn(port, 'sel-0', '优雅退出自测：这一帧必须在退出时进索引 ' + Date.now());
    await new Promise((r) => setTimeout(r, 120));
  }
  const dirtyRow = dirty ? frameRows(path.join(dataDir, 'sessions', 'sel-0', 'index.jsonl')) : 0;

  // ★ 留一条 keep-alive 连接：GUI 页面/宿主真实就是这么连着的
  let agent = null;
  let held = null;
  if (holdOpen) {
    agent = new http.Agent({ keepAlive: true, maxSockets: 2 });
    held = await getWithAgent(port, agent);
  }

  const stampBeforeExit = stampOf(dataDir);
  child.stdin.write('go\n');

  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs + 10000);
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, at: Date.now() }); });
  });
  if (exit.timedOut) { try { child.kill('SIGKILL'); } catch {} }

  if (agent) { try { agent.destroy(); } catch {} }

  const sigMatch = out.match(/SIGNAL (\d+)/);
  const dt = sigMatch && exit.at ? exit.at - Number(sigMatch[1]) : null;

  const logFile = path.join(dataDir, 'shutdown.log');
  let logLines = 0;
  let rec = null;
  if (fs.existsSync(logFile)) {
    const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
    logLines = lines.length;
    try { rec = JSON.parse(lines[0]); } catch { rec = null; }
  }

  const portFree = await tryBind(port);

  // 重启一次：缓存对不对，只能靠「再建一次索引」来判
  let reused = -1;
  let reindexed = -1;
  let found = -1;
  try {
    const s = new SessionStore(dataDir);
    s.buildIndex();
    reused = s.ixReused;
    reindexed = s.ixReindexed;
    found = s.search('sel-0', '优雅退出自测').length;
    s.closeAll();
  } catch (e) {
    console.log('    [警告] 重启校验失败：' + (e && e.message));
  }

  if (!VERBOSE) {
    // 非 verbose 下也给一行可核对的读数
    console.log('    · ' + name + ' 用时 ' + (dt === null ? '?' : dt + 'ms')
      + ' · 日志 ' + (rec ? JSON.stringify(rec) : '无')
      + ' · 脏行=' + dirtyRow + ' · 缓存 ' + stampBefore + ' → ' + stampOf(dataDir));
  }

  return {
    name, mode, port, timeoutMs,
    exited: !exit.timedOut,
    code: exit.timedOut ? null : exit.code,
    dt, logLines, rec, portFree, reused, reindexed, found,
    stampBefore, stampBeforeExit, stampAfter: stampOf(dataDir), dirtyRow,
    turn, held,
    stderrTail: err.slice(-400),
  };
}

// ── 小工具 ─────────────────────────────────────────────────────────────────

function seedSessions(dataDir, workspace) {
  const store = new SessionStore(dataDir);
  for (let i = 0; i < 3; i += 1) {
    const id = 'sel-' + i;
    store.create(workspace, null, { id });
    for (let k = 0; k < 3; k += 1) store.append(id, 'user', { text: '种子帧 ' + i + '-' + k + '：索引重建测试' });
  }
  store.closeAll();
}

function frameRows(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
}

/** data 目录里缓存文件的指纹（size:mtime）—— 缓存有没有被写回，看这个最直接 */
function stampOf(dir) {
  try {
    const st = fs.statSync(path.join(dir, '_index.cache'));
    return st.size + ':' + Math.round(st.mtimeMs);
  } catch { return '0:0'; }
}

function pickPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function tryBind(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

function waitFor(pred, capMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (pred()) return resolve(true);
      if (Date.now() - t0 > capMs) return resolve(false);
      setTimeout(tick, 50);
    };
    tick();
  });
}

/** 用 keep-alive agent 打一次真实的 GET，连接会留在池子里 —— 关闭时必须能甩掉它 */
function getWithAgent(port, agent) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/overview', agent }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', () => resolve(0));
    req.setTimeout(8000, () => { req.destroy(); resolve(0); });
  });
}

function postTurn(port, sessionId, text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ sessionId, text });
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/turn', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      // ★ 帧是在 writeHead 之前 append 的 —— 看到响应头就说明已经写进 store 了
      const status = res.statusCode;
      res.destroy();
      req.destroy();
      resolve({ status });
    });
    req.on('error', (e) => resolve({ status: 0, error: String(e && e.message || e) }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.end(body);
  });
}
