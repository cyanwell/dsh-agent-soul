// tools/control-live-selftest.mjs —— 「换宿主」的回归门
//
// ★ 它验的不是协议（那是 control-selftest.mjs），是**v4 能不能真的把活派给一个它从没见过的宿主**。
//   做法：起一个假宿主（tools/fake-host.mjs，不 import v4 任何代码），
//   然后通过 MCP 的 soul_ask_host 让它干活，看回执。
//
// ★ 为什么要有这个门：**「能连」和「能推」是两件事。**
//   在这条自检之前，hub.exec() 写着却没有任何调用者 —— 通道全是通的，v4 从来没派过活。

import { spawn } from 'node:child_process';
import http from 'node:http';

const PORT = process.env.AGENT_SOUL_PORT || 7310;
const R = process.cwd();
const PASS = [], FAIL = [];
const ok = (m) => PASS.push(m);
const no = (m) => FAIL.push(m);

const mcp = (name, args) => new Promise((res) => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const rq = http.request({ host: '127.0.0.1', port: PORT, path: '/mcp', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (x) => {
    let b = ''; x.on('data', (c) => b += c); x.on('end', () => {
      try { res(JSON.parse(JSON.parse(b).result.content[0].text)); } catch { res({ raw: b.slice(0, 200) }); }
    });
  });
  rq.on('error', (e) => res({ err: String(e.message) }));
  rq.write(body); rq.end();
});

const child = spawn(process.execPath, ['tools/fake-host.mjs', '127.0.0.1', String(PORT), 'fake-test', 'followup'], { cwd: R, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', (d) => log += d.toString());

await new Promise((r) => setTimeout(r, 2500));

// 1. 假宿主被认出来了
const ctl = await new Promise((res) => {
  http.get({ host: '127.0.0.1', port: PORT, path: '/api/control', timeout: 8000 }, (x) => {
    let b = ''; x.on('data', (c) => b += c); x.on('end', () => { try { res(JSON.parse(b)); } catch { res({}); } });
  }).on('error', () => res({}));
});
const seen = (ctl.hosts || []).some((h) => h.host === 'fake-test');
seen ? ok('假宿主被 v4 认了（hello + welcome）') : no('假宿主没出现在 /api/control');

// 2. ★ 指定它派活 —— 这是解耦的硬证据
const r1 = await mcp('soul_ask_host', { cap: 'followup', action: 'say', args: { text: 'selftest' }, host: 'fake-test', timeoutMs: 5000 });
r1.ok === true && r1.hostName === 'fake-test'
  ? ok('指定假宿主派活成功：' + JSON.stringify(r1.data).slice(0, 60))
  : no('指定假宿主派活失败：' + JSON.stringify(r1).slice(0, 160));

// 3. 它不会的能力要明说，不许静默
const r2 = await mcp('soul_ask_host', { cap: 'huanqi', action: 'break-turn', args: {}, host: 'fake-test', timeoutMs: 3000 });
r2.ok === false && /不会 huanqi/.test(r2.error || '')
  ? ok('不会的能力明确拒绝（不是静默）')
  : no('不会的能力没被拒：' + JSON.stringify(r2).slice(0, 160));

// 4. 自动挑要能说清为什么
const r3 = await mcp('soul_ask_host', { cap: 'followup', action: 'say', args: { text: 'auto' }, timeoutMs: 5000 });
r3.ok === true && r3.why
  ? ok('自动挑会说清理由：' + String(r3.why).slice(0, 70))
  : no('自动挑没有 why：' + JSON.stringify(r3).slice(0, 160));

// 5. 假宿主真的收到了
log.includes('收到派活') ? ok('假宿主日志里确认收到 exec') : no('假宿主日志里没有收到 exec');

child.kill();

console.log(PASS.map((m) => '  ✓ ' + m).join('\n'));
if (FAIL.length) console.log(FAIL.map((m) => '  ✗ ' + m).join('\n'));
console.log('通过 ' + PASS.length + ' 项 · 失败 ' + FAIL.length + ' 项');
process.exit(FAIL.length ? 1 : 0);
