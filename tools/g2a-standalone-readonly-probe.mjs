#!/usr/bin/env node
// G2a · F1 定点自测：**readonly + standalone** 时，读调用不得在磁盘上造出写面。
//
// ★ 这条自测为什么必须存在：
//   G2a 的 53 项只覆盖「只读 / proxy / offline」三条腿，standalone 不在矩阵里 ——
//   于是「一条读调用把 store 抬回 rw，并在 data 下 mkdir sessions」这个洞，
//   全绿读数永远看不见它。本脚本就是那个缺掉的观察量。
//
// 检查四组：
//   A  readonly + SOUL_STDIO_MODE=standalone（F1 本体）：读调用不得建目录/写缓存；写调用明确 UNAVAILABLE
//   B  同一个 standalone、**不设** readonly（对照组）：写面照旧 —— 否则「A 全过」可能只是服务坏了
//   C  setStoreMode 单元层：readonly 时 'rw' 不生效，'off' 仍然被接受（硬规则只锁一个方向）
//   D  readonly + 默认 auto→offline（既有路径回归）：同样不得建目录（修复不许把既有的对的弄坏）
//
// 边界：临时 AGENT_SOUL_HOME / AGENT_SOUL_DATA；**生产 data 绝不被触碰**；
//       config 里的 apiKey 是一眼假的 canary；不起 7310 / 8901。
// 用法：node tools/g2a-standalone-readonly-probe.mjs [label]
// 不重试。预算 120 秒。

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LABEL = String(process.argv[2] || 'run').replace(/[^a-zA-Z0-9_-]/g, '');
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const OUT = path.join(ROOT, '_verify', 'g2a-standalone-ro-' + LABEL + '-' + STAMP);
const HOME = path.join(OUT, 'home');
const DATA = path.join(HOME, 'data');
const EVID = path.join(OUT, 'evidence');
const CANARY = 'sk-g2a-STANDALONE-RO-CANARY-0000';
const T0 = Date.now();

const checks = [];
function check(id, title, pass, evidence) {
  checks.push({ id, title, pass: !!pass, evidence: evidence === undefined ? null : evidence });
  console.log('  [' + (pass ? 'PASS' : 'FAIL') + '] ' + id + '  ' + title + (pass ? '' : '   <<< ' + JSON.stringify(evidence)));
}
const sha256File = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 递归列出目录下所有文件（相对路径）—— 「有没有写过盘」用文件清单当观察量，比任何返回值都硬。 */
function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p).split(path.sep).join('/');
      if (e.isDirectory()) { out.push(rel + '/'); walk(p); } else out.push(rel);
    }
  };
  walk(dir);
  return out.sort();
}

// 生产 data 的指纹 —— 每次跑前后各取一次，用来证明「生产没被碰」
const PROD_DATA = path.join(ROOT, 'data');
const PROD_SESS = path.join(PROD_DATA, 'sessions');
const prodCount = () => { try { return fs.readdirSync(PROD_SESS, { withFileTypes: true }).filter((e) => e.isDirectory()).length; } catch { return -1; } };
const prodNewDirs = (sinceMs) => {
  const out = [];
  try {
    for (const e of fs.readdirSync(PROD_DATA, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      try { if (fs.statSync(path.join(PROD_DATA, e.name)).birthtimeMs >= sinceMs) out.push(e.name); } catch {}
    }
  } catch {}
  return out;
};

// ── stdio 子进程：一行一条 JSON-RPC ─────────────────────────────
function startStdio(env) {
  const c = spawn(process.execPath, [path.join(ROOT, 'src', 'adapters', 'mcp.mjs')], {
    cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const st = { c, buf: '', pending: new Map(), stderr: '', exit: null, id: 0 };
  c.stdout.setEncoding('utf8');
  c.stdout.on('data', (ch) => {
    st.buf += ch;
    let i;
    while ((i = st.buf.indexOf('\n')) >= 0) {
      const line = st.buf.slice(0, i).trim();
      st.buf = st.buf.slice(i + 1);
      if (!line) continue;
      let j = null;
      try { j = JSON.parse(line); } catch { continue; }
      if (j && j.id != null && st.pending.has(j.id)) {
        const p = st.pending.get(j.id); st.pending.delete(j.id); p(j);
      }
    }
  });
  c.stderr.setEncoding('utf8');
  c.stderr.on('data', (ch) => { st.stderr += ch; });
  c.on('exit', (code, sig) => {
    st.exit = { code, sig };
    for (const p of st.pending.values()) p({ __exit: true });
    st.pending.clear();
  });
  return st;
}
function rpc(st, method, params, timeoutMs = 8000) {
  const id = ++st.id;
  return new Promise((resolve) => {
    const t = setTimeout(() => { st.pending.delete(id); resolve({ __timeout: true }); }, timeoutMs);
    st.pending.set(id, (v) => { clearTimeout(t); resolve(v); });
    try { st.c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }
    catch { clearTimeout(t); st.pending.delete(id); resolve({ __writeFail: true }); }
  });
}
async function stopStdio(st) {
  try { st.c.stdin.end(); } catch {}
  const dl = Date.now() + 8000;
  while (!st.exit && Date.now() < dl) await sleep(80);
  if (!st.exit) { try { st.c.kill(); } catch {} }
  await sleep(120);
}
const callText = (res) => {
  try {
    const c = res && res.result && res.result.content;
    if (!Array.isArray(c) || !c.length) return '';
    return c.map((x) => String((x && x.text) || '')).join('\n');
  } catch { return ''; }
};
const isErr = (res) => Boolean(res && res.result && res.result.isError);

async function pickPort() {
  return await new Promise((resolve) => {
    const s = http.createServer(() => {});
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// ── 准备隔离环境 ─────────────────────────────────────────────
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(EVID, { recursive: true });
const PORT = await pickPort();
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  host: '127.0.0.1', port: PORT, dataDir: 'data', workspace: 'workspace', quiet: true,
  llm: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: CANARY, model: 'g2a-f1-model' },
  soul: { root: null }, diary: { dir: null }, persona: { files: [] },
}, null, 2), 'utf8');

const BASE_ENV = (() => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('AGENT_SOUL_') || k === 'SOUL_STDIO_MODE' || k.startsWith('SOUL_')) delete env[k];
  env.AGENT_SOUL_HOME = HOME;
  env.AGENT_SOUL_DATA = DATA;
  env.AGENT_SOUL_SYNC = 'off';
  env.AGENT_SOUL_CHAT = 'off';
  env.SOUL_PROBE_TIMEOUT_MS = '400';
  return env;
})();

// 前置：数据目录**不存在** —— F1 的观察量本身就是「它有没有被造出来」
const preProd = prodCount();
const preFiles = listFiles(HOME);
const T_START = Date.now();

console.log('');
console.log('G2a F1 · readonly + standalone 自测   label=' + LABEL);
console.log('  证据 ' + OUT);
console.log('  隔离 HOME ' + HOME + '（生产 data 不会被触碰）');

// ── A 组：readonly + standalone（F1 本体）──────────────────────
console.log('');
console.log('A 组 · AGENT_SOUL_READONLY=1 + SOUL_STDIO_MODE=standalone');
const envA = { ...BASE_ENV, AGENT_SOUL_READONLY: '1', SOUL_STDIO_MODE: 'standalone' };
const a = startStdio(envA);
const initA = await rpc(a, 'initialize', { protocolVersion: '2024-11-05' });
check('A0', 'initialize 有回 serverInfo（进程真的起来了）', Boolean(initA && initA.result && initA.result.serverInfo), initA);

check('A1', '读调用之前 data\\sessions 不存在（前置条件）', !fs.existsSync(path.join(DATA, 'sessions')), { dataExists: fs.existsSync(DATA) });

const sessA = await rpc(a, 'tools/call', { name: 'soul_sessions', arguments: { limit: 1 } });
const sessAText = callText(sessA);
// ★ 只读拒绝可以落在两种形状上：result.isError 的内容块，或 JSON-RPC error.message。
//   两种都是「读被明确拒绝」；探针只认**理由**，不认外壳 —— 认外壳会逼着实现去迁就测试。
const sessAReason = sessAText + ' ' + String((sessA && sessA.error && sessA.error.message) || '');
const sessARead = sessAText.includes('还没有任何会话');
const sessARo = /没有可读的会话存储/.test(sessAReason) && !sessARead;
check('A2', 'soul_sessions 不把 store 抬回读写：明确回「没有可读的会话存储」，绝不是「还没有任何会话」',
  sessARo, { isError: isErr(sessA), error: sessA && sessA.error, text: sessAText.slice(0, 300), sawRead: sessARead });

const sessDirA = fs.existsSync(path.join(DATA, 'sessions'));
const filesA1 = fs.existsSync(DATA) ? listFiles(DATA) : [];
check('A3', '★ F1 核心：一条读调用之后 data\\sessions 仍不存在', !sessDirA, { sessionsExists: sessDirA, dataFiles: filesA1 });

const cacheA = filesA1.filter((f) => /_index\.(cache|fp)$/.test(f) || f === '_index.cache' || f === '_index.fp');
check('A4', '没有写出 _index.cache / _index.fp 等索引缓存', cacheA.length === 0, { cacheFiles: cacheA, allFiles: filesA1 });

const idxA = await rpc(a, 'tools/call', { name: 'soul_index', arguments: { session: 'g2a-f1-canary', type: 'user', text: 'g2a F1 readonly standalone write attempt' } });
const idxAText = callText(idxA);
check('A5', 'soul_index 写调用明确被拒（isError + UNAVAILABLE + SOUL_READONLY）',
  isErr(idxA) && /UNAVAILABLE/.test(idxAText) && /SOUL_READONLY/.test(idxAText), { isError: isErr(idxA), text: idxAText.slice(0, 400) });

await stopStdio(a);
const filesA2 = fs.existsSync(DATA) ? listFiles(DATA) : [];
check('A6', '拒绝之后 data 下仍然一个文件都没有（整轮只读：零写）',
  filesA2.length === 0, { dataExists: fs.existsSync(DATA), files: filesA2 });
check('A7', '进程退出后仍无 sessions 目录（closeStore 没补写）', !fs.existsSync(path.join(DATA, 'sessions')), { exists: fs.existsSync(path.join(DATA, 'sessions')) });
fs.writeFileSync(path.join(EVID, 'A-session.stderr.log'), a.stderr || '', 'utf8');
fs.writeFileSync(path.join(EVID, 'A-raw-responses.json'), JSON.stringify({
  init: initA, soul_sessions: sessA, soul_index: idxA, dataFilesAfter: filesA2,
}, null, 2), 'utf8');

// ── B 组：同一个 standalone，不设 readonly（对照组）─────────────
console.log('');
console.log('B 组 · SOUL_STDIO_MODE=standalone，**不设** readonly（写面必须照旧）');
const envB = { ...BASE_ENV, SOUL_STDIO_MODE: 'standalone' };
const b = startStdio(envB);
await rpc(b, 'initialize', { protocolVersion: '2024-11-05' });
const sessB = await rpc(b, 'tools/call', { name: 'soul_sessions', arguments: { limit: 1 } });
const sessBText = callText(sessB);
check('B1', '非只读 standalone：soul_sessions 正常回「还没有任何会话」（不报错）',
  !isErr(sessB) && sessBText.includes('还没有任何会话'), { isError: isErr(sessB), text: sessBText.slice(0, 300) });
const sessDirB = fs.existsSync(path.join(DATA, 'sessions'));
check('B2', '非只读 standalone：sessions 目录照旧被建出来（写面没被误伤）', sessDirB, { sessionsExists: sessDirB });

const idxB = await rpc(b, 'tools/call', { name: 'soul_index', arguments: { session: 'g2a-f1-control', type: 'user', text: 'g2a F1 control write' } });
const idxBText = callText(idxB);
check('B3', '非只读 standalone：soul_index 真的写进去了（已索引）',
  !isErr(idxB) && idxBText.includes('已索引'), { isError: isErr(idxB), text: idxBText.slice(0, 400) });
const frameB = path.join(DATA, 'sessions', 's_', 'frames.jsonl');
const anyFrames = (() => {
  const base = path.join(DATA, 'sessions');
  try {
    for (const d of fs.readdirSync(base, { withFileTypes: true })) {
      if (d.isDirectory() && fs.existsSync(path.join(base, d.name, 'frames.jsonl'))) return path.join(base, d.name, 'frames.jsonl');
    }
  } catch {}
  return null;
})();
check('B4', '非只读 standalone：帧文件真的落盘（frames.jsonl 有内容）',
  Boolean(anyFrames) && fs.statSync(anyFrames).size > 0, { frameFile: anyFrames, size: anyFrames ? fs.statSync(anyFrames).size : null });
await stopStdio(b);
fs.writeFileSync(path.join(EVID, 'B-session.stderr.log'), b.stderr || '', 'utf8');
const filesB = fs.existsSync(DATA) ? listFiles(DATA) : [];
fs.writeFileSync(path.join(EVID, 'B-data-files.json'), JSON.stringify(filesB, null, 2), 'utf8');

// ── C 组：setStoreMode 单元层（硬规则本身）────────────────────
console.log('');
console.log('C 组 · setStoreMode 硬规则（单元层，子进程内直接 import）');
async function modeProbe(env, script) {
  const code = 'const m = await import(' + JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'adapters', 'mcp-tools.mjs')).href) + ');\n'
    + 'const out = {};\n'
    + 'out.initial = m.storeMode();\n'
    + 'out.afterRw = m.setStoreMode("rw");\n'
    + 'out.modeAfterRw = m.storeMode();\n'
    + 'out.afterOff = m.setStoreMode("off");\n'
    + 'out.modeAfterOff = m.storeMode();\n'
    + 'out.afterRo = m.setStoreMode("ro");\n'
    + 'out.modeAfterRo = m.storeMode();\n'
    + 'console.log(JSON.stringify(out));\n';
  const c = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let so = '', se = '';
  c.stdout.setEncoding('utf8'); c.stderr.setEncoding('utf8');
  c.stdout.on('data', (x) => { so += x; });
  c.stderr.on('data', (x) => { se += x; });
  const done = await new Promise((resolve) => {
    const t = setTimeout(() => { try { c.kill(); } catch {} resolve(false); }, 20000);
    c.on('exit', () => { clearTimeout(t); resolve(true); });
  });
  let j = null;
  try { j = JSON.parse(so.trim().split('\n').pop()); } catch {}
  return { done, json: j, stdout: so.slice(-800), stderr: se.slice(-800), script };
}
const cRo = await modeProbe({ ...BASE_ENV, AGENT_SOUL_READONLY: '1' });
check('C1', 'readonly=1：模块初始模式就是 ro', cRo.json && cRo.json.initial === 'ro', cRo);
check('C2', '★ readonly=1：setStoreMode("rw") 不生效，模式仍是 ro', cRo.json && cRo.json.afterRw === 'ro' && cRo.json.modeAfterRw === 'ro', cRo);
check('C3', 'readonly=1："off" 仍然被接受（硬规则只锁 rw 方向，不是把模式冻死）', cRo.json && cRo.json.afterOff === 'off', cRo);
check('C4', 'readonly=1：随后 "ro" 仍可设置（能恢复，不是单向锁）', cRo.json && cRo.json.afterRo === 'ro', cRo);
const cRw = await modeProbe({ ...BASE_ENV });
check('C5', '非只读：初始 rw、"rw" 正常生效（生产默认行为不变）',
  cRw.json && cRw.json.initial === 'rw' && cRw.json.afterRw === 'rw' && cRw.json.modeAfterRw === 'rw', cRw);
fs.writeFileSync(path.join(EVID, 'C-modes.json'), JSON.stringify({ readonly: cRo, default: cRw }, null, 2), 'utf8');

// ── D 组：readonly + 默认 auto→offline（既有路径回归）──────────
console.log('');
console.log('D 组 · AGENT_SOUL_READONLY=1 + 默认 auto（7310 不在线 → offline）');
const DATA2 = path.join(HOME, 'data-d');
const envD = { ...BASE_ENV, AGENT_SOUL_READONLY: '1', AGENT_SOUL_DATA: DATA2 };
const d = startStdio(envD);
await rpc(d, 'initialize', { protocolVersion: '2024-11-05' });
const sessD = await rpc(d, 'tools/call', { name: 'soul_sessions', arguments: { limit: 1 } });
const sessDText = callText(sessD);
const sessDReason = sessDText + ' ' + String((sessD && sessD.error && sessD.error.message) || '');
check('D1', 'readonly + offline：soul_sessions 明确说读不了、且不建目录（既有路径回归）',
  !fs.existsSync(path.join(DATA2, 'sessions')) && !fs.existsSync(DATA2) && /没有可读的会话存储|SOUL_OFFLINE/.test(sessDReason),
  { dataExists: fs.existsSync(DATA2), text: sessDText.slice(0, 300), error: sessD && sessD.error });
await stopStdio(d);
fs.writeFileSync(path.join(EVID, 'D-session.stderr.log'), d.stderr || '', 'utf8');

// ── 生产未被触碰 ─────────────────────────────────────────────
const postProd = prodCount();
const newProdDirs = prodNewDirs(T_START);
check('E1', '生产 data\\sessions 计数不变', preProd === postProd, { pre: preProd, post: postProd });
check('E2', '生产 data 下本脚本期间没有新建目录', newProdDirs.length === 0, { newDirs: newProdDirs });
// ★ 只认「data 之外」的多余产物：B 组（对照）本来就该往 data 里写 ——
//   把它算成「隔离不干净」是探针自己的错（首版就这么错过一次，见报告 §4）。
const homeAfter = listFiles(HOME).filter((f) => f !== 'config.json' && f !== 'data/' && !f.startsWith('data/'));
check('E3', '临时 home 里除了 config.json 没有别的产物（隔离干净）', homeAfter.length === 0, { extra: homeAfter });

const fails = checks.filter((c) => !c.pass);
const report = {
  kind: 'g2a-standalone-readonly-probe', label: LABEL, stamp: STAMP, node: process.version,
  elapsedMs: Date.now() - T0, total: checks.length, pass: checks.length - fails.length, fail: fails.length,
  verdict: fails.length === 0 ? 'PASS' : 'FAIL',
  env: { AGENT_SOUL_READONLY: '1 (A/C/D) · unset (B/C5)', SOUL_STDIO_MODE: 'standalone (A/B) · auto (D)', AGENT_SOUL_SYNC: 'off', AGENT_SOUL_CHAT: 'off' },
  isolation: { home: 'temp', data: 'temp', prodSessions: { pre: preProd, post: postProd }, prodNewDirs: newProdDirs },
  checks,
};
fs.writeFileSync(path.join(EVID, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
fs.writeFileSync(path.join(EVID, 'data-files-A.json'), JSON.stringify(filesA2, null, 2), 'utf8');

// 临时 home 清理（证据留在 evidence/）
let removed = false;
try { fs.rmSync(HOME, { recursive: true, force: true }); removed = !fs.existsSync(HOME); } catch {}
console.log('');
console.log('  ' + report.verdict + '  ' + report.pass + ' PASS / ' + report.fail + ' FAIL  (' + report.elapsedMs + 'ms) · 临时 home 已删=' + removed);
console.log('  证据 ' + EVID);
process.exit(fails.length === 0 ? 0 : 1);
