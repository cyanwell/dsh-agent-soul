#!/usr/bin/env node
// MCP over HTTP —— 第二条腿
//
// ★ 为什么还要一个 HTTP 传输：
//   stdio 那条要求宿主能 spawn 子进程。有些宿主（网页版、远程、沙箱）不能，
//   它们只认 HTTP。判据是「换一个宿主，改动量应该是填一个地址」。
//
// ★ 这条腿也是「不依赖任何宿主」的硬证据：
//   它可以用 curl 直接调 —— 没有 Node 客户端、没有 SDK、没有任何我的代码在中间。
//
// 启动：node src/adapters/mcp-http.mjs   或   node src/index.mjs --mcp-http
// 端点：POST http://127.0.0.1:<port>/mcp   （body = JSON-RPC，一次一条）
//       GET  http://127.0.0.1:<port>/mcp   （返回服务信息）

import http from 'node:http';
import { TOOLS, callTool, SERVER_INFO, closeStore, setStoreMode } from './mcp-tools.mjs';
import { readonlyEnabled, classifyMcpCall, rejection, MANIFEST_ID } from '../security/write-manifest.mjs';

export function createMcpHttpHandler({ path = '/mcp' } = {}) {
  return async function handler(req, res) {
    const url = (req.url || '').split('?')[0];
    if (url !== path) return false;

    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        server: SERVER_INFO.name,
        version: SERVER_INFO.version,
        transport: 'http',
        tools: TOOLS.map(t => t.name),
        // ★ 2026-11-10（G2a）：把**姿态**摆出来，别让人靠试才知道能不能写。
        readonly: readonlyEnabled(),
        writeManifest: MANIFEST_ID,
        writePolicy: readonlyEnabled() ? 'write-actions-rejected（reason=UNAVAILABLE, code=SOUL_READONLY）' : 'open',
        usage: 'POST 这个路径，body 是一条 JSON-RPC（initialize / tools/list / tools/call）',
      }));
      return true;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: '只支持 POST' } }));
      return true;
    }

    let body = '';
    for await (const chunk of req) body += chunk;

    let msg;
    try { msg = JSON.parse(body); }
    catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } }));
      return true;
    }

    const out = await handleRpc(msg);
    res.writeHead(out ? 200 : 202, { 'Content-Type': 'application/json' });
    res.end(out ? JSON.stringify(out) : '');
    return true;
  };
}

export async function handleRpc(msg) {
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

    // ★★ 2026-11-10（G2a）：**逐调用**问 manifest —— 这条腿原先直接 callTool，一条判据都没有。
    //   三件事按这个顺序，顺序本身是判据：
    //   ① 显式只读模式命中写 action → 回 rejected（服务在线，reason=UNAVAILABLE）；
    //      ★ 不抛异常、不回 500、不静默成功 —— 三种都会让上游误判成别的东西。
    //   ② 读 action → 先把 store 压成 'ro'（结构上挡住 create/append/closeAll/saveIndexCache），
    //      再做 I/O。**先压模式再读**是关键：反过来的话第一次读就已经把写句柄建出来了。
    //   ③ 其余（非只读模式）→ 原样 callTool，生产默认行为不变。
    // ★ 先分「根本没有这个工具」和「有这个工具但不许写」—— 与 stdio 腿同一条规矩：
    //   打错一个名字却拿到「只读拒绝」，人会去查只读模式而不是查拼写。
    if (!TOOLS.some((t) => t.name === name)) {
      return { jsonrpc: '2.0', id, error: { code: -32601, message: '没有这个工具: ' + name } };
    }

    if (readonlyEnabled()) {
      const c = classifyMcpCall(name, args);
      if (c.verdict !== 'read') {
        return { jsonrpc: '2.0', id, result: {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(rejection('mcp', c, { transport: 'http' }), null, 2) }],
        } };
      }
      try { setStoreMode('ro'); } catch { /* 模式设不上也不放行写：下面还有 store 的写方法挡着 */ }
    }

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

// 独立启动
if (import.meta.url === 'file:///' + process.argv[1].replace(/\\/g, '/')) {
  const port = Number(process.env.AGENT_SOUL_MCP_PORT) || 7311;
  const srv = http.createServer(async (req, res) => {
    const handled = await createMcpHttpHandler()(req, res);
    if (!handled) { res.writeHead(404); res.end('not found'); }
  });
  for (const sig of ['exit', 'SIGINT', 'SIGTERM']) {
    process.on(sig, () => { try { closeStore(); } catch {} if (sig !== 'exit') process.exit(0); });
  }
  srv.listen(port, '127.0.0.1', () => {
    process.stderr.write('[agent-soul] MCP over HTTP ready: http://127.0.0.1:' + port + '/mcp\n');
  });
}