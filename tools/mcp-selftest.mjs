import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\//, ''));
const SRV = 'src/adapters/mcp.mjs';
// ★ 用临时 data 目录 —— 不这么做会用默认目录（1007 个会话），
//   第一次 soul_recall 要建 6.9 秒的全量索引，必然超过测试的等待窗口。
const DATA = path.join(ROOT, 'data', 'selftest-' + Date.now());
process.env.AGENT_SOUL_DATA = DATA.replace(/\\/g, '/');

const ok = []; const bad = [];

const p = spawn(process.execPath, [SRV], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
let out = '';
let err = '';
p.stdout.on('data', d => { out += d.toString(); });
p.stderr.on('data', d => { err += d.toString(); });

let seq = 0;
function rpc(method, params) {
  const id = ++seq;
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return id;
}
function waitFor(id, ms = 4000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const t = setInterval(() => {
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === id) { clearInterval(t); resolve(m); return; }
      }
      if (Date.now() - start > ms) { clearInterval(t); reject(new Error('等 id=' + id + ' 超时')); }
    }, 40);
  });
}
function push(name, cond, extra) { (cond ? ok : bad).push((cond ? '✓ ' : '✗ ') + name + (extra ? '  → ' + extra : '')); }

await new Promise(r => setTimeout(r, 300));

// 1. 初始化
const i1 = rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
const r1 = await waitFor(i1);
push('initialize 握手', r1.result && r1.result.serverInfo && r1.result.serverInfo.name === 'agent-soul',
  r1.result && r1.result.serverInfo ? r1.result.serverInfo.name + ' v' + r1.result.serverInfo.version : '无 serverInfo');
push('声明 tools 能力', Boolean(r1.result && r1.result.capabilities && r1.result.capabilities.tools));

// 2. 列工具
const i2 = rpc('tools/list', {});
const r2 = await waitFor(i2);
const tools = (r2.result && r2.result.tools) || [];
push('tools/list', tools.length >= 15, tools.map(t => t.name).join(', '));
push('每个工具都有 inputSchema', tools.every(t => t.inputSchema && t.inputSchema.type === 'object'));

// 3. 调 soul_index 写一帧
const i3 = rpc('tools/call', { name: 'soul_index', arguments: { session: 'host-smoke-1', type: 'user', text: '这是一条从宿主推过来的消息，验证 MCP 挂载。' } });
const r3 = await waitFor(i3);
const t3 = r3.result && r3.result.content && r3.result.content[0] && r3.result.content[0].text;
push('tools/call soul_index', Boolean(t3 && t3.includes('已索引')), t3 || JSON.stringify(r3));

// 4. 调 soul_recall 检索
const i4 = rpc('tools/call', { name: 'soul_recall', arguments: { query: 'MCP' } });
const r4 = await waitFor(i4);
const t4 = r4.result && r4.result.content && r4.result.content[0] && r4.result.content[0].text;
push('tools/call soul_recall', Boolean(t4 && t4.includes('host-smoke-1')), (t4 || '').slice(0, 80));

// 5. 调 soul_sessions
const i5 = rpc('tools/call', { name: 'soul_sessions', arguments: {} });
const r5 = await waitFor(i5);
const t5 = r5.result && r5.result.content && r5.result.content[0] && r5.result.content[0].text;
push('tools/call soul_sessions', Boolean(t5 && t5.includes('host-smoke-1')), (t5 || '').slice(0, 60));

// 6. 调不存在的工具
const i6 = rpc('tools/call', { name: 'nope', arguments: {} });
const r6 = await waitFor(i6);
push('未知工具报错', Boolean(r6.error && r6.error.code === -32601), r6.error && r6.error.message);

p.kill();

// 清理测试会话
try { fs.rmSync(path.join(ROOT, 'data/sessions/host-smoke-1'), { recursive: true, force: true }); } catch {}

console.log(''); console.log('=== MCP 适配器自检 ==='); console.log('');
console.log(ok.join('\n'));
if (bad.length) { console.log(''); console.log(bad.join('\n')); }
if (err.trim()) console.log('\n[server stderr] ' + err.trim().split('\n').slice(-2).join(' | '));
console.log(''); console.log(ok.length + ' 通过 / ' + bad.length + ' 失败'); console.log('');
process.exit(bad.length ? 1 : 0);