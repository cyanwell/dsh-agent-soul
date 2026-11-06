import { spawn } from 'node:child_process';
import path from 'node:path';
const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\//, ''));
const p = spawn(process.execPath, ['src/adapters/mcp.mjs'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
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
await new Promise(r => setTimeout(r, 600));
await wait(rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} }));
const tl = await wait(rpc('tools/list', {}));
console.log('工具: ' + tl.result.tools.map(t => t.name).join(', '));
const r = await wait(rpc('tools/call', { name: 'soul_autonomy', arguments: {} }));
console.log('');
console.log('=== soul_autonomy ===');
console.log(r.result ? r.result.content[0].text : JSON.stringify(r));
p.kill();
process.exit(0);