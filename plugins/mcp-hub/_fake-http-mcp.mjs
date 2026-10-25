/**
 * 假的 streamable-http MCP 服务器 —— 只实现三个方法，专供插件自测。
 *
 *   initialize / tools/list / tools/call
 *
 * 两种响应形态都要能演（MCP 客户端必须两种都处理）：
 *   mode=json  → 200 application/json
 *   mode=sse   → 200 text/event-stream（一事件一条 data）
 *
 * 单独运行：
 *   node _fake-http-mcp.mjs [json|sse] [port]
 * 被引入：
 *   const srv = await startFakeMcpServer({ mode: 'sse' })  // { url, close }
 */
import { createServer } from 'node:http'

const TOOLS = [
  { name: 'echo', description: '把 text 原样回显', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'add', description: '两数相加', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
  { name: 'boom', description: '总是返回 isError（测错误路径）', inputSchema: { type: 'object', properties: {} } },
]

function handle(msg) {
  const { method, params } = msg
  if (method === 'initialize') {
    return { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake-http-mcp', version: '0.0.1' } }
  }
  if (method === 'tools/list') return { tools: TOOLS }
  if (method === 'tools/call') {
    const name = params?.name
    const args = params?.arguments ?? {}
    if (name === 'echo') return { content: [{ type: 'text', text: String(args.text ?? '') }] }
    if (name === 'add') return { content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }] }
    if (name === 'boom') return { isError: true, content: [{ type: 'text', text: 'boom: 假失败' }] }
    return { isError: true, content: [{ type: 'text', text: `没有工具：${name}` }] }
  }
  return null
}

export function startFakeMcpServer({ mode = 'json', port = 0 } = {}) {
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    if (req.method === 'DELETE') { res.writeHead(200); return res.end('bye') }
    if (req.method !== 'POST') { res.writeHead(405); return res.end() }

    let msg
    try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
      res.writeHead(400); return res.end('bad json')
    }
    // 通知：回 202，没有响应体
    if (msg.id === undefined) { res.writeHead(202); return res.end() }
    const result = handle(msg)
    if (result === null) {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fake-session-1' })
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unsupported: ${msg.method}` } }))
    }
    const body = { jsonrpc: '2.0', id: msg.id, result }
    const headers = { 'mcp-session-id': 'fake-session-1' }
    if (mode === 'sse') {
      res.writeHead(200, { ...headers, 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      res.write(`event: message\ndata: ${JSON.stringify(body)}\n\n`)
      return res.end()
    }
    res.writeHead(200, { ...headers, 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port
      resolve({
        url: `http://127.0.0.1:${actual}/mcp`,
        port: actual,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}

if (process.argv[1] && process.argv[1].endsWith('_fake-http-mcp.mjs')) {
  const mode = process.argv[2] === 'sse' ? 'sse' : 'json'
  const srv = await startFakeMcpServer({ mode, port: Number(process.argv[3]) || 0 })
  console.log(`FAKE_MCP ${mode} ${srv.url}`)
  const stop = () => srv.close().then(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
