// echo 页的后端：调 echo-doctor 的 runDoctor，5 分钟缓存
// ============================================================================
// ★ 为什么要缓存：runDoctor({mode:'deep'}) 实测 3.8 秒（要扫 1366 份日志、
//   读 chunks/objects/vectors、测门牌回取）。页面自动刷新时不能每次都跑 3.8 秒。
//
// ★ 为什么逻辑不搬进 v4：`echo-doctor.mjs` 是**命令行与面板共用的同一份**
//   （它自己的 package.json 就这么写的）。搬进来就会变成两份，早晚不一致。
//   **v4 只做壳，逻辑留在那一份里。**
// ============================================================================

import { pathToFileURL } from 'node:url'

const DOCTOR = 'D:/AI/memory/hub/echo-doctor.mjs'
const TTL_MS = 5 * 60 * 1000

let cache = null
let cacheAt = 0
let inflight = null

async function runOnce (log) {
  const t0 = Date.now()
  const mod = await import(pathToFileURL(DOCTOR).href)
  if (typeof mod.runDoctor !== 'function') throw new Error('echo-doctor.mjs 没有导出 runDoctor')
  const r = await mod.runDoctor({})
  log('[echo] 体检完成 ' + (Date.now() - t0) + 'ms · overall=' + r.overall)
  return r
}

export function echoView (opts) {
  const o = opts || {}
  return {
    cached: cache != null,
    at: cache ? cache.at : null,
    ageMs: cache ? Date.now() - cacheAt : null,
    ttlMs: TTL_MS,
  }
}

/**
 * 同步判断是不是 echo 的请求。
 * ★ 为什么单独一个：调用方（server 的 request 回调）是同步的，不能 await；
 *   所以它需要「先同步问一句是不是我的」，再决定要不要把异步处理丢出去。
 */
export function isEchoPath (req) {
  try { return new URL(req.url, 'http://x').pathname === '/api/echo' } catch { return false }
}

export async function handleEchoApi (req, res, opts) {
  let p = ''
  try { p = new URL(req.url, 'http://x').pathname } catch { return false }
  if (p !== '/api/echo') return false

  const log = (opts && opts.log) || (() => {})
  const force = /[?&]force=1/.test(String(req.url || ''))
  const now = Date.now()

  const reply = (code, obj) => {
    if (res.writableEnded) return
    const body = JSON.stringify(obj)
    try {
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
      })
      res.end(body)
    } catch (e) {}
  }

  // 缓存命中且没过期
  if (!force && cache && now - cacheAt < TTL_MS) {
    return reply(200, { ok: true, cached: true, ageMs: now - cacheAt, ...cache }), true
  }

  // 已有一次在跑 —— 复用它，不要并发跑两遍 3.8 秒
  if (inflight) {
    try {
      const r = await inflight
      return reply(200, { ok: true, cached: true, ageMs: Date.now() - cacheAt, ...r }), true
    } catch (e) {
      return reply(500, { ok: false, error: String((e && e.message) || e) }), true
    }
  }

  inflight = runOnce(log)
  try {
    const r = await inflight
    cache = r
    cacheAt = Date.now()
    reply(200, { ok: true, cached: false, ...r })
  } catch (e) {
    log('[echo] 体检失败：' + String((e && e.message) || e))
    reply(500, { ok: false, error: String((e && e.message) || e).slice(0, 300) })
  } finally {
    inflight = null
  }
  return true
}