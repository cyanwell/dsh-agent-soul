// 挂载预演 —— 模拟 DSH 启动时对 MCP server 的完整调用序列，逐项计时
//
// ★ 为什么要这个：判据①（真机挂载）只剩「重启 DSH」这一步，
//   但重启前必须知道「DSH 会等我们多久」。如果启动慢，DSH 会被拖住。

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// ★ 2026-11-09：数据目录可隔离。
//   以前这里硬编码 ROOT/data，预演会往生产 data/sessions/preflight-1 写一帧再删；
//   P0 要在不碰生产的前提下跑它，于是改成认 AGENT_SOUL_DATA（与 src/config.mjs 同一个变量）。
//   ★ 不给这个变量时退回 ROOT/data —— 默认行为与改动前完全一致。
const DATA_DIR = path.resolve(process.env.AGENT_SOUL_DATA || path.join(ROOT, 'data'));
const DATA_ARG = DATA_DIR.replace(/\\/g, '/');
const SESSION = 'preflight-1';
const SESSION_DIR = path.join(DATA_DIR, 'sessions', SESSION);

const p = spawn(process.execPath, ['src/adapters/mcp.mjs'], {
  cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, AGENT_SOUL_DATA: DATA_ARG },
});

const t0 = Date.now();
let out = ''; const errs = '';
p.stdout.on('data', d => { out += d.toString(); });
p.stderr.on('data', d => { process.stderr.write('[srv] ' + d.toString()); });

let seq = 0;
function rpc(method, params) {
  const id = ++seq;
  const t = Date.now();
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return { id, t };
}
function waitFor(id, ms = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === id) { clearInterval(timer); resolve(m); return; }
      }
      if (Date.now() - t0 > ms) { clearInterval(timer); reject(new Error('超时 ' + method)); }
    }, 10);
  });
}

const rows = [];
async function step(name, method, params) {
  const { id, t } = rpc(method, params);
  await waitFor(id);
  rows.push([name, Date.now() - t]);
}

// DSH 启动时会走的序列
await step('① initialize（握手）', 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dsh-preflight', version: '1' } });
await step('② tools/list（拿工具清单）', 'tools/list', {});

// 宿主第一次真正用工具
await step('③ soul_persona（取人格）', 'tools/call', { name: 'soul_persona', arguments: {} });
await step('④ soul_index（写一帧）', 'tools/call', { name: 'soul_index', arguments: { session: 'preflight-1', type: 'user', text: '挂载预演：宿主写进来的第一帧。' } });
await step('⑤ soul_recall（第一次检索，要建索引）', 'tools/call', { name: 'soul_recall', arguments: { query: '解耦' } });
await step('⑥ soul_recall（第二次，索引已建好）', 'tools/call', { name: 'soul_recall', arguments: { query: 'huanqi' } });
await step('⑦ soul_sessions（列会话）', 'tools/call', { name: 'soul_sessions', arguments: { limit: 3 } });
await step('⑧ soul_health（健康）', 'tools/call', { name: 'soul_health', arguments: {} });

const total = rows.reduce((s, r) => s + r[1], 0);
console.log('');
console.log('=== 挂载预演（模拟 DSH 启动序列）===');
console.log('');
console.log('  数据目录 ' + DATA_DIR + (process.env.AGENT_SOUL_DATA ? '（AGENT_SOUL_DATA 指定）' : '（默认 ROOT/data）'));
console.log('');
for (const [name, ms] of rows) {
  const bar = '█'.repeat(Math.min(40, Math.max(1, Math.round(ms / 60))));
  console.log('  ' + name.padEnd(36) + String(ms).padStart(6) + 'ms  ' + bar);
}
console.log('');
console.log('  合计 ' + total + 'ms');
console.log('');

// 判定
const init = rows[0][1];
const firstRecall = rows[4][1];
const secondRecall = rows[5][1];
console.log('  判据:');
console.log('    握手 < 1000ms      ' + (init < 1000 ? '✓ ' + init + 'ms' : '✗ ' + init + 'ms'));
console.log('    第二次检索 < 500ms  ' + (secondRecall < 500 ? '✓ ' + secondRecall + 'ms' : '✗ ' + secondRecall + 'ms'));
console.log('    首次检索 ≤ 5000ms   ' + (firstRecall <= 5000 ? '✓ ' + firstRecall + 'ms（建索引）' : '✗ ' + firstRecall + 'ms'));
console.log('');

// 检查写入的帧真落盘了（落点跟着 DATA_DIR 走，不再钉死 ROOT/data）
const f = path.join(SESSION_DIR, 'frames.jsonl');
if (fs.existsSync(f)) {
  const n = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length;
  console.log('  落盘校验: ' + SESSION + ' 有 ' + n + ' 帧   ' + (n >= 2 ? '✓' : '✗'));
  fs.rmSync(SESSION_DIR, { recursive: true, force: true });
} else {
  console.log('  落盘校验: ✗ 找不到 ' + SESSION + '（' + SESSION_DIR + '）');
}

p.kill();
process.exit(0);