#!/usr/bin/env node
// G2a · 对照组：**没有** AGENT_SOUL_READONLY 时，写面必须和改动前一样开着。
//
// ★ 为什么要有这个对照组：
//   「只读自检全绿」单独看说明不了问题 —— 一个被写坏的写面也会让所有写请求"被拒绝"。
//   所以必须有一条**同一套代码、只差一个环境变量**的对照：
//     · 带 AGENT_SOUL_READONLY=1 → 写请求被拒（tools/g2a-readonly-selftest.mjs）；
//     · 不带 → 写请求照常成功（本脚本）。
//   两条一起，才说明「闸是那道闸，不是服务坏了」。
//
// 用法： node tools/g2a-default-mode-probe.mjs
// 边界与只读自检相同：临时 AGENT_SOUL_HOME、合成 canary key、listen(0) 现取端口、AGENT_SOUL_CHAT=off。
// 预算 60 秒，不重试。

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const OUT = path.join(ROOT, '_verify', 'g2a-default-' + STAMP);
const HOME = path.join(OUT, 'home');
const DATA = path.join(HOME, 'data');
const EVID = path.join(OUT, 'evidence');
const CANARY = 'sk-g2a-DEFAULT-MODE-CANARY-0000';
const T0 = Date.now();

const checks = [];
function check(id, title, pass, evidence) {
  checks.push({ id, title, pass: !!pass, evidence: evidence === undefined ? null : evidence });
  console.log('  [' + (pass ? 'PASS' : 'FAIL') + '] ' + id + '  ' + title + (pass ? '' : '   <<< ' + JSON.stringify(evidence)));
}
const sha256File = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let PORT = 0;
let child = null;
let log = '';
let exitInfo = null;
let rpcId = 0;

function req(method, p, body, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const payload = body == null ? null : JSON.stringify(body);
    const headers = {};
    if (payload != null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers, agent: false, timeout: timeoutMs }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(text); } catch {} resolve({ status: res.statusCode, text, json: j }); });
    });
    r.on('timeout', () => { try { r.destroy(); } catch {} resolve({ status: 0, text: 'TIMEOUT', json: null }); });
    r.on('error', (e) => resolve({ status: 0, text: String((e && e.code) || e), json: null }));
    if (payload != null) r.write(payload);
    r.end();
  });
}

async function pickPort() {
  return await new Promise((resolve) => { const s = http.createServer(() => {}); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(EVID, { recursive: true });
PORT = await pickPort();
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  host: '127.0.0.1', port: PORT, dataDir: 'data', workspace: 'workspace', quiet: false,
  llm: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: CANARY, model: 'g2a-probe-model' },
  soul: { root: null }, diary: { dir: null }, persona: { files: [] },
}, null, 2), 'utf8');

const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith('AGENT_SOUL_')) delete env[k];
env.AGENT_SOUL_HOME = HOME;
env.AGENT_SOUL_DATA = DATA;       // ★ 同一道隔离（见 tools/g2a-readonly-selftest.mjs 里那段注释）
env.AGENT_SOUL_SYNC = 'off';      // 同步仍然关着 —— 本轮只翻「只读」这一个变量
env.AGENT_SOUL_CHAT = 'off';
// ★ 注意：这里**不设** AGENT_SOUL_READONLY。

console.log('');
console.log('G2a 对照组 · 默认写面 · 证据 ' + OUT);
console.log('  端口 ' + PORT);

const cfg0 = sha256File(path.join(HOME, 'config.json'));
const manifest = await import(pathToFileURL(path.join(ROOT, 'src', 'security', 'write-manifest.mjs')).href);
check('D0', '不设 AGENT_SOUL_READONLY 时 readonlyEnabled()=false', manifest.readonlyEnabled() === false, { readonly: manifest.readonlyEnabled() });

child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.mjs')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (c) => { log += c; });
child.stderr.on('data', (c) => { log += c; });
child.on('exit', (code, sig) => { exitInfo = { code, sig }; });

let up = false;
const dl = Date.now() + 25000;
while (Date.now() < dl && !exitInfo) {
  const r = await req('GET', '/api/health', null, 1500);
  if (r.status === 200 && r.json && r.json.ok) { up = true; break; }
  await sleep(300);
}
check('D1', '服务起来了', up, { exit: exitInfo, log: log.slice(-500) });

if (up) {
  check('D2', '启动日志里没有只读横幅（默认姿势）', !log.includes('显式只读'), null);

  const ps = await req('POST', '/api/sessions', { cwd: DATA });
  const newSid = ps.json && ps.json.session && ps.json.session.id;
  check('D3', 'POST /api/sessions → 200（默认写面开着）', ps.status === 200 && Boolean(newSid), { status: ps.status, body: ps.json });

  // ★ patch 的形状是**扁平点路径**（server.mjs:1026 逐键比对 CFG_FIELD_INDEX），
  //   不是嵌套对象。第一版喂了 { llm: { model } } → 键 'llm' 未登记 → 400。
  //   （这条本身就是个提醒：判「写面开没开」时，先确认自己带的是合法的 body。）
  const pc = await req('POST', '/api/config', { patch: { 'llm.model': 'g2a-probe-model-2' } });
  const cfg1 = sha256File(path.join(HOME, 'config.json'));
  check('D4', 'POST /api/config → 200 且 config.json 真的变了', pc.status === 200 && cfg1 !== cfg0, { status: pc.status, body: pc.json && { ok: pc.json.ok, errors: pc.json.errors }, before: cfg0, after: cfg1 });

  const mi = await req('GET', '/mcp');
  check('D5', 'GET /mcp 自报 readonly=false', mi.status === 200 && mi.json && mi.json.readonly === false, mi.json && { readonly: mi.json.readonly, policy: mi.json.writePolicy });

  const idx = await req('POST', '/mcp', { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: 'soul_index', arguments: { session: newSid || 'g2a-x', type: 'user', text: 'g2a default-mode write' } } });
  const okWrite = idx.status === 200 && idx.json && idx.json.result && !idx.json.result.isError && String(idx.json.result.content[0].text).includes('已索引');
  check('D6', 'POST /mcp soul_index 真的写进去了（默认 store 仍是 rw）', okWrite, idx.json);

  const sd = await req('POST', '/api/shutdown', null, 4000);
  check('D7', 'POST /api/shutdown → 202', sd.status === 202 && sd.json && sd.json.accepted === true, { status: sd.status });
  const dl2 = Date.now() + 15000;
  while (!exitInfo && Date.now() < dl2) await sleep(150);
  check('D8', '进程优雅退出（退出码 0）', Boolean(exitInfo) && exitInfo.code === 0, exitInfo);

  const hasSyncState = fs.existsSync(path.join(DATA, 'sync-state.json'));
  check('D9', 'AGENT_SOUL_SYNC=off 在默认模式下同样生效（无 sync-state.json）', !hasSyncState, { syncState: hasSyncState });
}

if (child && !exitInfo) { try { child.kill(); } catch {} }
fs.writeFileSync(path.join(EVID, 'server.log'), log, 'utf8');

const fails = checks.filter((c) => !c.pass);
const report = {
  kind: 'g2a-default-mode-probe', stamp: STAMP, node: process.version, port: PORT,
  elapsedMs: Date.now() - T0, total: checks.length, pass: checks.length - fails.length, fail: fails.length,
  verdict: fails.length === 0 ? 'PASS' : 'FAIL',
  env: { AGENT_SOUL_HOME: 'temp', AGENT_SOUL_READONLY: '(unset)', AGENT_SOUL_SYNC: 'off', AGENT_SOUL_CHAT: 'off' },
  checks,
};
fs.writeFileSync(path.join(EVID, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

let removed = false;
try { fs.rmSync(HOME, { recursive: true, force: true }); removed = !fs.existsSync(HOME); } catch {}
console.log('');
console.log('  ' + report.verdict + '  ' + report.pass + ' PASS / ' + report.fail + ' FAIL  (' + report.elapsedMs + 'ms) · 临时 home 已删=' + removed);
console.log('  证据 ' + EVID);
process.exit(fails.length === 0 ? 0 : 1);
