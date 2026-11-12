// llm-mock-acceptance.mjs -- prove both LLM protocols against a LOCAL MOCK SERVER.
//
// ★ No external API call, ever. The client is pointed at 127.0.0.1:<port>.
// ★ What it checks (each one is an assertion, not a log line):
//   openai   : path /chat/completions, Authorization: Bearer, tools[].function shape, SSE delta -> text + tool_calls
//   anthropic: path <base>/v1/messages, x-api-key + anthropic-version + Authorization, system hoisted out of
//              messages, tools -> input_schema, assistant.tool_calls -> tool_use, role:tool -> tool_result,
//              SSE content_block_delta -> text, input_json_delta -> tool args, non-stream content blocks too
//   guards   : unknown protocol throws (no silent downgrade), base url normalisation (no duplicated endpoint)
//
// Usage: node llm-mock-acceptance.mjs [--src <src dir>] [--evidence <dir>]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const SRC = argOf('src', 'D:/AI/agent-soul/dist/AgentSoul/app/1.0.2/src');
const TS = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const EV = argOf('evidence', 'D:/AI/agent-soul/_verify/llm-102-' + TS);
fs.mkdirSync(EV, { recursive: true });

const log = [];
let fails = 0;
function Say(s) { log.push(s); console.log(s); }
function Check(name, cond, detail) {
  if (cond) Say('PASS  ' + name + (detail ? '  ::  ' + detail : ''));
  else { Say('FAIL  ' + name + (detail ? '  ::  ' + detail : '')); fails++; }
}

const { LlmClient, normalizeProtocol, normalizeBaseUrl, toAnthropicMessages, toAnthropicTools, ANTHROPIC_VERSION } =
  await import(pathToFileURL(path.join(SRC, 'llm', 'client.mjs')).href);

const CANARY = 'sk-canary-llm-102-DO-NOT-LEAK';
// ★ 证据文件也要脱敏：把 canary 从任何要落盘的对象/字符串里换成 <redacted>。
//   第一版忘了这一步，于是「证明 key 不泄漏」的证据文件自己带着 key —— 那正是最容易犯的错。
const redact = (v) => JSON.parse(JSON.stringify(v).split(CANARY).join('<redacted>'));
const seen = [];   // recorded requests

// ── mock server ────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let json = null;
    try { json = JSON.parse(body); } catch { json = null; }
    const rec = { at: Date.now(), method: req.method, url: req.url, headers: req.headers, body: json, rawBody: body };
    seen.push(rec);

    if (req.url.endsWith('/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const w = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
      w({ choices: [{ delta: { content: '你好' } }] });
      w({ choices: [{ delta: { content: '，世界' } }] });
      w({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_mock_1', function: { name: 'echo', arguments: '{"x":1}' } }] } }] });
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    if (req.url.endsWith('/v1/messages')) {
      if (json && json.stream === false) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          id: 'msg_mock_2', type: 'message', role: 'assistant',
          content: [
            { type: 'text', text: '非流式回答' },
            { type: 'tool_use', id: 'toolu_mock_2', name: 'echo', input: { y: 2 } },
          ],
          stop_reason: 'tool_use',
        }));
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const ev = (name, o) => res.write('event: ' + name + '\ndata: ' + JSON.stringify(o) + '\n\n');
      ev('message_start', { type: 'message_start', message: { id: 'msg_mock_1', role: 'assistant', content: [] } });
      ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } });
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '，世界' } });
      ev('content_block_stop', { type: 'content_block_stop', index: 0 });
      ev('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_mock_1', name: 'echo', input: {} } });
      ev('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"x":' } });
      ev('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '1}' } });
      ev('content_block_stop', { type: 'content_block_stop', index: 1 });
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } });
      ev('message_stop', { type: 'message_stop' });
      return res.end();
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'mock 没有这条路：' + req.url }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const BASE = 'http://127.0.0.1:' + PORT;
Say('[mock] listening ' + BASE);

const TOOLS = [{
  type: 'function',
  function: {
    name: 'echo',
    description: '回显',
    parameters: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
  },
}];

const HISTORY = [
  { role: 'system', content: '你是测试用的系统提示。' },
  { role: 'user', content: '第一问' },
  { role: 'assistant', content: '第一答', tool_calls: [{ id: 'call_prev', type: 'function', function: { name: 'echo', arguments: '{"x":9}' } }] },
  { role: 'tool', tool_call_id: 'call_prev', content: '{"ok":true}' },
  { role: 'user', content: '第二问' },
];

// ── openai ────────────────────────────────────────────────────────────────
{
  const c = new LlmClient({ baseUrl: BASE, apiKey: CANARY, model: 'deepseek-chat', protocol: 'openai' });
  const deltas = [];
  const r = await c.chat(HISTORY, TOOLS, (d) => deltas.push(d));
  const req = seen[seen.length - 1];
  Say('[openai] url=' + req.url);
  Check('openai 端点 /chat/completions', req.url === '/chat/completions', req.url);
  Check('openai Authorization: Bearer <key>', req.headers.authorization === 'Bearer ' + CANARY, 'len=' + String(req.headers.authorization).length);
  Check('openai body.model', req.body.model === 'deepseek-chat', req.body.model);
  Check('openai body.stream=true', req.body.stream === true, String(req.body.stream));
  Check('openai body.tools 保持 OpenAI 形状', req.body.tools && req.body.tools[0].type === 'function' && req.body.tools[0].function.name === 'echo');
  Check('openai body.tool_choice=auto', req.body.tool_choice === 'auto', req.body.tool_choice);
  Check('openai body.messages 原样（含 role:tool）', req.body.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_prev'));
  Check('openai SSE 文本拼接', r.text === '你好，世界', r.text);
  Check('openai SSE tool_calls 解析', r.toolCalls.length === 1 && r.toolCalls[0].name === 'echo' && r.toolCalls[0].args.x === 1, JSON.stringify(r.toolCalls));
  Check('openai 流式回调收到文本', deltas.filter((d) => d.type === 'text').length === 2, String(deltas.length));
  fs.writeFileSync(path.join(EV, 'openai-request.json'), JSON.stringify(redact({ url: req.url, headers: req.headers, body: req.body }), null, 2), 'utf8');
}

// ── anthropic (stream) ────────────────────────────────────────────────────
{
  const c = new LlmClient({ baseUrl: BASE + '/anthropic', apiKey: CANARY, model: 'deepseek-chat', protocol: 'anthropic' });
  const deltas = [];
  const r = await c.chat(HISTORY, TOOLS, (d) => deltas.push(d));
  const req = seen[seen.length - 1];
  Say('[anthropic] url=' + req.url);
  Check('anthropic 端点 <base>/v1/messages', req.url === '/anthropic/v1/messages', req.url);
  Check('anthropic x-api-key', req.headers['x-api-key'] === CANARY, 'len=' + String(req.headers['x-api-key']).length);
  Check('anthropic anthropic-version: ' + ANTHROPIC_VERSION, req.headers['anthropic-version'] === ANTHROPIC_VERSION, req.headers['anthropic-version']);
  Check('anthropic Authorization: Bearer 也发了', req.headers.authorization === 'Bearer ' + CANARY);
  Check('anthropic system 提到顶层字段', req.body.system === '你是测试用的系统提示。', String(req.body.system));
  Check('anthropic messages 里没有 role:system', !req.body.messages.some((m) => m.role === 'system'));
  Check('anthropic max_tokens 必填项已带', typeof req.body.max_tokens === 'number' && req.body.max_tokens > 0, String(req.body.max_tokens));
  const asst = req.body.messages.find((m) => m.role === 'assistant');
  const tu = asst && asst.content.find((b) => b.type === 'tool_use');
  Check('anthropic assistant.tool_calls -> tool_use block', !!tu && tu.name === 'echo' && tu.input.x === 9, JSON.stringify(tu));
  const toolResMsg = req.body.messages.find((m) => m.role === 'user' && m.content.some((b) => b.type === 'tool_result'));
  Check('anthropic role:tool -> tool_result block', !!toolResMsg && toolResMsg.content[0].tool_use_id === 'call_prev', JSON.stringify(toolResMsg && toolResMsg.content[0]));
  Check('anthropic tools -> input_schema', req.body.tools && req.body.tools[0].name === 'echo' && req.body.tools[0].input_schema.type === 'object', JSON.stringify(req.body.tools && req.body.tools[0]).slice(0, 120));
  Check('anthropic 没有 OpenAI 的 function 包装', req.body.tools && req.body.tools[0].function === undefined);
  Check('anthropic 相邻同角色消息已合并', req.body.messages.every((m, i) => i === 0 || m.role !== req.body.messages[i - 1].role));
  Check('anthropic SSE 文本拼接', r.text === '你好，世界', r.text);
  Check('anthropic SSE tool_use 参数拼接', r.toolCalls.length === 1 && r.toolCalls[0].id === 'toolu_mock_1' && r.toolCalls[0].args.x === 1, JSON.stringify(r.toolCalls));
  Check('anthropic 流式回调收到文本', deltas.filter((d) => d.type === 'text').length === 2, String(deltas.length));
  fs.writeFileSync(path.join(EV, 'anthropic-request.json'), JSON.stringify(redact({ url: req.url, headers: req.headers, body: req.body }), null, 2), 'utf8');
  fs.writeFileSync(path.join(EV, 'anthropic-response.json'), JSON.stringify(redact(r), null, 2), 'utf8');
}

// ── anthropic (non-stream) ────────────────────────────────────────────────
{
  const c = new LlmClient({ baseUrl: BASE + '/anthropic', apiKey: CANARY, model: 'deepseek-chat', protocol: 'anthropic', stream: false });
  const r = await c.chat([{ role: 'user', content: 'hi' }], []);
  const req = seen[seen.length - 1];
  Check('anthropic 非流式 body.stream=false', req.body.stream === false, String(req.body.stream));
  Check('anthropic 非流式 content blocks -> text', r.text === '非流式回答', r.text);
  Check('anthropic 非流式 tool_use -> toolCalls', r.toolCalls.length === 1 && r.toolCalls[0].name === 'echo' && r.toolCalls[0].args.y === 2, JSON.stringify(r.toolCalls));
}

// ── guards ────────────────────────────────────────────────────────────────
{
  let threw = null;
  try { normalizeProtocol('openai-compatible-ish'); } catch (e) { threw = e; }
  Check('未知协议抛错（不静默降级）', !!threw && /未知协议/.test(String(threw.message)), threw ? String(threw.message).slice(0, 60) : '(没有抛)');

  Check('openai 默认地址', normalizeBaseUrl('', 'openai') === 'https://api.deepseek.com', normalizeBaseUrl('', 'openai'));
  Check('anthropic 默认地址带 /anthropic', normalizeBaseUrl('', 'anthropic') === 'https://api.deepseek.com/anthropic', normalizeBaseUrl('', 'anthropic'));
  Check('去尾斜杠', normalizeBaseUrl('https://api.deepseek.com/', 'openai') === 'https://api.deepseek.com');
  Check('去掉重复 /chat/completions', normalizeBaseUrl('https://api.deepseek.com/chat/completions', 'openai') === 'https://api.deepseek.com');
  Check('去掉重复 /anthropic/v1/messages', normalizeBaseUrl('https://api.deepseek.com/anthropic/v1/messages', 'anthropic') === 'https://api.deepseek.com/anthropic');
  Check('anthropic 地址不带重复 /v1', normalizeBaseUrl('https://api.deepseek.com/anthropic/v1', 'anthropic') === 'https://api.deepseek.com/anthropic');
  Check('自定义网关原样保留', normalizeBaseUrl('https://gw.example.com/v1', 'openai') === 'https://gw.example.com/v1');
  Check('anthropic endpoint = base + /v1/messages',
    new LlmClient({ baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'k', protocol: 'anthropic' }).endpoint() === 'https://api.deepseek.com/anthropic/v1/messages');
  Check('openai endpoint = base + /chat/completions',
    new LlmClient({ baseUrl: 'https://api.deepseek.com', apiKey: 'k', protocol: 'openai' }).endpoint() === 'https://api.deepseek.com/chat/completions');

  const { messages } = toAnthropicMessages([{ role: 'system', content: 'S' }, { role: 'assistant', content: 'A' }, { role: 'user', content: 'U' }]);
  Check('第一条必须是 user（Anthropic 要求）', messages[0].role === 'user', messages[0].role);
  Check('toAnthropicTools 保持空 schema 合法', toAnthropicTools([{ type: 'function', function: { name: 'f' } }])[0].input_schema.type === 'object');
}

// ── canary must not leak into any evidence file ───────────────────────────
{
  let leaks = 0;
  for (const f of fs.readdirSync(EV)) {
    const t = fs.readFileSync(path.join(EV, f), 'utf8');
    if (t.includes(CANARY)) leaks++;
  }
  Check('canary 不出现在证据文件里（headers 已脱敏）', leaks === 0, 'leaks=' + leaks);
}

server.close();
Say('---');
Say('fails=' + fails);
fs.writeFileSync(path.join(EV, '99-llm-mock.log'), log.join('\n') + '\n', 'utf8');
Say('evidence = ' + EV);
process.exit(fails ? 1 : 0);
