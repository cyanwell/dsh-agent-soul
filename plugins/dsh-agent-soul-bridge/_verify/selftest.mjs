/**
 * 自测：真 Cordis 起 Context → 挂插件 → 真调 handler → 逐条打印 PASS/FAIL。
 * 用法: node _verify/selftest.mjs <index.js 绝对路径>
 *
 * ★ 只调只读端点与 start（v4 在线时 start 直接回 already，不 spawn）。
 *   stop / restart 不调 —— 它们会真杀 AgentSoul.exe。
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
await (async () => {
  const f = root.plugin({ name: 'fake-web-server', apply (c) { c.provide('webServer', webServer) } })
  if (f && f.await) await f.await()
})()

const mod = await import(pathToFileURL(path.resolve(target)).href + '?t=' + Date.now())
const plugin = mod.default ?? mod
let applyError = null
try {
  const f = root.plugin(plugin, { url: 'ws://127.0.0.1:7311/control', agentSoulAutoStart: false })
  if (f && f.await) await f.await()
} catch (e) { applyError = e }

function call (p) {
  return new Promise((resolve) => {
    let code = 0
    const res = { writeHead (c) { code = c }, end (b) { resolve({ status: code, body: String(b) }) } }
    Promise.resolve(routes.get(p)({}, res)).catch((e) => resolve({ status: 0, body: 'THREW ' + String((e && e.message) || e) }))
  })
}
const get = async (p) => { const r = await call(p); try { return { status: r.status, j: JSON.parse(r.body) } } catch (e) { return { status: r.status, j: null, raw: r.body.slice(0, 160) } } }

const results = []
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); }

check('apply 不抛错（真 cordis）', !applyError, applyError ? String(applyError.message).slice(0, 200) : 'ok')
const want = ['/agent-soul/status', '/agent-soul/start', '/agent-soul/stop', '/agent-soul/restart', '/agent-soul/probe']
check('5 个端点都注册并被调用', want.every((p) => routes.has(p)), [...routes.keys()].join(' '))
check('default export 带 inject', Array.isArray(plugin.inject) && plugin.inject.includes('webServer'), JSON.stringify(plugin.inject || null))

const st = await get('/agent-soul/status')
check('GET /agent-soul/status 200 + JSON', st.status === 200 && !!st.j, st.status + ' ' + (st.j ? ('alive=' + st.j.alive + ' version=' + st.j.version) : st.raw))
check('status 里有 pid/会话数/llm/宿主登记/ws', !!(st.j && st.j.health && st.j.control && st.j.bridge), st.j ? ('pid=' + (st.j.health && st.j.health.pid) + ' sessions=' + (st.j.health && st.j.health.sessions) + ' llm=' + (st.j.health && st.j.health.llmUsable) + ' ctl=' + (st.j.control && st.j.control.connected) + ' ws=' + (st.j.bridge && st.j.bridge.connected)) : '')
check('status 报出 exe 路径与镜像名', !!(st.j && st.j.plan && st.j.plan.exeExists), st.j && st.j.plan ? (st.j.plan.exe + ' img=' + st.j.plan.image + ' token=' + st.j.plan.token) : '')

const pr = await get('/agent-soul/probe')
const steps = (pr.j && pr.j.steps) || []
check('GET /agent-soul/probe 200 + 四项', pr.status === 200 && steps.length === 4, steps.map((x) => (x.ok ? 'OK ' : 'NG ') + x.name).join(' | '))
check('probe 第①项：HTTP 健康', !!(steps[0] && steps[0].ok), steps[0] ? steps[0].detail : '')
check('probe 第④项：会话通道（带 token）', !!(steps[3] && (steps[3].ok || /已登记宿主 0/.test(steps[3].detail))), steps[3] ? steps[3].detail : '')

const sa = await get('/agent-soul/start')
check('GET /agent-soul/start 200（在线时 already）', sa.status === 200 && !!(sa.j && (sa.j.already || sa.j.started)), sa.j ? JSON.stringify(sa.j).slice(0, 160) : sa.raw)

const sp = mod.spawnAgentSoul
const planOk = mod.agentSoulPlan({})
const spawnBad = sp({ agentSoulRoot: 'D:/__no_such_root__' })
check('spawnAgentSoul：对路径解析正确', planOk.root === 'D:/AI/agent-soul' && planOk.exists === true && planOk.image === 'AgentSoul.exe', JSON.stringify(planOk))
check('spawnAgentSoul：错路径给明确错误（不静默）', spawnBad.ok === false && /找不到/.test(String(spawnBad.error)), String(spawnBad.error))

const receipt = (() => { try { return JSON.parse(fs.readFileSync('D:/AI/dsh/home/plugins-data/agent-soul-bridge/apply.json', 'utf8')) } catch (e) { return null } })()
const stages = (receipt && receipt.stages) || []
check('回执落盘且含 route:* / wired:5', stages.filter((x) => x.startsWith('route:')).length === 5 && stages.some((x) => x.startsWith('wired:5')), stages.map((x) => x.split('@')[0]).join(' '))

const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].reduce((a, c) => a + (c.charCodeAt(0) > 127 ? 2 : 1), 0)))
console.log('')
console.log('  target = ' + path.resolve(target))
console.log('  ' + '-'.repeat(96))
for (const r of results) console.log('  ' + (r.ok ? 'PASS' : 'FAIL') + '  ' + pad(r.name, 46) + ' ' + String(r.detail || '').slice(0, 120))
console.log('  ' + '-'.repeat(96))
console.log('  ' + results.filter((r) => r.ok).length + ' / ' + results.length + ' PASS')
process.exit(results.every((r) => r.ok) ? 0 : 1)
