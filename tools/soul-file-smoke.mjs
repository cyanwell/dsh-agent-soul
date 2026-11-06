import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\//, ''));
const DATA = path.join(ROOT, 'data', 'file-smoke-' + Date.now());
const p = spawn(process.execPath, ['--max-old-space-size=4096', 'src/adapters/mcp.mjs'], {
  cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, AGENT_SOUL_DATA: DATA.replace(/\\/g, '/') },
});
let out = '';
p.stdout.on('data', d => { out += d.toString(); });
p.stderr.on('data', d => process.stderr.write('[srv] ' + d.toString()));
let seq = 0;
function rpc(m, params) { const id = ++seq; p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: m, params }) + '\n'); return id; }
function wait(id, ms = 120000) {
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

console.log('— 搜书房「摘要 索引」 —');
console.log((await call('soul_file', { terms: ['摘要', '索引'], limit: 3 })).slice(0, 900));
console.log('');

console.log('— 搜书房「判据 他人」 —');
console.log((await call('soul_file', { terms: ['判据', '他人'], limit: 2 })).slice(0, 700));
console.log('');

console.log('— 打开一个指针 —');
const txt = await call('soul_file', { ptr: 'file:D:/AI/yanqing-soul/10-宪章/约束体系-要·不·禁止.md:1' });
console.log(txt.slice(0, 700));
console.log('');

p.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
process.exit(0);