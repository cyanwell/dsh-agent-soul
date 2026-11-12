// adapters · 索引检索的 HTTP 只读口（③ 取回式同步的入口）
// ============================================================================
// ★ 为什么是「取回式」而不是「推送式」（爀曦 2026-11-12 拍板）：
//   推送式会把别的会话的帧写进当前上下文 —— 而**上下文变大正是污染的主要来源**，
//   于是「同步」和「换气」直接对冲：加得越多，清理得越勤。
//   取回式只提供**入口**：需要时查得到，不占上下文。
//
// ★ 这个口的形状：
//   GET /api/search?q=<词>&limit=<1-50>
//   → { ok, query, hits: [{ ptr, sessionId, seq, snippet }], took_ms, index: {...} }
//
// ★ 懒加载 + 常驻：openMetaStore(只读) 实测 30ms，所以第一次请求时开、之后复用。
//   搜索本身 1.4-1.9 秒（bigram 预筛 + 原文子串核实），**不放在消息处理路径上**。
// ============================================================================

import { openMetaStore } from '../db/index.mjs'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50

let store = null
let storeErr = null
let lastUsedAt = 0
let searches = 0
let failures = 0
let cacheHits = 0

// ★★ 2026-11-12：**结果缓存**。
//
//   实测发现慢的不是「核实多少条」：候选只有 14 条时也要 1544ms，
//   而候选 18920 条时要 3101ms —— 说明固定开销很大。
//   那个固定开销是 search() 里每次都要算的 index 统计
//   （frames / ftsRows / orphanFtsRows / framesWithoutFts / aligned 五个 COUNT + join 校验）。
//
//   ★ 而取回式同步的调用模式是**同一个词反复查**（我搜「闭环」搜了四五次），
//     所以缓存是这里最直接的提速，而不是去改 search() 内部。
//
//   ★ TTL 5 秒：库是增量更新的，5 秒足够新到「刚写的东西查不到」不算问题
//     （检索本来就是往回看），又足够快。
const RESULT_TTL_MS = 5000
const MAX_CACHE = 200
const cache = new Map()   // key = q + '|' + limit  → { at, payload }

function cacheGet (k) {
  const hit = cache.get(k)
  if (!hit) return null
  if (Date.now() - hit.at > RESULT_TTL_MS) { cache.delete(k); return null }
  return hit.payload
}
function cachePut (k, payload) {
  if (cache.size >= MAX_CACHE) {
    // 简单 FIFO —— 这里不需要 LRU，因为热词会一直被刷新
    const first = cache.keys().next().value
    if (first !== undefined) cache.delete(first)
  }
  cache.set(k, { at: Date.now(), payload })
}

function ensureStore (dbPath) {
  if (store) return store
  if (storeErr) return null
  try {
    store = openMetaStore({ path: dbPath, mode: 'readonly' })
    return store
  } catch (e) {
    // ★ 打不开就记住原因，不要每次都重试 —— 库不存在时每个请求都抛一次会很吵。
    storeErr = String((e && e.message) || e)
    return null
  }
}

export const SEARCH_READ_PORT = Object.freeze({
  id: 'index-search-core',
  v: 1,
  routes: ['GET /api/search'],
  writes: 0,
  capabilities: { receive: false, send: false, sendRoutes: [], apiCalls: [] },
})

export function searchView () {
  return {
    port: SEARCH_READ_PORT.id,
    v: SEARCH_READ_PORT.v,
    ready: Boolean(store),
    error: storeErr,
    searches,
    failures,
    cacheHits,
    cacheSize: cache.size,
    lastUsedAt: lastUsedAt || null,
  }
}

/**
 * 处理 GET /api/search。命中返回 true，不是这个路由返回 false。
 *
 * @param {object} req
 * @param {object} res
 * @param {{ dbPath: string, log?: (m: string) => void }} opts
 */
export function handleSearchEndpoint (req, res, opts) {
  let u = null
  try { u = new URL(req.url, 'http://x') } catch { return false }
  if (u.pathname !== '/api/search') return false

  const reply = (code, obj) => {
    const body = JSON.stringify(obj)
    try {
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        Connection: 'close',
      })
      res.end(body)
    } catch { /* 回包失败不影响已算出的结果 */ }
  }

  if (req.method !== 'GET') { reply(405, { ok: false, error: '只接受 GET' }); return true }

  const q = String(u.searchParams.get('q') || '').trim()
  if (!q) { reply(400, { ok: false, error: '缺 q 参数' }); return true }
  if (q.length > 64) { reply(400, { ok: false, error: 'q 太长（上限 64 字符）' }); return true }

  const rawLimit = Number(u.searchParams.get('limit'))
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : DEFAULT_LIMIT))

  // ★ 命中缓存就直接回 —— 连同 took_ms 一起复用（那个值是这次真实花的时间，
  //   不是缓存的时间；调用方看 took_ms 是为了判断"这条路快不快"，不是"这次等了几毫秒"）。
  const ck = q + '|' + limit
  const cached = cacheGet(ck)
  if (cached) {
    cacheHits++
    lastUsedAt = Date.now()
    reply(200, { ...cached, cached: true })
    return true
  }

  const st = ensureStore(opts && opts.dbPath)
  if (!st) {
    failures++
    reply(503, { ok: false, error: '索引库打不开', detail: storeErr })
    return true
  }

  const t0 = Date.now()
  try {
    const r = st.search(q)
    const took = Date.now() - t0
    lastUsedAt = Date.now()
    searches++
    const hits = (r.results || []).slice(0, limit).map((h) => ({
      ptr: h.ptr,
      sessionId: h.sessionId,
      seq: h.seq,
      snippet: h.snippet,
      sourceId: h.sourceId,
    }))
    const payload = {
      ok: true,
      query: q,
      took_ms: took,
      hits,
      counts: { hits: hits.length, candidates: r.candidates, scanned: r.scanned },
      // ★ index 字段带上：让调用方一眼看出「库是不是完整」（aligned=false 就该怀疑结果）
      index: r.index || null,
    }
    cachePut(ck, payload)
    reply(200, payload)
  } catch (e) {
    failures++
    reply(500, { ok: false, error: '检索失败', detail: String((e && e.message) || e).slice(0, 300) })
  }
  return true
}
