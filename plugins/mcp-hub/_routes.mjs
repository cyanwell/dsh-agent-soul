/**
 * 路由实测台：把 index.js 的 createRouteTable() 原样挂到 node:http 上，
 * 这样每条增删改查都能用 curl.exe 打一遍、看到真实响应。
 *
 * 为什么需要它：DSH 正在运行的那个进程里**没有**装这个插件（也不许重启），
 * 所以拿不到它自己的 webServer。这里复刻的只是"前缀匹配 → handler"这一段
 * （与 dsh-host-webserver 的 prefix 语义一致），handler 本身是同一份代码。
 *
 * 用法：node _routes.mjs [--sse]
 * 输出：ROUTES_URL <url> / FAKE_URL <url> / MANIFEST <path>
 */
import { createServer } from 'node:http'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { startFakeMcpServer } from './_fake-http-mcp.mjs'
import { McpHub, ManifestStore, createRouteTable } from './index.js'

const mode = process.argv.includes('--sse') ? 'sse' : 'json'
const file = join(tmpdir(), `dsh-mcp-hub-routes-${process.pid}.json`)
mkdirSync(dirname(file), { recursive: true })
writeFileSync(file, JSON.stringify({ version: 1, servers: [] }, null, 2) + '\n', 'utf8')

const fake = await startFakeMcpServer({ mode })

/* 注册表替身：语义与 ctx.tools.register 一致 */
const live = new Map()
const registry = {
  register(def) {
    if (live.has(def.name)) throw new Error(`register: "${def.name}" 已存在`)
    live.set(def.name, def)
    return () => live.delete(def.name)
  },
}

const store = new ManifestStore(file)
const hub = new McpHub({
  servers: [],
  register: (def) => registry.register(def),
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  state: () => {},
  store,
})
const routes = createRouteTable({ hub, store, file })

/* 与 dsh-host-webserver 同语义：exact 命中 → 最长 prefix 命中 */
function dispatch(req, res) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  let best = null
  for (const r of routes) {
    if (r.kind === 'exact' && url.pathname === r.path) { best = r; break }
    if (r.kind === 'prefix' && (url.pathname === r.path || url.pathname.startsWith(r.path + '/'))) {
      if (!best || r.path.length > best.path.length) best = r
    }
  }
  if (!best) {
    res.statusCode = 404
    res.setHeader('content-type', 'application/json; charset=utf-8')
    return res.end(JSON.stringify({ ok: false, error: `未匹配：${req.method} ${url.pathname}` }))
  }
  Promise.resolve(best.handler(req, res)).catch((e) => {
    res.statusCode = 500
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }))
  })
}

const server = createServer(dispatch)
await new Promise((resolve) => server.listen(Number(process.env.PORT) || 0, '127.0.0.1', resolve))
const port = server.address().port

console.log(`ROUTES_URL http://127.0.0.1:${port}`)
console.log(`FAKE_URL ${fake.url}`)
console.log(`FAKE_MODE ${mode}`)
console.log(`MANIFEST ${file}`)

const shutdown = async () => {
  await hub.stop().catch(() => {})
  await fake.close().catch(() => {})
  await new Promise((r) => server.close(() => r()))
  try { rmSync(file, { force: true }) } catch { /* ignore */ }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
