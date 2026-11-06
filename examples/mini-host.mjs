#!/usr/bin/env node
// 迷你宿主 —— agent-soul 接入的最小完整示例
//
// ★ 这不是文档，是能跑的代码。它演示一个「第三方宿主」怎么用 agent-soul：
//   ① spawn 它（或连它的 HTTP 端口）
//   ② initialize / tools/list
//   ③ 每轮开始前：soul_persona 取人格，拼进自己的 system prompt
//   ④ 每轮开始前：soul_recall 检索相关历史，拼进上下文
//   ⑤ 一轮结束时：soul_index **批量**把这轮的帧推过去
//
// ★ 这个宿主自己没有记忆 —— 记忆全在 agent-soul 里。
//   换掉它的 LLM、换掉它的 UI，记忆不动。这就是解耦的样子。
//
// 跑：node examples/mini-host.mjs

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(ROOT, 'data', 'mini-host-' + Date.now());

// ── 一个极简的 MCP 客户端（真宿主会用官方 SDK，这里手写最小版） ──
class McpClient {
  constructor({ command, args, env }) {
    this.proc = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.buf = '';
    this.seq = 0;
    this.pending = new Map();
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        const p = this.pending.get(msg.id);
        if (p) { this.pending.delete(msg.id); p(msg); }
      }
    });
  }

  rpc(method, params, timeoutMs) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error('超时: ' + method)); }, timeoutMs || 8000);
      this.pending.set(id, (m) => { clearTimeout(t); resolve(m); });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async tool(name, args) {
    const r = await this.rpc('tools/call', { name, arguments: args || {} });
    if (r.error) throw new Error(r.error.message);
    return r.result.content[0].text;
  }

  close() { try { this.proc.kill(); } catch {} }
}

// ── 迷你宿主的「一轮」 ──
class MiniHost {
  constructor(client, sessionId) {
    this.mcp = client;
    this.sessionId = sessionId;
    this.persona = '';
    this.llmCalls = 0;
  }

  /** ① 启动时取一次人格，之后拼进每次的 system prompt */
  async bootstrap() {
    this.persona = await this.mcp.tool('soul_persona');
    return this.persona.length;
  }

  /**
   * ② 处理一条用户输入。
   * ★ 关键：这里**没有**任何本地记忆 —— 历史靠 soul_recall 现取。
   */
  async handle(userText) {
    const frames = [];
    frames.push({ type: 'user', text: userText });

    // 2a. 先检索相关历史
    const recalled = await this.mcp.tool('soul_recall', { query: userText.slice(0, 20), context: 1 });
    const hasHistory = !recalled.startsWith('没有命中');

    // 2b. 拼上下文（真宿主这里会调 LLM；我们只记账）
    this.llmCalls++;
    const answer = hasHistory
      ? '（我记得：' + recalled.split('\n')[0].slice(0, 60) + '…）'
      : '（这是我第一次听你说这个。）';
    frames.push({ type: 'assistant', text: answer });

    // 2c. ★ 一轮结束，**批量**把这轮的帧推过去
    const indexed = await this.mcp.tool('soul_index', { session: this.sessionId, frames });
    return { answer, recalled: hasHistory, indexed, userText };
  }
}

// ── 跑 ──
const ok = []; const bad = [];
const push = (n, c, e) => (c ? ok : bad).push((c ? '✓ ' : '✗ ') + n + (e ? '  → ' + e : ''));

const client = new McpClient({
  command: process.execPath,
  args: [path.join(ROOT, 'src', 'adapters', 'mcp.mjs')],
  env: { AGENT_SOUL_DATA: DATA.replace(/\\/g, '/') },
});

await new Promise(r => setTimeout(r, 700));

const init = await client.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
push('宿主连上 agent-soul', init.result?.serverInfo?.name === 'agent-soul', init.result?.serverInfo?.name);

const list = await client.rpc('tools/list', {});
const names = (list.result?.tools || []).map(t => t.name);
push('拿到工具清单', names.length >= 15, names.join(', '));

const host = new MiniHost(client, 'mini-host-session');
const personaLen = await host.bootstrap();
push('★ 取人格（拼进 system prompt）', personaLen > 1000, personaLen + ' 字符');

// 第一轮：本地没有记忆
const r1 = await host.handle('我昨天说的那个传输层拆分，结论是什么？');
push('第一轮：没有历史', r1.recalled === false, r1.answer);
push('第一轮：帧已推', r1.indexed.includes('共 2 帧'), r1.indexed);

// 第二轮：应该能检索到第一轮
const r2 = await host.handle('传输层拆分');
push('★ 第二轮：召回了第一轮', r2.recalled === true, r2.answer);

// 第三轮：不相关的
const r3 = await host.handle('今天天气不错');
push('第三轮：不硬凑', r3.recalled === false, r3.answer);

// 检查宿主的「记忆」全在 agent-soul 里
const all = await client.tool('soul_sessions', {});
push('★ 会话在 agent-soul 里', all.includes('mini-host-session'), all.split('\n')[0]);

const health = JSON.parse(await client.tool('soul_health', {}));
push('★ 帧数对得上', health.frames >= 7, 'agent-soul 里有 ' + health.frames + ' 帧');

// 宿主的本地状态：只有 persona 和计数，**没有对话历史**
const hostKeys = Object.keys(host).filter(k => !k.startsWith('_')).concat(Object.keys(host).filter(k => k.startsWith('_')));
const hasLocalHistory = hostKeys.some(k => /history|messages|conv/i.test(k));
push('★ 宿主本地没有对话历史', !hasLocalHistory, '它的状态只有: ' + hostKeys.join(', '));

client.close();
await new Promise(r => setTimeout(r, 200));
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}

console.log('');
console.log('=== 迷你宿主（接入参考实现）===');
console.log('');
console.log(ok.join('\n'));
if (bad.length) { console.log(''); console.log(bad.join('\n')); }
console.log('');
console.log(ok.length + ' 通过 / ' + bad.length + ' 失败');
console.log('');
process.exit(bad.length ? 1 : 0);