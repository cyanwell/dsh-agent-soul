/**
 * 真 Cordis 验证器 —— 用 DSH 同版本 @deepseek-ai/cordis 4.0.2 起一个最小 Context，
 * 提供假 webServer 服务，然后加载本插件，看 apply 到底会不会抛、5 条路由有没有留下。
 *
 * 为什么必须要它：假 ctx 太宽容 —— 它允许 ctx.xxx = yyy。
 * 真 Cordis 的 reflect.set 陷阱对「没 provide 过的属性」是抛错的
 * （cordis/lib/index.js:699-706 cannot set property "..." without provide），
 * 而 apply 抛错 → Loader._start 的 catch → _dispose(fiber) → 所有 effect 回收
 * → 已注册的路由被注销、ws 被关 —— 表现就是「端点 404 + control.connected=0」。
 *
 * 用法: node cordis-harness.mjs <index.js 绝对路径>
 */
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const CORDIS = 'D:/AI/dsh/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'
const target = process.argv[2]
if (!target) { console.error('usage: node cordis-harness.mjs <index.js>'); process.exit(2) }

const { Context } = await import(pathToFileURL(CORDIS).href)

const events = []
const routes = []

const root = new Context()

/* 假 webServer：形状照 cordis_inspect 的契约（register(WebRoute) -> disposer） */
const webServer = {
  register (route) {
    routes.push({ kind: route.kind, path: route.path, handler: typeof route.handler })
    return () => {
      const i = routes.findIndex((r) => r.path === route.path)
      if (i >= 0) routes.splice(i, 1)
      events.push('dispose route ' + route.path)
    }
  },
  getOrigin () { return 'http://127.0.0.1:65500' },
}

const fakeWeb = {
  name: 'fake-web-server',
  apply (c) {
    c.provide('webServer', webServer)
    events.push('webServer provided')
  },
}

async function mount (plugin, config, label) {
  try {
    const fiber = root.plugin(plugin, config)
    if (fiber && typeof fiber.await === 'function') await fiber.await()
    events.push(label + ' mounted')
    return null
  } catch (e) {
    return e
  }
}

const e1 = await mount(fakeWeb, undefined, 'fake-web-server')
const mod = await import(pathToFileURL(path.resolve(target)).href + '?t=' + Date.now())
const plugin = mod.default ?? mod
const cfg = { url: 'ws://127.0.0.1:7311/control', agentSoulAutoStart: false }
const e2 = await mount(plugin, cfg, 'bridge')

const out = {
  target: path.resolve(target),
  fakeWebError: e1 ? String(e1.message).slice(0, 300) : null,
  bridgeError: e2 ? { name: e2.name, message: String(e2.message).slice(0, 400), stack: String(e2.stack || '').split('\n').slice(0, 8) } : null,
  moduleInject: mod.inject || null,
  defaultInject: (plugin && plugin.inject) ? plugin.inject : null,
  routesAfter: routes,
  routeCount: routes.length,
  events,
}
console.log(JSON.stringify(out, null, 2))
process.exit(0)
