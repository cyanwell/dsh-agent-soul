/**
 * 端到端：真 Cordis 起 Context → 挂本插件 → 拿注册到的 handler 真调一遍。
 * ★ 只调 status / probe / start：
 *   · status / probe 只读
 *   · start：v4 在跑时会直接回 already:true，不会 spawn
 *   · stop / restart **故意不调** —— 它们会真杀 AgentSoul.exe
 *
 * 用法: node e2e-harness.mjs <index.js>
 */
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const CORDIS = 'D:/AI/dsh/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'
const target = process.argv[2]
const { Context } = await import(pathToFileURL(CORDIS).href)

const routes = new Map()
const root = new Context()
const webServer = {
  register (route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) },
  getOrigin () { return 'http://127.0.0.1:65500' },
}
const fakeWeb = { name: 'fake-web-server', apply (c) { c.provide('webServer', webServer) } }

async function mount (plugin, config) {
  const fiber = root.plugin(plugin, config)
  if (fiber && typeof fiber.await === 'function') await fiber.await()
}
await mount(fakeWeb)
const mod = await import(pathToFileURL(path.resolve(target)).href + '?t=' + Date.now())
await mount(mod.default ?? mod, { url: 'ws://127.0.0.1:7311/control', agentSoulAutoStart: false })

function call (p) {
  return new Promise((resolve) => {
    const chunks = []
    let code = 0
    const res = {
      writeHead (c) { code = c },
      end (body) { chunks.push(body); resolve({ status: code, body: String(chunks.join('')) }) },
    }
    Promise.resolve(routes.get(p)({}, res)).catch((e) => resolve({ status: 0, body: 'THREW ' + String(e && e.message || e) }))
  })
}

const out = { target: path.resolve(target), registered: [...routes.keys()], results: {} }
for (const p of ['/agent-soul/status', '/agent-soul/probe', '/agent-soul/start']) {
  if (!routes.has(p)) { out.results[p] = { missing: true }; continue }
  const r = await call(p)
  let j = null
  try { j = JSON.parse(r.body) } catch (e) { j = { unparsable: r.body.slice(0, 200) } }
  out.results[p] = { status: r.status, body: j }
}
for (const p of ['/agent-soul/stop', '/agent-soul/restart']) {
  out.results[p] = { registered: routes.has(p), invoked: false, note: '故意不调：会真杀 AgentSoul.exe' }
}

const receiptPath = 'D:/AI/dsh/home/plugins-data/agent-soul-bridge/apply.json'
try { out.receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) } catch (e) { out.receipt = null }

console.log(JSON.stringify(out, null, 2))
process.exit(0)
