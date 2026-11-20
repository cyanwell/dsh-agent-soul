/**
 * 最小 apply 验证器 —— 不重启 DSH 就能验「apply 会不会抛」。
 *
 * ★ 为什么必须有它：node --check 只验语法，**验不了运行时 TDZ / 服务时序**。
 *   本插件两次故障都是「语法没问题、apply 没跑完」，只重启去试就是拿爀曦的重启当调试器。
 *
 * 用法: node apply-harness.mjs <index.js 绝对路径> [--spawn-root <dir>]
 * 判据: throw=null 且 registered 里有 5 条 /agent-soul/*  → apply 跑完
 */
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const target = process.argv[2]
if (!target) { console.error('usage: node apply-harness.mjs <index.js>'); process.exit(2) }

const regs = []
const effects = []
const injects = []
const logs = []

const webServer = {
  register (desc) {
    regs.push({ kind: desc.kind, path: desc.path, handler: typeof desc.handler })
    return () => { /* disposer */ }
  }
}

let webServerCalls = 0
const ctx = {
  webServer,
  get (name) {
    if (name === 'webServer') { webServerCalls++; return webServer }
    return undefined          // agents / sessionProjections / tokenMeter / systemPrompt 全缺 → 走降级分支
  },
  effect (cb, label) {
    const d = cb()
    effects.push({ label: label || null, disposer: typeof d })
    return () => { if (typeof d === 'function') d() }
  },
  inject (names, cb) {
    injects.push(names.slice())
    // 宿主真环境里 systemPrompt 存在；这里给个最小 scope，验证钩子装得上
    const scope = { systemPrompt: { context () { return () => {} } } }
    return cb(scope)
  },
  logger: { info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')) }
}

const log0 = console.log; const warn0 = console.warn
console.log = (...a) => { logs.push(a.join(' ')) }
console.warn = (...a) => { logs.push(a.join(' ')) }

let err = null
let mod = null
try {
  mod = await import(pathToFileURL(path.resolve(target)).href + '?t=' + Date.now())
  mod.apply(ctx, { url: 'ws://127.0.0.1:7311/control' /* 故意指向没人听的端口：不污染真 v4 */ })
} catch (e) {
  err = e
}

console.log = log0; console.warn = warn0

const out = {
  target: path.resolve(target),
  throw: err ? { name: err.name, message: err.message, stack: String(err.stack || '').split('\n').slice(0, 6) } : null,
  registered: regs,
  registerCount: regs.length,
  effectCount: effects.length,
  effectLabels: effects.map(e => e.label),
  injectCalls: injects,
  webServerGetCalls: webServerCalls,
  hasInjectExport: mod ? (mod.inject || null) : null,
  logs: logs.slice(0, 12)
}
log0(JSON.stringify(out, null, 2))
process.exit(err ? 1 : 0)
