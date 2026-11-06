import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\//, ''));
const DATA = path.join(ROOT, 'data', 'waker-smoke-' + Date.now());
const p = spawn(process.execPath, ['src/adapters/mcp.mjs'], {
  cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, AGENT_SOUL_DATA: DATA.replace(/\\/g, '/') },
});
let out = '';
p.stdout.on('data', d => { out += d.toString(); });
p.stderr.on('data', d => process.stderr.write('[srv] ' + d.toString()));
let seq = 0;
function rpc(m, params) { const id = ++seq; p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: m, params }) + '\n'); return id; }
function wait(id, ms = 60000) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      for (const l of out.split('\n')) {
        if (!l.trim()) continue;
        let m; try { m = JSON.parse(l); } catch { continue; }
        if (m.id === id) { clearInterval(timer); res(m); return; }
      }
      if (Date.now() - t0 > ms) { clearInterval(timer); rej(new Error('超时')); }
    }, 20);
  });
}
const call = async (name, args) => {
  const r = await wait(rpc('tools/call', { name, arguments: args }));
  if (r.error) throw new Error(r.error.message);
  return r.result.content[0].text;
};
await new Promise(r => setTimeout(r, 700));
await wait(rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} }));
const tl = await wait(rpc('tools/list', {}));
console.log('工具（' + tl.result.tools.length + '）: ' + tl.result.tools.map(t => t.name).join(', '));
console.log('');

console.log('— 空台账 —');
console.log(await call('soul_waker', {}));
console.log('');

console.log('— 收两条事件 —');
console.log(await call('soul_waker', { action: 'ingest', key: 'ev-1', title: 'QQ 群里有人问部署进度', from: 'qq', tier: 'act' }));
console.log(await call('soul_waker', { action: 'ingest', key: 'ev-2', title: '定时巡检发现问题', from: 'heartbeat', tier: 'watch' }));
console.log('');

console.log('— 判一条 —');
console.log(await call('soul_waker', { action: 'decide', key: 'ev-1', decision: 'resume', charter: 'pass', note: '已经做完了' }));
console.log('');

console.log('— 再看台账 —');
console.log(await call('soul_waker', {}));
console.log('');

console.log('— 不传 charter 判第二条（必须保留 unchecked）—');
console.log(await call('soul_waker', { action: 'decide', key: 'ev-2', decision: 'audit' }));
console.log('');

// 直接读文件确认
const lf = path.join(DATA, 'ledger.json');
if (fs.existsSync(lf)) {
  const j = JSON.parse(fs.readFileSync(lf, 'utf8'));
  console.log('落盘校验: ' + j.events.length + ' 条   ' + j.events.map(e => e.key + '=' + e.decision + '/' + e.charter + '/' + e.stage).join('  '));
} else console.log('落盘校验: ✗ 找不到 ledger.json');

p.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
process.exit(0);