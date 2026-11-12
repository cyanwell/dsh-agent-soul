// MCP 工具层：批量推帧 + 检索带上下文
import path from 'node:path';
import fs from 'node:fs';
import { TOOLS, callTool, SERVER_INFO } from '../src/adapters/mcp-tools.mjs';
import { SessionStore } from '../src/session/store.mjs';
import { loadConfig } from '../src/config.mjs';

const ok = []; const bad = [];
const push = (n, c, e) => (c ? ok : bad).push((c ? '✓ ' : '✗ ') + n + (e ? '  → ' + e : ''));

const DATA = path.join(process.cwd(), 'data', 'tools-' + Date.now());
process.env.AGENT_SOUL_DATA = DATA.replace(/\\/g, '/');

// 1. 工具清单
push('12 个工具', TOOLS.length >= 15, TOOLS.map(t => t.name).join(', '));
push('每个都有 inputSchema', TOOLS.every(t => t.inputSchema && t.inputSchema.type === 'object'));
const idx = TOOLS.find(t => t.name === 'soul_index');
push('soul_index 支持 frames 数组', Boolean(idx.inputSchema.properties.frames), '批量模式');
push('soul_index 只要 session 必填', JSON.stringify(idx.inputSchema.required) === '["session"]', 'type/text 变成可选（批量时不用）');
const rec = TOOLS.find(t => t.name === 'soul_recall');
push('soul_recall 支持 context', Boolean(rec.inputSchema.properties.context));

// 2. 批量推帧
const r1 = await callTool('soul_index', {
  session: 'host-batch-1',
  frames: [
    { type: 'user', text: '第一句：我想把传输层拆出来' },
    { type: 'assistant', text: '第二句：可以，先看它依赖什么' },
    { type: 'tool_call', text: '读了 transport.js', meta: { name: 'read_file' } },
    { type: 'tool_result', text: '它只依赖 node:fs，不碰 renderer' },
    { type: 'assistant', text: '结论：可以拆' },
  ],
});
push('★ 批量推 5 帧', r1.includes('共 5 帧'), r1);

// 3. 校验真写进去了
const st = new SessionStore(DATA);
const s = st.load('host-batch-1');
push('帧数对', s.frames.length === 6, s.frames.length + ' 帧（含帧 0）');
push('每条都进索引', st.search('host-batch-1', '拆').length >= 1, '搜「拆」命中 ' + st.search('host-batch-1', '拆').length);

// 4. 检索带上下文
const plain = await callTool('soul_recall', { query: '结论', session: 'host-batch-1' });
const withCtx = await callTool('soul_recall', { query: '结论', session: 'host-batch-1', context: 1 });
push('默认不带上下文', plain.split('\n').length === 1, plain.split('\n').length + ' 行');
push('★ context=1 带前后各一帧', withCtx.split('\n').length > plain.split('\n').length, withCtx.split('\n').length + ' 行');
push('★ 上下文有方向标记', withCtx.includes('↑') || withCtx.includes('↓'), withCtx.split('\n').slice(1, 3).join(' / '));

// 5. 单帧模式仍然能用
const r2 = await callTool('soul_index', { session: 'host-batch-1', type: 'user', text: '单帧追加' });
push('单帧模式没坏', r2.includes('#' + 6), r2);

// 6. 批量里混了坏帧
const r3 = await callTool('soul_index', { session: 'host-batch-2', frames: [
  { type: 'user', text: '好的' },
  { type: 'assistant' },              // 缺 text
  { text: '缺 type' },                // 缺 type
  { type: 'user', text: '也是好的' },
] });
push('★ 坏帧被跳过、好帧照写', r3.includes('共 2 帧'), r3);

// 7. 空批量
const r4 = await callTool('soul_index', { session: 'host-batch-3', frames: [] });
push('空数组有明确回应', r4.includes('没给帧'), r4);

// 8. 单帧模式缺参数
const r5 = await callTool('soul_index', { session: 'host-batch-3' });
push('缺参数有明确提示', r5.includes('要给 type 和 text'), r5);

// 9. 未知工具
let noTool = null;
try { await callTool('nope', {}); } catch (e) { noTool = e; }
push('未知工具抛 NO_TOOL', noTool && noTool.code === 'NO_TOOL', noTool && noTool.message);

// 10. ★ soul_context 不传 session —— 2026-11-09 之前这里必抛 ReferenceError：
//     soul_context 分支写着裸 `ctx.sessionId`，而 callTool 当时只有两个参数。
//     坏了多久没人发现，是因为**所有调用都显式给了 session**。
//     断言三件事：不抛 / 可读 / 说清取的是谁。
let ctxErr = null; let ctxOut = '';
try { ctxOut = await callTool('soul_context', {}); } catch (e) { ctxErr = e; }
push('★ soul_context 不传 session 不抛', !ctxErr,
  ctxErr ? (ctxErr.constructor.name + ': ' + ctxErr.message) : '没抛，返回 ' + String(ctxOut).split('\n').length + ' 行');
push('★ 不传 session 时输出可读（有时间 + 说清取谁）',
  typeof ctxOut === 'string' && ctxOut.includes('现在：') &&
    /取最近写过的那条|一条会话都没有|取调用者/.test(ctxOut),
  String(ctxOut).split('\n').slice(0, 2).join(' / '));
push('★ 退回「最近写过的那条」时明说不一定是你',
  ctxOut.includes('这可能不是你') || ctxOut.includes('一条会话都没有'),
  String(ctxOut).split('\n')[1]);

// 11. 显式给了 session 就不该再解释「没指定会话」
//     —— 第一版修的时候把这段写成 if/else 链没加 args.session 守卫，踩过一次。
const explicit = await callTool('soul_context', { session: 'host-batch-1' });
push('显式 session 不解释来源（不冒领）', !explicit.includes('没指定会话'),
  String(explicit).split('\n').slice(0, 2).join(' / '));

// 12. ★ 传第三参数 ctx 时真的读到它 —— 锁住「不再写回裸 ctx」。
//     形状照 src/tools/registry.mjs 的 execute(name, args, ctx)。
const viaCtx = await callTool('soul_context', {}, { sessionId: 'host-batch-2' });
push('★ ctx.sessionId 当作调用者', viaCtx.includes('取调用者：host-batch-2'),
  String(viaCtx).split('\n')[1] || viaCtx);

try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}

console.log(''); console.log('=== MCP 工具层自检 ==='); console.log('');
console.log(ok.join('\n'));
if (bad.length) { console.log(''); console.log(bad.join('\n')); }
console.log(''); console.log(ok.length + ' 通过 / ' + bad.length + ' 失败'); console.log('');
process.exit(bad.length ? 1 : 0);