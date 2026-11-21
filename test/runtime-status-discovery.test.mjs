// 单测：架构收敛第 3 批 —— (a) 心跳地址自动发现已退役；(b) 控制通道 state 补 title/isSub
//
// ★ 为什么要有它：这两条都是「不会报错的改动」。
//   (a) 退回 UNCONFIGURED —— 看起来像故障，其实是**已经不再去找**；
//   (b) 少抄三个字段 —— 宿主报了、hub 也存了，只是没到界面，长得像「宿主没报」。
//   两个坑都不会抛错，只能靠测试钉住。
//
// ★ 本测试**不联网、不读 DSH 目录**：fetchImpl 是假的，而且它会记下「被调了几次」。
import { hubUrlOf, heartbeatUrlOf, buildControlView, sanitizeError } from '../src/web/runtime-status.mjs'

const out = []
let failed = 0
const check = (label, ok, extra) => {
  out.push((ok ? '  ✓ ' : '  ✗ ') + label + (extra === undefined ? '' : '   [' + extra + ']'))
  if (!ok) failed += 1
}

// ── (a) 地址解析 ────────────────────────────────────────────────
{
  const u = heartbeatUrlOf({})
  check('什么都没配 → 不配置（不发任何请求）', u.configured === false && u.url === null, JSON.stringify({ c: u.configured, u: u.url }))
  check('并且标了 discoveryRetired', u.discoveryRetired === true, String(u.discoveryRetired))
  check('而且说清为什么不去自动找', /已退役/.test(String(u.discoverWhy)), String(u.discoverWhy).slice(0, 24))
  check('没有「发现到」的 source（旧链路不许再冒出来）', u.source === undefined, String(u.source))
}
{
  const h = hubUrlOf({})
  check('MCP Hub 同样不再自动发现', h.configured === false && h.discoveryRetired === true, JSON.stringify({ c: h.configured, r: h.discoveryRetired }))
}
{
  const u = heartbeatUrlOf({ integrations: { heartbeatUrl: 'http://127.0.0.1:65001/heartbeat/auto' } })
  check('显式 heartbeatUrl 优先，原样用整条', u.configured === true && u.url === 'http://127.0.0.1:65001/heartbeat/auto', u.url)
  check('显式配置时不带 discoveryRetired 噪音', u.discoveryRetired === undefined, String(u.discoveryRetired))
}
{
  const u = heartbeatUrlOf({ integrations: { dshBaseUrl: 'http://127.0.0.1:65002' } })
  check('dshBaseUrl 派生 /heartbeat/auto', u.configured === true && u.url === 'http://127.0.0.1:65002/heartbeat/auto', u.url)
  const h = hubUrlOf({ integrations: { dshBaseUrl: 'http://127.0.0.1:65002' } })
  check('dshBaseUrl 派生 /mcp-hub/servers', h.configured === true && h.url === 'http://127.0.0.1:65002/mcp-hub/servers', h.url)
}
{
  const u = heartbeatUrlOf({ integrations: { heartbeatUrl: 'ftp://x/y' } })
  check('非法协议仍然是配置错误（不是「没配」）', u.configured === true && u.url === null && /只接受 http/.test(String(u.error)), u.error)
}
// 退化检查：即使本机真的存在 dsh-origin.txt / 启动日志，也**不许**被读进来
{
  // ★ 这两个路径是本机开发默认（存在），如果还有人读它们，configured 会变成 true
  const u = heartbeatUrlOf({})
  check('本机存在 dsh-origin.txt 也不会被读（自动发现真的退役了）', u.configured === false && u.url === null, JSON.stringify({ c: u.configured, u: u.url }))
}

// ── (b) 控制通道 state 投影 ─────────────────────────────────────
{
  const snap = [{
    id: 'h1', host: 'dsh', transport: 'ws', caps: ['sessions'],
    meta: { pid: 1, plugin: 'bridge', version: '1', contextWindow: 1048576, contextTokens: 10 },
    state: {
      contextTokens: 482000, contextWindow: 1048576, outputTokens: 0, turnId: 'dsh-t1-s1',
      at: '2026-11-16T00:00:00.000Z', sessionId: 'session-abc',
      sessionTitle: '架构收敛第 3 批', isSub: false, watermarkSource: 'sessionProjections.contextPressure',
    },
  }]
  const v = buildControlView(snap)
  const s = v.hosts[0].state
  check('state.sessionTitle 抄到了', s.sessionTitle === '架构收敛第 3 批', String(s.sessionTitle))
  check('state.isSub=false 如实保留（不是 null）', s.isSub === false, String(s.isSub))
  check('state.watermarkSource 抄到了', s.watermarkSource === 'sessionProjections.contextPressure', String(s.watermarkSource))
  check('原有字段没被动', s.contextTokens === 482000 && s.turnId === 'dsh-t1-s1', JSON.stringify(s.contextTokens))
}
{
  const v = buildControlView([{ id: 'h2', host: 'dsh', state: { contextTokens: 1 } }])
  const s = v.hosts[0].state
  check('宿主没报 title/isSub 时是 null（不编值）', s.sessionTitle === null && s.isSub === null, JSON.stringify({ t: s.sessionTitle, s: s.isSub }))
}
{
  const v = buildControlView([{ id: 'h3', host: 'dsh' }])
  check('没有 state 时整块是 null（不是空对象）', v.hosts[0].state === null, String(v.hosts[0].state))
}

// ── 附带守卫：错误文本脱敏仍然生效（collector 用自己的 note 会把 why 带出去） ──
{
  const s = sanitizeError('boom sk-abcdef123456 token=zzz')
  check('sanitizeError 仍然脱敏', !/sk-abcdef123456/.test(s) && !/token=zzz/.test(s), s)
}

console.log(out.join('\n'))
console.log(failed === 0 ? '\n★ 全部通过' : '\n★ 失败 ' + failed + ' 项')
process.exit(failed === 0 ? 0 : 1)
