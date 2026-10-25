/**
 * streamable-http 验证：json 与 sse 两种响应形态各跑一遍
 *   连接 → tools/list → tools/call → 注册进注册表 → 注销干净 → 关传输
 *
 * 用法：node _verify-http.mjs
 * 退出码：0 全过；1 有问题。
 */
import { startFakeMcpServer } from './_fake-http-mcp.mjs'
import { McpHttpClient, McpHub, publicToolName, createToolDefinition } from './index.js'

const problems = []
const log = (...a) => console.log(...a)

function createRegistry() {
  const live = new Map()
  return {
    register(def) {
      if (live.has(def.name)) throw new Error(`register: "${def.name}" 已存在`)
      live.set(def.name, def)
      return () => live.delete(def.name)
    },
    names: () => [...live.keys()],
    has: (n) => live.has(n),
    size: () => live.size,
  }
}

for (const mode of ['json', 'sse']) {
  log('')
  log(`── mode=${mode} ──`)
  const srv = await startFakeMcpServer({ mode })
  const config = {
    serverName: 'fakehttp',
    transport: 'streamable-http',
    enabled: true,
    url: srv.url,
    toolCallTimeoutMs: 15000,
  }
  const client = new McpHttpClient(config, { log: (k, t) => log(`   [client:${k}] ${t}`) })
  let tools = []
  try {
    const init = await client.connect({ timeoutMs: 10000 })
    log(`   initialize ok：serverInfo=${JSON.stringify(init?.serverInfo)}  session=${client.sessionId}`)
    if (client.sessionId !== 'fake-session-1') problems.push(`${mode}: 没有记住 mcp-session-id`)

    tools = await client.listTools()
    log(`   tools/list ok：${tools.map((t) => t.name).join(', ')}`)
    if (tools.length !== 3) problems.push(`${mode}: tools/list 预期 3 个，得到 ${tools.length}`)

    const echoed = await client.callTool('echo', { text: '你好' })
    const text = echoed?.content?.[0]?.text
    log(`   tools/call echo → ${JSON.stringify(text)}`)
    if (text !== '你好') problems.push(`${mode}: echo 回显不对：${JSON.stringify(text)}`)

    const sum = await client.callTool('add', { a: 2, b: 40 })
    log(`   tools/call add → ${sum?.content?.[0]?.text}`)
    if (sum?.content?.[0]?.text !== '42') problems.push(`${mode}: add 结果不对`)
  } catch (e) {
    problems.push(`${mode}: 客户端流程失败：${String(e?.message || e)}`)
    log(`   ✗ ${String(e?.message || e)}`)
  }

  // 用 Hub 走一遍真实的注册/注销路径（同一份 createToolDefinition）
  const registry = createRegistry()
  const hub = new McpHub({
    servers: [config],
    register: (def) => registry.register(def),
    logger: {},
    state: () => {},
  })
  const row = await hub.connectServer('fakehttp')
  log(`   hub.connectServer → status=${row?.status} toolCount=${row?.toolCount} error=${row?.error ?? 'null'}`)
  if (row?.status !== 'ready') problems.push(`${mode}: hub 连接状态不是 ready：${row?.status} / ${row?.error}`)
  const expected = tools.map((t) => publicToolName('fakehttp', t.name)).sort()
  const got = registry.names().sort()
  if (JSON.stringify(expected) !== JSON.stringify(got)) {
    problems.push(`${mode}: 注册名字不符：${JSON.stringify(got)}`)
  } else {
    log(`   注册 ${got.length} 个：${got.join(', ')}`)
  }
  // execute 真跑一次（走注册定义，而不是直接调 client）
  try {
    const live = hub.connections.get('fakehttp')
    const definition = createToolDefinition({
      client: live.client,
      serverName: 'fakehttp',
      tool: { name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
    })
    const res = await definition.execute({ text: 'via-execute' })
    log(`   execute(echo) → ${JSON.stringify(res?.content?.[0]?.text)}`)
    if (res?.content?.[0]?.text !== 'via-execute') problems.push(`${mode}: execute 路径不对`)
  } catch (e) {
    problems.push(`${mode}: execute 失败：${String(e?.message || e)}`)
  }

  const before = registry.size()
  await hub.removeServer('fakehttp')
  const after = registry.size()
  log(`   注销：${before} → ${after}（连接数 ${hub.connections.size}）`)
  if (after !== 0) problems.push(`${mode}: 注销后仍有 ${after} 条工具`)
  if (hub.connections.size !== 0) problems.push(`${mode}: 注销后连接还在`)

  await client.close().catch(() => {})
  await srv.close()
}

log('')
log('─'.repeat(60))
if (!problems.length) {
  log('✓ streamable-http（json + sse）全部通过')
  process.exit(0)
}
log(`✗ ${problems.length} 个问题：`)
for (const p of problems) log('  · ' + p)
process.exit(1)
