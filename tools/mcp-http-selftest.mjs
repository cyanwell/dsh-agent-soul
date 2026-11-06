// MCP over HTTP —— 调用方是 curl.exe（证明不依赖任何 MCP 客户端库）
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { ROOT } from '../src/config.mjs';

const PORT = 7399;
const DATA = path.join(ROOT, 'data', 'curl-' + Date.now());
const ok = []; const bad = [];
const push = (n, c, e) => (c ? ok : bad).push((c ? '✓ ' : '✗ ') + n + (e ? '  → ' + e : ''));

const env = { ...process.env, AGENT_SOUL_MCP_PORT: String(PORT), AGENT_SOUL_DATA: DATA.replace(/\\/g, '/') };
const p = spawn(process.execPath, ['src/adapters/mcp-http.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise(r => setTimeout(r, 900));

const base = 'http://127.0.0.1:' + PORT + '/mcp';
function curl(args) {
  try { return execFileSync('curl.exe', ['-s', '--max-time', '8', ...args], { encoding: 'utf8', timeout: 12000 }); }
  catch (e) { return 'CURL_FAIL: ' + (e.stdout || e.message); }
}
function post(body) {
  return curl(['-X', 'POST', base, '-H', 'Content-Type: application/json', '-d', JSON.stringify(body)]);
}

const g = curl([base]);
push('curl GET /mcp', g.includes('agent-soul'), g.slice(0, 80));

const r1 = JSON.parse(post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } }));
push('curl initialize', r1.result?.serverInfo?.name === 'agent-soul', r1.result?.serverInfo?.name + ' v' + r1.result?.serverInfo?.version);

const r2 = JSON.parse(post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
push('curl tools/list', (r2.result?.tools || []).length >= 15, (r2.result?.tools || []).map(t => t.name).join(', '));

const r3 = JSON.parse(post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'soul_index', arguments: { session: 'curl-host-001', type: 'user', text: '这是一个用 curl 冒充的宿主写进来的帧' } } }));
push('curl soul_index', String(r3.result?.content?.[0]?.text || '').includes('已索引'), r3.result?.content?.[0]?.text);

const r4 = JSON.parse(post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'soul_recall', arguments: { query: 'curl 冒充' } } }));
const t4 = String(r4.result?.content?.[0]?.text || '');
push('curl soul_recall', t4.includes('curl-host-001'), t4.slice(0, 100));

const r5 = JSON.parse(post({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'soul_persona', arguments: {} } }));
const t5 = String(r5.result?.content?.[0]?.text || '');
const personaStat = (t5.match(/已装 \d+ 个文件[^\n]*/) || [null])[0];
push('curl soul_persona：分层标签', t5.includes('永不裁剪'));
push('★ curl soul_persona：尾部统计行', Boolean(personaStat), personaStat || '没找到「已装 N 个文件」');

const r6 = JSON.parse(post({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope', arguments: {} } }));
push('curl 未知工具报错', r6.error?.code === -32601, r6.error?.message);

// 传输无关：同一个 soul_index 走 HTTP 写的帧，stdio 那边也该能读到
const { SessionStore } = await import('../src/session/store.mjs');
const st = new SessionStore(DATA.replace(/\\/g, '/'));
const hits = st.searchAll('curl 冒充');
push('★ HTTP 写的帧，直接读文件也能找到', hits.length >= 1, hits.length + ' 条');

p.kill();
await new Promise(r => setTimeout(r, 200));
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}

console.log(''); console.log('=== MCP over HTTP（调用方 curl.exe）==='); console.log('');
console.log(ok.join('\n'));
if (bad.length) { console.log(''); console.log(bad.join('\n')); }
console.log(''); console.log(ok.length + ' 通过 / ' + bad.length + ' 失败'); console.log('');
process.exit(bad.length ? 1 : 0);