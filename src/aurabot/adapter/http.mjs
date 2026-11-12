// aurabot 路由 → v4 HTTP 的桥
// ============================================================================
// `apply(ctx)` 把 57 个 route 注册进适配器的表里，这个文件把它们接到 v4 的 HTTP。
//
// ★★ 一处关键（2026-11-12 踩到）：
//   aurabot 的 `route()` 不是「handler 返回对象、框架帮你 JSON 化」，
//   而是 **cordis 的 (req, res) 风格**：
//     const answer = async (res, fn) => { const r = await fn(); if (r !== undefined) send(res, 200, r) }
//     const route = (path, handler) => webServer.register({ ..., handler: (req, res) => answer(res, () => handler(req, res)) })
//   而 `send` 直接操作 res（writeHead + end）。
//   → 所以这里**把真 req / 真 res 原样递进去**，不自己 JSON 化。
//     我第一版按「返回对象」写，结果 /state 回了 null —— 因为 handler 早就把响应用 res 写完了。
// ============================================================================

export const AURABOT_API_PREFIX = '/aurabot/api'

export function handleAurabotApi (req, res, o) {
  let u = null
  try { u = new URL(req.url, 'http://x') } catch { return false }
  const p = u.pathname
  if (!p.startsWith(AURABOT_API_PREFIX)) return false

  const routes = (o && o.routes) || new Map()
  const log = (o && o.log) || (() => {})
  // ★★ 2026-11-12：两种路由都要认。
  //   精确（kind='exact'）：直接按完整路径查。
  //   前缀（kind='prefix'）：host.js 注册了一个 PREFIX 前缀路由，**模块的接口全走它**
  //     （模块随时开关，所以它的路径不是静态的）。
  //   ★ 我第一版只查精确，于是所有模块接口（/stickers、/voice/*、/memory/*…）全 404。
  let hit = routes.get(p)
  if (!hit) {
    // 前缀匹配：找 path 是 p 的前缀、且 kind=prefix 的那条；取**最长**的（更具体优先）
    let best = null
    for (const [rp, v] of routes) {
      if (v.kind !== 'prefix') continue
      if (!(p === rp || p.startsWith(rp + '/'))) continue
      if (!best || rp.length > best.rp.length) best = { rp, v }
    }
    if (best) hit = best.v
  }

  const reply = (code, obj) => {
    if (res.writableEnded || res.headersSent) return
    let body
    try { body = JSON.stringify(obj === undefined ? null : obj) } catch (e) { body = JSON.stringify({ ok: false, error: '结果不能序列化' }) }
    try {
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        Connection: 'close',
      })
      res.end(body)
    } catch (e) {}
  }

  if (!hit) {
    reply(404, { ok: false, error: 'aurabot 没有这个接口: ' + p, registered: routes.size })
    return true
  }

  // query 塞进 req（aurabot 的 queryOf(req) 会再解析一次 url，两个都留着不冲突）
  try {
    req.query = {}
    for (const [k, v] of u.searchParams.entries()) req.query[k] = v
    req.pathname = p
  } catch (e) {}

  // 读 body（POST 要用）—— 读完再交给 handler
  const chunks = []
  let size = 0
  let aborted = false
  req.on('data', (c) => {
    if (aborted) return
    size += c.length
    if (size > 8 * 1024 * 1024) { aborted = true; try { req.destroy() } catch (e) {} return }
    chunks.push(c)
  })
  req.on('error', () => { if (!aborted) { aborted = true; reply(400, { ok: false, error: '请求体读失败' }) } })
  req.on('end', () => {
    if (aborted) return
    const raw = Buffer.concat(chunks).toString('utf8')
    if (raw) { try { req.body = JSON.parse(raw) } catch (e) { req.body = raw } }
    else req.body = req.method === 'GET' ? null : {}
    // ★ 原样递 (req, res) —— aurabot 自己写响应
    Promise.resolve()
      .then(() => hit.handler(req, res))
      .catch((e) => {
        log('[aurabot] ' + p + ' 抛错: ' + String((e && e.message) || e))
        reply(500, { ok: false, error: String((e && e.message) || e).slice(0, 400), path: p })
      })
      .then(() => {
        // ★ 兜底：handler 什么都没写（v4 会挂住连接），回 204
        setTimeout(() => {
          if (!res.writableEnded && !res.headersSent) {
            try { res.writeHead(204, { Connection: 'close' }); res.end() } catch (e) {}
          }
        }, 100)
      })
  })
  return true
}