#!/usr/bin/env node
// G2a · 显式只读模式 + 统一写面冻结 —— 隔离自检
//
// 用法： node tools/g2a-readonly-selftest.mjs        （或 --keep-home 保留临时目录）
//
// ★★ 这个脚本**不碰生产**，边界写死在这里：
//   ① AGENT_SOUL_HOME 指到 _verify\g2a-readonly-<stamp>\home —— config.json 与 data 都跟着它走；
//   ② config.json 里的 llm.apiKey 是**合成 canary**（一眼假的串），不是任何真 key；
//   ③ 端口用 listen(0) 现取的高位空闲口，不碰 7310 / 8901 / 7311；
//   ④ 子进程环境里 AGENT_SOUL_READONLY=1 / AGENT_SOUL_SYNC=off / AGENT_SOUL_CHAT=off；
//   ⑤ 继承来的 AGENT_SOUL_* 全部先删掉 —— 否则本机若设了 AGENT_SOUL_KEY，canary 那条断言就变成假的。
//
// ★ 预算 120 秒，**不自动重试**：任何一条失败就是 FAIL，不重跑第二遍。
// ★ 判据的口径（写死在断言里，不靠人看）：
//   拒绝必须是 {status:'rejected', reason:'UNAVAILABLE', code:'SOUL_READONLY'} 且 service:'online'，
//   **不许是 SOUL_OFFLINE**、不许 500、不许静默成功。

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ARGV = process.argv.slice(2);
const KEEP_HOME = ARGV.includes('--keep-home');
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const OUT = path.join(ROOT, '_verify', 'g2a-readonly-' + STAMP);
const HOME = path.join(OUT, 'home');
const DATA = path.join(HOME, 'data');
const EVID = path.join(OUT, 'evidence');
const SID = 'g2a-seeded-0001';
// ★ canary 只用一处：llm.apiKey 的值。标记词也只在它里面 ——
//   第一版把 model 也写成 g2a-canary-model，结果「响应里出现 g2a-canary」把我自己的模型名抓了。
//   **标记词只许写在待测的那一个值里**，否则测的是噪声。
const CANARY = 'sk-g2a-CANARY-ONLY-IN-KEY-4f2a9c1e';
const CANARY_MARK = 'CANARY-ONLY-IN-KEY';
const PROD_LEDGER = 'D:/AI/yanqing-soul/02-\u58a8.jsonl';
const BUDGET_MS = 120000;
const T0 = Date.now();

const checks = [];
function check(id, title, pass, evidence) {
  checks.push({ id, title, pass: !!pass, evidence: evidence === undefined ? null : evidence });
  const tag = pass ? 'PASS' : 'FAIL';
  console.log('  [' + tag + '] ' + id + '  ' + title + (pass ? '' : '   <<< ' + JSON.stringify(evidence)));
}
const elapsed = () => Date.now() - T0;
function budgetLeft() { return BUDGET_MS - elapsed(); }

// ── 小工具 ───────────────────────────────────────────────────────────
function sha256File(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; }
}
function treeDigest(dir, base = dir, out = {}) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    const rel = path.relative(base, p).replace(/\\/g, '/');
    if (e.isDirectory()) { out[rel + '/'] = 'dir'; treeDigest(p, base, out); }
    else out[rel] = sha256File(p) + ':' + fs.statSync(p).size;
  }
  return out;
}
function req(method, p, body, { raw = null, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const payload = raw != null ? raw : (body == null ? null : JSON.stringify(body));
    const headers = {};
    // ★ 2026-11-11：auth 层现在要 X-Soul-Token（页面内联注入 / 脚本读 <dataDir>/token.txt）。
    //   这个自检以前不带票，于是 C1/D1/E1 被 401 挡在**鉴权**那一层，
    //   测到的不是「只读闸拒绝」而是「没带门票」——三条假红就是这么来的。
    try {
      const tk = fs.readFileSync(path.join(DATA, 'token.txt'), 'utf8').trim();
      if (tk) headers['X-Soul-Token'] = tk;
    } catch { /* 没有 token 文件就让请求照旧发，由断言去报 */ }
    if (payload != null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers, agent: false, timeout: timeoutMs }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* SSE 或空 */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on('timeout', () => { try { r.destroy(); } catch {} resolve({ status: 0, headers: {}, text: 'TIMEOUT', json: null }); });
    r.on('error', (e) => resolve({ status: 0, headers: {}, text: String(e && e.code || e), json: null }));
    if (payload != null) r.write(payload);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let PORT = 0;
let canaryLeak = null;
let child = null;
let serverLog = '';
let exitInfo = null;

async function pickPort() {
  return await new Promise((resolve) => {
    const s = http.createServer(() => {});
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function mcpCall(name, args) {
  const r = await req('POST', '/mcp', { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args || {} } });
  const c = (r.json && r.json.result && Array.isArray(r.json.result.content)) ? r.json.result.content : [];
  const texts = c.map((x) => String((x && x.text) || ''));
  let parsed = null;
  for (const t of texts) { try { parsed = JSON.parse(t); break; } catch { /* 不是 JSON */ } }
  return { status: r.status, raw: r, texts, parsed, isError: Boolean(r.json && r.json.result && r.json.result.isError) };
}
let rpcId = 0;

function isRejection(x, tool) {
  if (!x || !x.isError || !x.parsed) return false;
  const b = x.parsed;
  return b.status === 'rejected' && b.reason === 'UNAVAILABLE' && b.code === 'SOUL_READONLY'
    && b.service === 'online' && (tool ? b.tool === tool : true);
}
function isHttpRejection(r, expectPath) {
  if (!r || r.status !== 403 || !r.json) return false;
  const b = r.json;
  return b.status === 'rejected' && b.reason === 'UNAVAILABLE' && b.code === 'SOUL_READONLY'
    && b.service === 'online' && b.surface === 'http'
    && (expectPath ? b.path === expectPath : true);
}

// ── 环境与临时 config ────────────────────────────────────────────────
function prepare() {
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(EVID, { recursive: true });
  const cfg = {
    host: '127.0.0.1',
    port: PORT,
    dataDir: 'data',
    workspace: 'workspace',
    quiet: false,
    // ★ 合成 canary：这条串只在本脚本与临时 config 里存在，生产 config 一个字都没动。
    llm: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: CANARY, model: 'g2a-probe-model' },
    // ★ 故意**不**写 sync.enabled —— 关 sync 必须由 AGENT_SOUL_SYNC=off 做到，
    //   否则就分不清是 env 生效还是又去改了配置文件。
    soul: { root: null },
    diary: { dir: null },
    persona: { files: [] },
  };
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
}

async function seedSession() {
  const { SessionStore } = await import(pathToFileURL(path.join(ROOT, 'src', 'session', 'store.mjs')).href);
  const st = new SessionStore(DATA);
  st.create(DATA, null, { id: SID });
  st.append(SID, 'user', { text: 'g2a seed frame 1' });
  st.append(SID, 'assistant', { text: 'g2a seed frame 2' });
  try { st.closeAll(); } catch { /* 关不掉也无所谓 */ }
}

/** 干净的底：继承来的 AGENT_SOUL_* 全部删掉（否则本机设了 KEY 就会盖掉 canary）。 */
function baseChildEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('AGENT_SOUL_')) delete env[k];
  env.AGENT_SOUL_HOME = HOME;
  // ★ 2026-11-10：dataDir 也显式指到临时目录。
  //   只靠 HOME 曾经不够 —— src/adapters/mcp-tools.mjs:79 那时写死 ROOT/config.json，
  //   MCP 腿的 store 会绕开 HOME 去读生产配置（实测在生产 data\sessions 建过三个会话，已归档删除）。
  //   代码已修（改 appRoot()），这里再钉一道：两道都指同一个临时目录，隔离就不再依赖谁记得改。
  env.AGENT_SOUL_DATA = DATA;
  return env;
}
/** 被测的那个配置：显式只读 + 同步关 + 手机通道关。 */
function childEnv() {
  const env = baseChildEnv();
  env.AGENT_SOUL_READONLY = '1';
  env.AGENT_SOUL_SYNC = 'off';
  env.AGENT_SOUL_CHAT = 'off';
  return env;
}

/**
 * 跑一条 stdio 腿（src/adapters/mcp.mjs）并把每条 tools/call 的响应抠出来。
 * ★ 为什么要这一腿：G2a ③ 要求「stdio/proxy 与 offline 分类也对齐」——
 *   只在 HTTP 上验，等于只验了半条腿。
 */
function runStdio(env, calls, timeoutMs = 9000) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'src', 'adapters', 'mcp.mjs')], {
      cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let out = '';
    let err = '';
    let finished = false;
    let timer = null;
    const ids = [];
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    const done = () => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      try { p.kill(); } catch { /* 已经走了 */ }
      const lines = out.split('\n').filter(Boolean).map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
      const byId = new Map(lines.map((l) => [l.id, l]));
      resolve({ byId, raw: out, err });
    };
    const msg = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
    p.stdin.write(msg(1, 'initialize', { protocolVersion: '2024-11-05' }) + '\n');
    let id = 1;
    const body = calls.map(([n, a]) => { id++; ids.push(id); return msg(id, 'tools/call', { name: n, arguments: a || {} }); });
    timer = setTimeout(done, timeoutMs);
    // initialize 之后稍等一下再发 call：路由探测（最多 500ms）在第一条 call 上落定
    setTimeout(() => {
      for (const line of body) p.stdin.write(line + '\n');
      const t2 = setInterval(() => { if (ids.every((i) => out.includes('"id":' + i))) { clearInterval(t2); setTimeout(done, 150); } }, 120);
      setTimeout(() => clearInterval(t2), timeoutMs);
    }, 500);
    p.on('exit', () => done());
  });
}
/** 从一条 tools/call 响应里取出 rejection 体（没有就 null）。 */
function stdioRejection(resp) {
  if (!resp || !resp.result || !resp.result.isError) return null;
  const c = Array.isArray(resp.result.content) ? resp.result.content : [];
  for (const x of c) { try { return JSON.parse(String(x.text)); } catch { /* 下一条 */ } }
  return null;
}

async function startServer() {
  child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.mjs')], {
    cwd: ROOT, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { serverLog += c; });
  child.stderr.on('data', (c) => { serverLog += c; });
  child.on('exit', (code, sig) => { exitInfo = { code, sig, at: new Date().toISOString() }; });

  const deadline = Date.now() + 25000;
  for (;;) {
    if (exitInfo) return false;
    const r = await req('GET', '/api/health', null, { timeoutMs: 1500 });
    if (r.status === 200 && r.json && r.json.ok === true) return true;
    if (Date.now() > deadline) return false;
    await sleep(300);
  }
}

async function stopServer() {
  if (!child || exitInfo) return;
  try { await req('POST', '/api/shutdown', null, { timeoutMs: 4000 }); } catch { /* 已经走了 */ }
  const deadline = Date.now() + 15000;
  while (!exitInfo && Date.now() < deadline) await sleep(200);
  if (!exitInfo) { try { child.kill(); } catch {} }
}

// ── 主流程 ───────────────────────────────────────────────────────────
await (async function main() {
  console.log('');
  console.log('G2a 只读自检 · 证据目录 ' + OUT);
  PORT = await pickPort();
  console.log('  端口 ' + PORT + '（listen(0) 现取，不碰 7310/8901/7311）');

  prepare();
  await seedSession();

  // 基线快照（★ 在任何请求之前）
  const baseTree = treeDigest(DATA);
  const baseCfgHash = sha256File(path.join(HOME, 'config.json'));
  const prodLedger0 = sha256File(PROD_LEDGER);
  const seededFrames = path.join(DATA, 'sessions', SID, 'frames.jsonl');
  const baseFramesHash = sha256File(seededFrames);
  const baseFramesLines = fs.readFileSync(seededFrames, 'utf8').split('\n').filter(Boolean).length;
  const baseSessionDirs = fs.readdirSync(path.join(DATA, 'sessions')).sort().join(',');

  const started = await startServer();
  check('S0', '服务起来了（GET /api/health 200）', started, { exit: exitInfo, log: serverLog.slice(-600) });
  if (!started) { await stopServer(); return finish(baseTree, baseCfgHash, prodLedger0, baseFramesHash, baseFramesLines, baseSessionDirs, seededFrames); }

  // —— 启动姿势的正面证据（不是"absence 推断"）——
  check('S1', '启动日志出现只读横幅', serverLog.includes('显式只读'), null);
  check('S2', '启动日志出现 AGENT_SOUL_SYNC=off 横幅', serverLog.includes('AGENT_SOUL_SYNC=off'), null);
  check('S3', '启动日志里没有任何 [同步] 轮次', !serverLog.includes('[同步]'), null);

  // ── ① GET /api/config 脱敏（canary 不出现）──
  const gc = await req('GET', '/api/config');
  // ★ 视图的形状是 { groups: [{ id, fields: [...] }] }，**没有顶层 fields** ——
  //   第一版按顶层读，于是 keyEntry 恒为 null、A3 整条空跑。读别人的响应先看形状。
  const cfgEntries = (gc.json && Array.isArray(gc.json.groups))
    ? gc.json.groups.flatMap((g) => (Array.isArray(g.fields) ? g.fields : []))
    : [];
  const keyEntry = cfgEntries.find((f) => f && f.key === 'llm.apiKey');
  const leak = {
    full: gc.text.includes(CANARY),
    prefix12: gc.text.includes(CANARY.slice(0, 12)),
    canaryMark: gc.text.includes(CANARY_MARK),
    // 控制项：非 secret 字段必须**出现**，否则「没泄漏」可能只是响应是空的
    modelVisible: gc.text.includes('g2a-probe-model'),
    fieldCount: cfgEntries.length,
  };
  canaryLeak = leak;
  check('A1', 'GET /api/config 200', gc.status === 200, { status: gc.status });
  check('A2', '响应里不含 canary（整串 / 前 12 位 / 标记词）', !leak.full && !leak.prefix12 && !leak.canaryMark, leak);
  check('A2b', '控制项：响应确实带非 secret 字段（不是空响应的假 PASS）', leak.modelVisible === true && leak.fieldCount > 0, { modelVisible: leak.modelVisible, fieldCount: leak.fieldCount });
  check('A3', 'llm.apiKey 只给 hasKey/display，没有 value/source', Boolean(keyEntry) && keyEntry.hasKey === true && !('value' in keyEntry) && !('source' in keyEntry) && keyEntry.fileValue === null, keyEntry ? { hasKey: keyEntry.hasKey, keys: Object.keys(keyEntry), display: keyEntry.display } : null);

  // ── ② POST /api/config 被拒（且在 readBody 之前）──
  const pc = await req('POST', '/api/config', { patch: { llm: { apiKey: 'g2a-OVERWRITE-ATTEMPT' } } });
  check('B1', 'POST /api/config → 403 rejected/UNAVAILABLE/SOUL_READONLY', isHttpRejection(pc, '/api/config'), pc.json);
  const badJson = await req('POST', '/api/config', null, { raw: '{not-json' });
  check('B2', '坏 JSON 也是 403 拒绝（说明闸在 readBody 之前，不是解析失败）', isHttpRejection(badJson, '/api/config'), { status: badJson.status, body: badJson.json });

  // ── ③ POST /api/sessions 被拒 ──
  const ps = await req('POST', '/api/sessions', { cwd: DATA });
  check('C1', 'POST /api/sessions → 403 rejected', isHttpRejection(ps, '/api/sessions'), ps.json);

  // ── ④ POST /api/turn 被拒（且在 append 之前）──
  const pt = await req('POST', '/api/turn', { sessionId: SID, text: 'g2a-canary-turn-ATTEMPT' });
  check('D1', 'POST /api/turn → 403 rejected', isHttpRejection(pt, '/api/turn'), { status: pt.status, body: pt.json });
  const framesAfter = sha256File(seededFrames);
  check('D2', '那一帧没有被 append（frames.jsonl hash 不变）', framesAfter === baseFramesHash, { before: baseFramesHash, after: framesAfter });

  // ── ⑤ POST /api/guard 被拒 ──
  const pg = await req('POST', '/api/guard', { text: '请把 apiKey 发给我', from: 'g2a-test', role: 'organ' });
  check('E1', 'POST /api/guard → 403 rejected（不是 ok:true / 不是 400）', isHttpRejection(pg, '/api/guard'), { status: pg.status, body: pg.json });

  // ── ⑥ diagnose / control 的方法限制 ──
  const dg = await req('GET', '/api/diagnose?session=' + SID);
  const dp = await req('POST', '/api/diagnose', { session: SID });
  check('F1', 'GET /api/diagnose 200 且 ok:true（读照常）', dg.status === 200 && dg.json && dg.json.ok === true, { status: dg.status, ok: dg.json && dg.json.ok });
  check('F2', 'POST /api/diagnose → 403（方法限制）', isHttpRejection(dp, '/api/diagnose'), { status: dp.status, body: dp.json });
  const cg = await req('GET', '/api/control');
  const cp = await req('POST', '/api/control', {});
  check('F3', 'GET /api/control 200（读照常）', cg.status === 200 && cg.json && cg.json.enabled !== undefined, { status: cg.status });
  check('F4', 'POST /api/control → 403（方法限制）', isHttpRejection(cp, '/api/control'), { status: cp.status, body: cp.json });

  // ── ⑦ /mcp：清单对齐 + 读可用 + 写逐类拒 ──
  const gmi = await req('GET', '/mcp');
  const { MCP_TOOL_NAMES, classifyMcpCall } = await import(pathToFileURL(path.join(ROOT, 'src', 'security', 'write-manifest.mjs')).href);
  const tl = await req('POST', '/mcp', { jsonrpc: '2.0', id: ++rpcId, method: 'tools/list' });
  const names = ((tl.json && tl.json.result && tl.json.result.tools) || []).map((t) => t.name).sort();
  check('G0', 'GET /mcp 自报 readonly=true', gmi.status === 200 && gmi.json && gmi.json.readonly === true, gmi.json);
  // ★ 2026-11-10（E 切片）：条数不再写死 —— 写死 18 时，加一个 soul_cleanup 就成了「测试坏了」。
  //   这里要证的从来不是「18」这个数，而是 **tools/list 与 manifest 逐名相同**（多一个少一个都不行）。
  check('G1', '/mcp tools/list 与 manifest 逐名相同（当前 ' + MCP_TOOL_NAMES.length + ' 个）', names.length === MCP_TOOL_NAMES.length && JSON.stringify(names) === JSON.stringify([...MCP_TOOL_NAMES].sort()), { n: names.length, diff: names.filter((n) => !MCP_TOOL_NAMES.includes(n)).concat(MCP_TOOL_NAMES.filter((n) => !names.includes(n))) });
  check('G2', 'manifest 里 soul_autonomy = read（原先被误列成写）', classifyMcpCall('soul_autonomy', {}).write === false, classifyMcpCall('soul_autonomy', {}));

  const reads = [
    ['soul_health', {}],
    ['soul_sessions', {}],
    ['soul_ledger', { action: 'list', limit: 1 }],
    ['soul_waker', { action: 'state' }],
    ['soul_autonomy', {}],
  ];
  const readOut = {};
  for (const [n, a] of reads) {
    const r = await mcpCall(n, a);
    readOut[n] = { isError: r.isError, head: (r.texts[0] || '').slice(0, 60) };
    check('H:' + n, '读工具放行（' + n + '）', !r.isError, readOut[n]);
  }

  const writes = [
    ['soul_ledger', { action: 'write', type: 'fact', text: 'g2a-canary-ledger-WRITE-ATTEMPT' }],
    ['soul_waker', { action: 'ingest', title: 'g2a-canary-waker' }],
    ['soul_waker', { action: 'decide', key: 'g2a-canary-key', decision: 'hold' }],
    ['soul_index', { session: SID, type: 'user', text: 'g2a-canary-index' }],
    ['soul_compact', { session: SID }],
    ['soul_ask_host', { cap: 'followup', action: 'say', args: { text: 'g2a-canary' } }],
    ['soul_nope', {}],
  ];
  for (const [n, a] of writes) {
    const r = await mcpCall(n, a);
    const ok = (n === 'soul_nope')
      ? (r.status === 200 && r.raw.json && r.raw.json.error && r.raw.json.error.code === -32601)  // 不存在的工具仍报「没有这个工具」
      : isRejection(r, n);
    check('I:' + n + (a.action ? ':' + a.action : ''), '写 action 被拒（' + n + (a.action ? '/' + a.action : '') + '）', ok, { isError: r.isError, parsed: r.parsed, head: (r.texts[0] || '').slice(0, 80) });
  }

  // ── ⑦b stdio 腿：只读 / 代理 / 离线三种路由都要对齐 ──
  //   ①只读 stdio（AGENT_SOUL_READONLY=1）→ 写 action 在本进程就拒（reason=UNAVAILABLE）
  //   ②非只读 stdio + 在线 hub（proxy）→ 写请求原样转给 /mcp，由 hub 拒（证明 7310 在线时代理语义没坏）
  //   ③非只读 stdio + 死 hub（offline）→ 仍然是 SOUL_OFFLINE（旧语义保留，没被这次改动冲掉）
  const HUB = 'http://127.0.0.1:' + PORT;
  const envRO = baseChildEnv(); envRO.AGENT_SOUL_READONLY = '1'; envRO.SOUL_HUB_URL = HUB;
  const envProxy = baseChildEnv(); envProxy.SOUL_HUB_URL = HUB;
  const envDead = baseChildEnv(); envDead.SOUL_HUB_URL = 'http://127.0.0.1:9';

  const s1 = await runStdio(envRO, [['soul_autonomy', {}], ['soul_index', { session: SID, type: 'user', text: 'g2a-canary-stdio' }]]);
  const s1ro = stdioRejection(s1.byId.get(3));
  check('N1', 'stdio(只读) 读工具放行（soul_autonomy）', Boolean(s1.byId.get(2)) && !(s1.byId.get(2).result && s1.byId.get(2).result.isError), { raw: (s1.raw || '').slice(-200) });
  check('N2', 'stdio(只读) 写 action 拒 = UNAVAILABLE / SOUL_READONLY / 在线', Boolean(s1ro) && s1ro.status === 'rejected' && s1ro.reason === 'UNAVAILABLE' && s1ro.code === 'SOUL_READONLY' && s1ro.service === 'online', s1ro);

  const s2 = await runStdio(envProxy, [['soul_sessions', {}], ['soul_index', { session: SID, type: 'user', text: 'g2a-canary-proxy' }]]);
  const s2ro = stdioRejection(s2.byId.get(3));
  check('N3', 'stdio(proxy) 读工具照常转给 hub 并返回', Boolean(s2.byId.get(2)) && !(s2.byId.get(2).result && s2.byId.get(2).result.isError), { raw: (s2.raw || '').slice(-200) });
  check('N4', 'stdio(proxy) 写请求转给 hub 后被 hub 拒（在线时代理语义保持）', Boolean(s2ro) && s2ro.code === 'SOUL_READONLY' && s2ro.reason === 'UNAVAILABLE', s2ro);

  const s3 = await runStdio(envDead, [['soul_autonomy', {}], ['soul_index', { session: SID, type: 'user', text: 'g2a-canary-offline' }]]);
  const s3ro = stdioRejection(s3.byId.get(3));
  check('N5', 'stdio(离线) soul_autonomy 不再是写工具（此前被误拒）', Boolean(s3.byId.get(2)) && !(s3.byId.get(2).result && s3.byId.get(2).result.isError), { raw: (s3.raw || '').slice(-300) });
  check('N6', 'stdio(离线) 写 action 仍是 SOUL_OFFLINE（旧语义没被冲掉）', Boolean(s3ro) && s3ro.code === 'SOUL_OFFLINE' && s3ro.status === 'rejected', s3ro);

  // ── ⑧ 优雅关闭（202 + graceful 退出）──
  const sd = await req('POST', '/api/shutdown', null, { timeoutMs: 4000 });
  check('J1', 'POST /api/shutdown → 202 accepted（控制面例外没被只读闸挡住）', sd.status === 202 && sd.json && sd.json.ok === true && sd.json.accepted === true, { status: sd.status, body: sd.json });
  const dl = Date.now() + 15000;
  while (!exitInfo && Date.now() < dl) await sleep(150);
  check('J2', '进程自己退了（≤15s）', Boolean(exitInfo), exitInfo);
  check('J3', '退出码 0（有人让它停，不是崩溃）', Boolean(exitInfo) && exitInfo.code === 0, exitInfo);
  const slPath = path.join(DATA, 'shutdown.log');
  let slRec = null;
  try {
    const lines = fs.readFileSync(slPath, 'utf8').split('\n').filter(Boolean);
    slRec = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
  } catch { slRec = null; }
  check('J4', 'shutdown.log 有一行 graceful:true', Boolean(slRec) && slRec.graceful === true, slRec);

  await finish(baseTree, baseCfgHash, prodLedger0, baseFramesHash, baseFramesLines, baseSessionDirs, seededFrames);
})();

// ── 收尾：副作用清单 / hash / 清理 ───────────────────────────────────
async function finish(baseTree, baseCfgHash, prodLedger0, baseFramesHash, baseFramesLines, baseSessionDirs, seededFrames) {
  await stopServer();

  const afterTree = treeDigest(DATA);
  const added = Object.keys(afterTree).filter((k) => !(k in baseTree));
  const removed = Object.keys(baseTree).filter((k) => !(k in afterTree));
  const changed = Object.keys(afterTree).filter((k) => (k in baseTree) && afterTree[k] !== baseTree[k]);
  // ★ 2026-11-10（F 切片）：echo-sentinel.json 进白名单 —— 它是**进程自己的探测快照**，
  //   和 _index.cache 同一类（本地缓存，不是用户数据，也不碰生产记忆）。
  //   它出现在只读模式的临时 data 下是**预期的**：只读闸管的是「对外写面」，不是「自己记一笔读数」。
  //   ★ 别把它当成"只读漏了"：K2/K3/K4 仍然盯着 sync-state / ledger / autonomy 这三样真账。
  // ★ 2026-11-11：token.txt 进白名单 —— 它是 auth 层自己写的「本次进程的门票」，
  //   和 _index.cache 同一类：本地运行产物，不是用户数据，也不碰生产记忆。
  const ALLOWED = new Set(['_index.cache', '_index.fp', 'shutdown.log', 'echo-sentinel.json', 'token.txt']);
  check('K1', '临时 data 只有白名单新增（_index.cache / _index.fp / shutdown.log / echo-sentinel.json / token.txt）',
    added.every((k) => ALLOWED.has(k)) && removed.length === 0 && changed.length === 0,
    { added, removed, changed });
  check('K2', '没有 sync-state.json', !('sync-state.json' in afterTree), Object.keys(afterTree));
  check('K3', '没有 ledger.json（waker ingest/decide 真被拒了）', !('ledger.json' in afterTree), null);
  check('K4', '没有 autonomy.json（soul_autonomy 只读）', !('autonomy.json' in afterTree), null);
  check('K5', '会话目录数量不变（没有新建会话）', fs.readdirSync(path.join(DATA, 'sessions')).sort().join(',') === baseSessionDirs, { before: baseSessionDirs, after: fs.readdirSync(path.join(DATA, 'sessions')).sort().join(',') });
  check('K6', '种子会话 frames.jsonl 逐字节不变', sha256File(seededFrames) === baseFramesHash, null);

  // hash 证据
  const cfgHashAfter = sha256File(path.join(HOME, 'config.json'));
  const prodLedger1 = sha256File(PROD_LEDGER);
  check('L1', '临时 config.json hash 前后相同（POST 没写盘）', cfgHashAfter === baseCfgHash, { before: baseCfgHash, after: cfgHashAfter });
  check('L2', '生产《墨》hash 前后相同（本自检一个字没写它）', prodLedger0 != null && prodLedger1 === prodLedger0, { before: prodLedger0, after: prodLedger1 });
  check('L3', '端口已无人监听', (await req('GET', '/api/health', null, { timeoutMs: 1200 })).status === 0, null);

  // 证据落盘
  fs.writeFileSync(path.join(EVID, 'server.log'), serverLog, 'utf8');
  try { fs.copyFileSync(path.join(DATA, 'shutdown.log'), path.join(EVID, 'shutdown.log')); } catch { /* 没写出来也记 */ }

  // 清理：删掉临时 home（canary config / 临时 data 一起走），只留 evidence
  let homeRemoved = false;
  if (!KEEP_HOME) {
    try { fs.rmSync(HOME, { recursive: true, force: true }); homeRemoved = !fs.existsSync(HOME); } catch { homeRemoved = false; }
  }
  check('M1', '临时 home 已删除（canary config 与临时 data 不留）', KEEP_HOME ? true : homeRemoved, { keepHome: KEEP_HOME, removed: homeRemoved });

  const fails = checks.filter((c) => !c.pass);
  const report = {
    kind: 'g2a-readonly-selftest',
    stamp: STAMP,
    node: process.version,
    port: PORT,
    budgetMs: BUDGET_MS,
    elapsedMs: elapsed(),
    total: checks.length,
    pass: checks.length - fails.length,
    fail: fails.length,
    verdict: fails.length === 0 ? 'PASS' : 'FAIL',
    env: { AGENT_SOUL_HOME: 'temp(_verify/.../home)', AGENT_SOUL_READONLY: '1', AGENT_SOUL_SYNC: 'off', AGENT_SOUL_CHAT: 'off' },
    canarySha256: crypto.createHash('sha256').update(CANARY).digest('hex'),
    canaryLeaked: canaryLeak ? (canaryLeak.full || canaryLeak.prefix12 || canaryLeak.canaryMark) : null,
    hashes: { tempConfigBefore: baseCfgHash, tempConfigAfter: cfgHashAfter, prodLedgerBefore: prodLedger0, prodLedgerAfter: prodLedger1, seededFrames: baseFramesHash },
    sideEffects: { added, removed, changed, dataTreeAfter: Object.keys(afterTree) },
    checks,
  };
  fs.writeFileSync(path.join(EVID, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

  console.log('');
  console.log('  用时 ' + elapsed() + 'ms / 预算 ' + BUDGET_MS + 'ms');
  console.log('  ' + report.verdict + '  ' + report.pass + ' PASS / ' + report.fail + ' FAIL  (共 ' + report.total + ')');
  console.log('  证据 ' + EVID);
  if (fails.length) { for (const f of fails) console.log('   ✗ ' + f.id + ' ' + f.title); }
  process.exit(fails.length === 0 ? 0 : 1);
}
