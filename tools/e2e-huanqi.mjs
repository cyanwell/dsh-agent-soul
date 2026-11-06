// 端到端：假 LLM（只吐 reasoning 不吐正文）→ 看 huanqi 会不会真的断
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { SessionStore } from '../src/session/store.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { AgentLoop } from '../src/agent/loop.mjs';
import { ToolRegistry } from '../src/tools/registry.mjs';
import { HuanqiDetector } from '../src/organs/huanqi.mjs';
import { ROOT } from '../src/config.mjs';
import { FRAME } from '../src/session/frame.mjs';

const ok = []; const bad = [];
const push = (n, c, e) => (c ? ok : bad).push((c ? '✓ ' : '✗ ') + n + (e ? '  → ' + e : ''));

// —— 假 LLM：每次只返回 reasoning_content，永远不返回 content ——
let calls = 0;
const BLEED = '我需要再想想。好。执行。好。执行。'.repeat(40);
const srv = http.createServer((req, res) => {
  calls++;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  // 分三块推 reasoning
  for (let i = 0; i < 3; i++) {
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: BLEED.slice(i * 200, (i + 1) * 200) } }] }) + '\n\n');
  }
  res.write('data: [DONE]\n\n');
  res.end();
});

await new Promise(r => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;

const dataDir = path.join(ROOT, 'data', 'e2e-' + Date.now());
const store = new SessionStore(dataDir);
const llm = new LlmClient({ baseUrl: 'http://127.0.0.1:' + port, apiKey: 'test', model: 'fake' });
const tools = new ToolRegistry();
const loop = new AgentLoop({ store, llm, tools, config: { context: { maxFrames: 20 }, persona: { files: [] } } });

// 挂上 huanqi，阈值 3
let det = null; let lastV = null;
loop.organs.push({
  name: 'huanqi',
  beforeCall: () => { if (!det) det = new HuanqiDetector({ stallThreshold: 3 }); },
  afterCall: (obs) => {
    const v = det.observe({ hasOutput: obs.hasOutput, reasoning: obs.reasoning });
    lastV = v;
    if (det.shouldBreak()) { det.reset(); return { breakTurn: true, reason: '连续 ' + v.consecutive + ' 次没产出（' + v.reason + '）' }; }
    return undefined;
  },
  endTurn: () => (lastV && lastV.stalled) ? { voidTurn: true, reason: lastV.reason } : undefined,
});

const h = store.create(ROOT, null);
const sid = h.id;
store.append(sid, FRAME.USER, { text: '开始吧' });

let result = null;
try { result = await loop.turn(sid, () => {}); } catch (e) { bad.push('✗ 回合抛异常: ' + e.message); }

srv.close();

const frames = store.load(sid).frames;
const errFrame = frames.find(f => f.type === FRAME.ERROR);
const assistantFrames = frames.filter(f => f.type === FRAME.ASSISTANT);

push('假 LLM 被调用了', calls > 0, calls + ' 次');
push('★ 回合被 huanqi 中断', Boolean(result && result.error && result.error.includes('换气')), result && result.error ? result.error.slice(0, 60) : '(没中断)');
push('★ 中断信息里带原因', Boolean(result && result.error && /reasoning-only|repeated-material/.test(result.error)), '含判据名');
push('★ 恰好调用 3 次（不是 1 次就断）', calls === 3, 'calls=' + calls + '，阈值 3');
push('★ 中断写进了会话（ERROR 帧）', Boolean(errFrame), errFrame ? errFrame.message.slice(0, 50) : '(无)');
push('★ 每次调用都落了 assistant 帧（推理也留档）', assistantFrames.length === 3, assistantFrames.length + ' 帧，reasoning 长度 ' + (assistantFrames[0] && assistantFrames[0].reasoning ? assistantFrames[0].reasoning.length : 0));

// 对照：正常 LLM 不该被断
const srv2 = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '好的，我明白了。' } }] }) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
});
await new Promise(r => srv2.listen(0, '127.0.0.1', r));
const port2 = srv2.address().port;

const store2 = new SessionStore(path.join(ROOT, 'data', 'e2e2-' + Date.now()));
const llm2 = new LlmClient({ baseUrl: 'http://127.0.0.1:' + port2, apiKey: 'test', model: 'fake' });
const loop2 = new AgentLoop({ store: store2, llm: llm2, tools: new ToolRegistry(), config: { context: { maxFrames: 20 }, persona: { files: [] } } });
let det2 = null; let lastV2 = null;
loop2.organs.push({
  name: 'huanqi',
  beforeCall: () => { if (!det2) det2 = new HuanqiDetector({ stallThreshold: 3 }); },
  afterCall: (obs) => {
    const v = det2.observe({ hasOutput: obs.hasOutput, reasoning: obs.reasoning });
    lastV2 = v;
    if (det2.shouldBreak()) { det2.reset(); return { breakTurn: true, reason: v.reason }; }
    return undefined;
  },
  endTurn: () => (lastV2 && lastV2.stalled) ? { voidTurn: true, reason: lastV2.reason } : undefined,
});
const h2 = store2.create(ROOT, null);
const sid2 = h2.id;
store2.append(sid2, FRAME.USER, { text: '你好' });
const r2 = await loop2.turn(sid2, () => {});
srv2.close();

push('★ 正常回复不被误杀', !r2.error && r2.text.includes('明白了'), r2.text || '(空)');

try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
try { fs.rmSync(path.join(ROOT, 'data', 'e2e2-' + Date.now()), { recursive: true, force: true }); } catch {}

console.log(''); console.log('=== 换气端到端（假 LLM）==='); console.log('');
console.log(ok.join('\n'));
if (bad.length) { console.log(''); console.log(bad.join('\n')); }
console.log(''); console.log(ok.length + ' 通过 / ' + bad.length + ' 失败'); console.log('');
process.exit(bad.length ? 1 : 0);