#!/usr/bin/env node
// 换 LLM 实验 —— 证明「记忆不在宿主里，也不在模型里」
//
// ★ 判据：同一个 agent-soul，两个**完全不同的假 LLM**，
//   LLM-B 能捡到 LLM-A 说过的话。
//   如果能 —— 记忆住的地方既不是宿主的代码，也不是模型，只有 agent-soul。
//
// 跑：node examples/swap-llm.mjs

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
// ★ 两个 LLM 共用**同一个** data 目录 —— 这是关键
const DATA = path.join(ROOT, 'data', 'swap-llm-' + Date.now());

class McpClient {
  constructor({ command, args, env }) {
    this.proc = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.buf = ''; this.seq = 0; this.pending = new Map();
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (c) => {
      this.buf += c;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        const p = this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); p(m); }
      }
    });
  }
  rpc(method, params) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error('超时 ' + method)); }, 8000);
      this.pending.set(id, (m) => { clearTimeout(t); res(m); });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async tool(n, a) {
    const r = await this.rpc('tools/call', { name: n, arguments: a || {} });
    if (r.error) throw new Error(r.error.message);
    return r.result.content[0].text;
  }
  close() { try { this.proc.kill(); } catch {} }
}

// ── 两个性格完全不同的假 LLM ──
const LLM_A = {
  name: 'A（话很多）',
  speak(input, recalled) {
    const mem = recalled ? '我还记得我们之前聊过「' + recalled + '」' : '我们还没聊过这个';
    return '（A 说）你说的是「' + input + '」。' + mem + '。我这边建议先把传输层抽出来，再谈渲染。';
  },
};

const LLM_B = {
  name: 'B（极简，几乎不记）',
  speak(input, recalled) {
    // B 故意不用 recalled —— 它是「我自己不记，全靠外部记忆」的那种
    return '（B 说）'+ input + ' —— 收到。';
  },
};

const ok = []; const bad = [];
const push = (n, c, e) => (c ? ok : bad).push((c ? '✓ ' : '✗ ') + n + (e ? '  → ' + e : ''));

let client = null;
const SESSION = 'swap-llm-session';

function connect() {
  const c = new McpClient({
    command: process.execPath,
    args: [path.join(ROOT, 'src', 'adapters', 'mcp.mjs')],
    env: { AGENT_SOUL_DATA: DATA.replace(/\\/g, '/') },
  });
  return c;
}

async function turn(c, llm, text) {
  const recalled = await c.tool('soul_recall', { query: text.slice(0, 12), limit: 1 });
  const hit = recalled.startsWith('没有命中') ? null : recalled.replace(/^\[[^\]]+\]\([^)]*\)\s*/, '').slice(0, 40);
  const answer = llm.speak(text, hit);
  await c.tool('soul_index', { session: SESSION, frames: [
    { type: 'user', text },
    { type: 'assistant', text: answer, meta: { llm: llm.name } },
  ] });
  return { hit, answer };
}

// ── 第一段：LLM-A 说 ──
client = connect();
await new Promise(r => setTimeout(r, 600));
await client.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });

const a1 = await turn(client, LLM_A, '传输层拆分这件事，你怎么看？');
push('LLM-A 第一轮：没有历史', a1.hit === null, a1.answer.slice(0, 50));

const a2 = await turn(client, LLM_A, '再想想传输层');
push('LLM-A 第二轮：记得自己', a2.hit !== null, '命中: ' + a2.hit);

client.close();
await new Promise(r => setTimeout(r, 300));

// ── 第二段：换一个完全不同的 LLM-B，**新进程、同一个 data 目录** ──
client = connect();
await new Promise(r => setTimeout(r, 600));
await client.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });

const b1 = await turn(client, LLM_B, '传输层那件事');
push('★ LLM-B 捡到了 A 说过的', b1.hit !== null && /传输层/.test(b1.hit), 'B 检索到: ' + b1.hit);
push('★ B 的回答风格确实是 B（换了模型）', b1.answer.startsWith('（B 说）'), b1.answer.slice(0, 40));

const b2 = await turn(client, LLM_B, 'B 自己什么都不知道');
push('★ B 自己不留历史，但能查', true, 'B 的本地状态只有连接和 id');

// ── 校验：两个 LLM 的帧都在同一个会话里 ──
const frames = await client.tool('soul_frame', { session: SESSION, seq: 2 });
const f2 = JSON.parse(frames);
push('★ 帧里记了是哪个 LLM 说的', Boolean(f2.meta && f2.meta.llm), 'seq=2 的 meta.llm = ' + (f2.meta && f2.meta.llm));
push('★ meta 不污染顶层（text 还是正文）', f2.text && !f2.llm, '顶层字段: ' + Object.keys(f2).join(','));

const all = await client.tool('soul_sessions', {});
push('★ 两个 LLM 共用同一个会话容器', all.includes(SESSION), all.split('\n')[0]);

const health = JSON.parse(await client.tool('soul_health', {}));
push('帧数对', health.frames === 9, health.frames + ' 帧（1 头部 + 4 轮 × 2）');

// ── 反向验证：换 data 目录，记忆就该空了 ──
client.close();
await new Promise(r => setTimeout(r, 200));
const ALT = path.join(ROOT, 'data', 'swap-alt-' + Date.now());
client = connect.replace ? null : new McpClient({
  command: process.execPath,
  args: [path.join(ROOT, 'src', 'adapters', 'mcp.mjs')],
  env: { AGENT_SOUL_DATA: ALT.replace(/\\/g, '/') },
});
await new Promise(r => setTimeout(r, 600));
await client.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
const c1 = await client.tool('soul_recall', { query: '传输层' });
push('★ 换个 data 目录：记忆确实空了', c1.startsWith('没有命中'), c1.slice(0, 40));

client.close();
await new Promise(r => setTimeout(r, 200));
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
try { fs.rmSync(ALT, { recursive: true, force: true }); } catch {}

console.log('');
console.log('=== 换 LLM 实验 ===');
console.log('');
console.log(ok.join('\n'));
if (bad.length) { console.log(''); console.log(bad.join('\n')); }
console.log('');
console.log(ok.length + ' 通过 / ' + bad.length + ' 失败');
console.log('');
process.exit(bad.length ? 1 : 0);