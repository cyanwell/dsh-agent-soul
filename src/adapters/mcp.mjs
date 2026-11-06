#!/usr/bin/env node
// MCP over stdio —— 第一条腿
//
// ★ 这个文件**只做传输**：读 stdin 的一行一个 JSON-RPC，转给 mcp-tools.mjs，写回 stdout。
//   工具定义、人格、检索、索引全在 mcp-tools.mjs 里 —— 两条腿共用同一份。
//   为什么不各写一份：重复定义迟早会漂，而「两条腿暴露的工具不一样」是最难查的那种 bug。
//
// 启动：node src/adapters/mcp.mjs
// 宿主配置：command=<node 路径>, args=["D:/AI/agent-soul/src/adapters/mcp.mjs"]

import { TOOLS, callTool, SERVER_INFO, closeStore } from './mcp-tools.mjs';

const send = (obj) => { process.stdout.write(JSON.stringify(obj) + '\n'); };

async function handle(msg) {
  const { id, method, params } = msg || {};

  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: {
      protocolVersion: (params && params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    } };
  }
  if (method === 'notifications/initialized' || method === 'initialized') return null;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS.map(t => ({
      name: t.name, description: t.description, inputSchema: t.inputSchema,
    })) } };
  }

  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      const text = await callTool(name, args);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
    } catch (e) {
      const code = e && e.code === 'NO_TOOL' ? -32601 : -32603;
      return { jsonrpc: '2.0', id, error: { code, message: String((e && e.message) || e) } };
    }
  }

  if (id === undefined) return null;
  return { jsonrpc: '2.0', id, error: { code: -32601, message: '不认识的方法: ' + method } };
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); }
    catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } }); continue; }
    try {
      const res = await handle(msg);
      if (res) send(res);
    } catch (e) {
      if (msg && msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String((e && e.message) || e) } });
    }
  }
});

process.stdin.on('end', () => { try { closeStore(); } catch {} process.exit(0); });
process.stderr.write('[agent-soul] MCP server ready (stdio), ' + TOOLS.length + ' tools\n');