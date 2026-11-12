#!/usr/bin/env node
// G2a · 8901 手机通道的只读闸（补盖的一条写面）
//
// ★ 为什么要单独一个探针：8901 是**同一进程的第二个监听**，而 G2a 的验收清单只点名了 7310。
//   只盖 7310 的话，「manifest 之外默认拒绝」这句话在 8901 上是假的 ——
//   POST /api/send 一样 store.append + 跑整轮。
//
// 用法： node tools/g2a-chat-readonly-probe.mjs
// 边界：临时 AGENT_SOUL_HOME、合成 canary、两个 listen(0) 现取的端口、只绑 127.0.0.1、AGENT_SOUL_SYNC=off。

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const OUT = path.join(ROOT, '_verify', 'g2a-chat-' + STAMP);
const HOME = path.join(OUT, 'home');
const DATA = path.join(HOME, 'data');
const EVID = path.join(OUT, 'evidence');
const SID = 'g2a-chat-seeded-0001';
const CANARY = 'sk-g2a-CHAT-PROBE-CANARY-0000';
const T0 = Date.now();

const checks = [];
function check(id, title, pass, evidence) {
  checks.push({ id, title, pass: !!pass, evidence: evidence === undefined ? null : evidence });
  console.log('  [' + (pass ? 'PASS' : 'FAIL') + '] ' + id + '  ' + title + (pass ? '' : '   <<< ' + JSON.stringify(evidence)));
}
const sha256File = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let MAIN = 0, CHAT = 0, child = null, log = '', exitInfo = null;

function reqOn(port, method, p, body, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const payload = body == null ? null : JSON.stringify(body);
    const headers = {};
    if (payload != null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers, agent: false, timeout: timeoutMs }, (res) => {
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
const pickPort = () => new Promise((resolve) => { const s = http.createServer(() => {}); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(EVID, { recursive: true });
MAIN = await pickPort();
CHAT = await pickPort();
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  host: '127.0.0.1', port: MAIN, dataDir: 'data', workspace: 'workspace', quiet: false,
  llm: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: CANARY, model: 'g2a-probe-model' },
  // ★ 手机通道**开着**，但只绑回环、端口现取 —— 要验的就是「开着的时候写面还拦不拦」
  chat: { enabled: true, host: '127.0.0.1', port: CHAT },
  soul: { root: null }, diary: { dir: null }, persona: { files: [] },
}, null, 2), 'utf8');

const { SessionStore } = await import(pathToFileURL(path.join(ROOT, 'src', 'session', 'store.mjs')).href);
const st = new SessionStore(DATA);
st.create(DATA, null, { id: SID });
st.append(SID, 'user', { text: 'g2a chat seed 1' });
try { st.closeAll(); } catch {}
const framesPath = path.join(DATA, 'sessions', SID, 'frames.jsonl');
const frames0 = sha256File(framesPath);

const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith('AGENT_SOUL_')) delete env[k];
env.AGENT_SOUL_HOME = HOME;
env.AGENT_SOUL_DATA = DATA;       // ★ 同一道隔离（见 tools/g2a-readonly-selftest.mjs 里那段注释）
env.AGENT_SOUL_READONLY = '1';
env.AGENT_SOUL_SYNC = 'off';

console.log('');
console.log('G2a 手机通道只读探针 · 主口 ' + MAIN + ' · 手机口 ' + CHAT);

child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.mjs')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (c) => { log += c; });
child.stderr.on('data', (c) => { log += c; });
child.on('exit', (code, sig) => { exitInfo = { code, sig }; });

let up = false;
const dl = Date.now() + 25000;
while (Date.now() < dl && !exitInfo) {
  const r = await reqOn(MAIN, 'GET', '/api/health', null, 1500);
  if (r.status === 200 && r.json && r.json.ok) { up = true; break; }
  await sleep(300);
}
check('C0', '服务起来了（含手机通道）', up, { exit: exitInfo, log: log.slice(-600) });
// ★ 第一版这里判的是 /\[chat\]|手机通道/，而启动横幅实际长这样：'  手机    http://…:52372/'
//   —— 断言和事实只差一个词，就整条红。改成「日志里出现手机端口」这个可核的事实。
check('C0b', '启动日志里手机通道真的起了（不是被 CHAT=off 关掉）', log.includes(String(CHAT)) && log.includes('手机'), { chatPort: CHAT, log: log.slice(-500) });

if (up) {
  const chatUp = [];
  for (let i = 0; i < 20; i++) {
    const r = await reqOn(CHAT, 'GET', '/api/status', null, 1500);
    if (r.status === 200) { chatUp.push(r); break; }
    await sleep(200);
  }
  check('C1', '8901 GET /api/status → 200（读照常）', chatUp.length === 1 && chatUp[0].json && chatUp[0].json.ok !== false, chatUp[0] && { status: chatUp[0].status });

  const rec = await reqOn(CHAT, 'GET', '/api/recent');
  check('C2', '8901 GET /api/recent → 200（读照常）', rec.status === 200, { status: rec.status });

  const send = await reqOn(CHAT, 'POST', '/api/send', { text: 'g2a-canary-chat-send-ATTEMPT' });
  const b = send.json || {};
  check('C3', '8901 POST /api/send → 403 rejected/UNAVAILABLE/SOUL_READONLY',
    send.status === 403 && b.status === 'rejected' && b.reason === 'UNAVAILABLE' && b.code === 'SOUL_READONLY' && b.service === 'online' && b.via === 'chat-8901',
    { status: send.status, body: b });
  check('C4', '那一帧没有被 append（frames.jsonl hash 不变）', sha256File(framesPath) === frames0, { before: frames0, after: sha256File(framesPath) });

  const sd = await reqOn(MAIN, 'POST', '/api/shutdown', null, 4000);
  check('C5', 'POST /api/shutdown → 202', sd.status === 202 && sd.json && sd.json.accepted === true, { status: sd.status });
  const dl2 = Date.now() + 15000;
  while (!exitInfo && Date.now() < dl2) await sleep(150);
  check('C6', '进程优雅退出（退出码 0）', Boolean(exitInfo) && exitInfo.code === 0, exitInfo);
}

if (child && !exitInfo) { try { child.kill(); } catch {} }
fs.writeFileSync(path.join(EVID, 'server.log'), log, 'utf8');

const fails = checks.filter((c) => !c.pass);
const report = {
  kind: 'g2a-chat-readonly-probe', stamp: STAMP, node: process.version, mainPort: MAIN, chatPort: CHAT,
  elapsedMs: Date.now() - T0, total: checks.length, pass: checks.length - fails.length, fail: fails.length,
  verdict: fails.length === 0 ? 'PASS' : 'FAIL',
  env: { AGENT_SOUL_READONLY: '1', AGENT_SOUL_SYNC: 'off', chat: 'enabled=true, host=127.0.0.1, port=dynamic' },
  hashes: { framesBefore: frames0, framesAfter: sha256File(framesPath) },
  checks,
};
fs.writeFileSync(path.join(EVID, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

let removed = false;
try { fs.rmSync(HOME, { recursive: true, force: true }); removed = !fs.existsSync(HOME); } catch {}
console.log('');
console.log('  ' + report.verdict + '  ' + report.pass + ' PASS / ' + report.fail + ' FAIL  (' + report.elapsedMs + 'ms) · 临时 home 已删=' + removed);
console.log('  证据 ' + EVID);
process.exit(fails.length === 0 ? 0 : 1);
