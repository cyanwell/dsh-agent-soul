// bridge-preboot-check.mjs —— 重启前的预检：确认 profile 里那份 bridge 能被真正加载
// 为什么要有它：0.1.5 的关键改动（lifecycle-inspect / process-inspector / manager-proof-client）
// 都是 index.js 的**顶层 import**。import 失败 = 整包静默不加载（DSH 插件第一号杀手）。
// 所以这里只做一件事：照加载器的方式 import 一次，并核对导出的形状。
const target = 'file:///D:/AI/dsh/home/profiles/desktop/node_modules/dsh-agent-soul-bridge/index.js'
const out = { target, ok: false }
try {
  const mod = await import(target)
  out.ok = true
  out.exports = Object.keys(mod).sort()
  out.name = mod.name || null
  out.inject = Array.isArray(mod.inject) ? mod.inject : null
  out.hasApply = typeof mod.apply === 'function'
  const d = mod.DEFAULTS || {}
  out.defaults = {
    url: d.url || null,
    hostName: d.hostName || null,
    capsCount: Array.isArray(d.caps) ? d.caps.length : null,
    stubCaps: d.stubCaps || null,
    agentSoulRoot: d.agentSoulRoot || null,
    prunerLive: d.prunerLive === undefined ? null : d.prunerLive,
  }
  // 顶层 import 的五个模块都要能被解析（导出形状核对）
  out.helpers = {}
  for (const f of ['lifecycle-inspect.mjs', 'process-inspector.mjs', 'manager-proof-client.mjs', 'bridge-proof.mjs', 'pruner-adapter.mjs', 'context-surgeon.mjs']) {
    const p = 'file:///D:/AI/dsh/home/profiles/desktop/node_modules/dsh-agent-soul-bridge/' + f
    try {
      const m = await import(p)
      out.helpers[f] = Object.keys(m).sort()
    } catch (e) {
      out.helpers[f] = 'ERR ' + String((e && e.code) || (e && e.message)).slice(0, 80)
    }
  }
} catch (e) {
  out.ok = false
  out.error = String((e && e.message) || e).slice(0, 400)
  out.code = e && e.code
}
process.stdout.write(JSON.stringify(out, null, 1) + '\n')
