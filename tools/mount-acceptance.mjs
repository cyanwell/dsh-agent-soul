// ★ 这个脚本会往 data/sessions 里写测试会话（判据③必须真写一帧才算验）。
//   **跑完要清掉** —— 否则它们会被算进「真实会话数」，也会出现在 soul_sessions 里。
//   2026-11-07 忘了一次，同一个前缀清了两遍。
// mount-acceptance.mjs —— 判据① 的「真机挂载」验收
//
// ★ 这个脚本做的事，和 DSH 启动时做的是同一件：
//   读 %DSH_HOME%/mcp-hub/servers.json 里 agent-soul 那一条，
//   **按它的 command / args / env 原样 spawn**，然后走标准 MCP 握手。
//
// ★★ 为什么这样算数：
//   「挂在真实 DSH 上跑通」= DSH 用它的配置能连上、能列出工具、能调用、调用有正确结果。
//   而 DSH 连它的方式就是这个配置。**照它跑一遍，拿到同样的结果，就是同一条链路。**
//   剩下的差别只有「DSH 那个进程是什么时候启动的」—— 那是时序，不是能力。
//
// ★ 用法：node tools/mount-acceptance.mjs [--host <另一个 harness 的 servers.json>]
//   不给 --host 就用本机 DSH 的那份。
//
// ★ 判据（四项全中才算通过）：
//   ① initialize 成功，serverInfo.name === 'agent-soul'
//   ② tools/list 至少含 soul_index / soul_recall / soul_persona 三个
//   ③ soul_index 写一帧 → soul_recall **立刻**搜到同一句（写入即索引）
//   ④ soul_frame 按 seq 能读回那一帧的完整原文

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const hi = args.indexOf('--host');
const SERVERS = hi >= 0 ? args[hi + 1]
  : path.join(process.env.DSH_HOME || 'D:/AI/dsh/home', 'mcp-hub', 'servers.json');

function fail(msg) { console.error('✗ ' + msg); process.exit(1); }
if (!fs.existsSync(SERVERS)) fail('找不到 ' + SERVERS + '（用 --host 指定）');
const raw = JSON.parse(fs.readFileSync(SERVERS, 'utf8'));
const list = Array.isArray(raw) ? raw : raw.servers || [];
const cfg = list.find((s) => s.serverName === 'agent-soul');
if (!cfg) fail(SERVERS + ' 里没有 agent-soul 这一条 —— 先在宿主里把它加上');
if (cfg.enabled === false) fail('agent-soul 在配置里是 disabled');

console.log('配置来源  ' + SERVERS);
console.log('command   ' + cfg.command);
console.log('args      ' + JSON.stringify(cfg.args));
console.log('');

// —— 按配置原样起 ——
const p = spawn(cfg.command, cfg.args, {
  env: { ...process.env, ...(cfg.env || {}) },
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: cfg.cwd || undefined,
});

let buf = '';
let stderrText = '';
p.stdout.on('data', (d) => { buf += d.toString(); });
p.stderr.on('data', (d) => { stderrText += d.toString(); });
p.on('exit', (code) => { if (code !== 0 && code !== null) console.error('进程退出码 ' + code + '\n' + stderrText.slice(0, 500)); });

const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');

/** 等某个 id 的回包。★ 不回包时给超时，不是无限等 —— 无限等就是卡死。 */
function waitFor(id, ms = 30000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      for (const line of buf.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        let j; try { j = JSON.parse(s); } catch { continue; }
        if (j.id === id) { clearInterval(iv); return resolve(j); }
      }
      if (Date.now() - t0 > ms) { clearInterval(iv); resolve(null); }
    }, 100);
  });
}

let pass = 0, failed = 0;
const check = (n, ok, detail) => {
  if (ok) { pass++; console.log('  ✓ ' + n + (detail ? '  ' + detail : '')); }
  else { failed++; console.log('  ✗ ' + n + (detail ? '  ' + detail : '')); }
};

// —— ① 握手 ——
send({ jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mount-acceptance', version: '1' } } });
const init = await waitFor(1, 20000);
check('① initialize', Boolean(init && init.result && init.result.serverInfo),
  init && init.result ? JSON.stringify(init.result.serverInfo) : '没有回包（20 秒）');
if (!init) { p.kill(); console.log('\n✗ 连不上 —— 后面不用跑了'); process.exit(1); }
send({ jsonrpc: '2.0', method: 'notifications/initialized' });

// —— ② 工具清单 ——
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
const tl = await waitFor(2);
const names = tl && tl.result && tl.result.tools ? tl.result.tools.map((t) => t.name) : [];
const need = ['soul_index', 'soul_recall', 'soul_persona'];
const miss = need.filter((n) => !names.includes(n));
check('② tools/list', names.length > 0 && miss.length === 0,
  names.length + ' 个' + (miss.length ? '，缺 ' + miss.join(', ') : ''));

/** 调一个工具。★ 错误要分两种读法：result.content 是正文，error 是协议级失败。 */
async function call(id, name, argv) {
  send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: argv } });
  const r = await waitFor(id);
  if (!r) return { ok: false, text: '', error: '超时' };
  const text = r.result && r.result.content ? String(r.result.content[0] && r.result.content[0].text || '') : '';
  return { ok: !r.error, text, error: r.error ? (r.error.message || JSON.stringify(r.error)) : null };
}

// —— ③ 写入即索引 ——
const sid = 'mount-check-' + Date.now();
const mark = '挂载探针-' + Math.random().toString(36).slice(2, 10);
const w = await call(3, 'soul_index', {
  session: sid, type: 'user',
  text: '这一帧是用来验证「写入即索引」的，标记 ' + mark,
  meta: { source: 'mount-acceptance', at: new Date().toISOString() },
});
check('③a soul_index 写帧', w.ok, w.text.split('\n')[0] || w.error || '');

const r = await call(4, 'soul_recall', { query: mark, limit: 3 });
check('③b soul_recall 立刻搜到', r.ok && r.text.includes(mark),
  r.ok ? (r.text.includes(mark) ? '命中' : '没命中（写入和索引不同步）') : r.error);

// —— ④ 按 seq 读回原文 ——
const f = await call(5, 'soul_frame', { session: sid, seq: 1 });
check('④ soul_frame 读回', f.ok && f.text.includes(mark), f.ok ? (f.text.includes(mark) ? '完整原文一致' : '读到帧但内容不符') : f.error);

// —— 附：人格层 ——
const per = await call(6, 'soul_persona', {});
check('附 soul_persona', per.ok && per.text.length > 100, per.ok ? per.text.length + ' 字符' : per.error);

p.kill();
console.log('');
console.log(failed === 0
  ? '判据① 通过：' + pass + ' 项全绿'
  : '判据① 未通过：' + pass + ' 通过 / ' + failed + ' 失败');
process.exit(failed === 0 ? 0 : 1);
