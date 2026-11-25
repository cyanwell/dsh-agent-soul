// AgentSoul v4 soul_waker HTTP surface: read views and write decisions against
// the same Core-owned Ledger instance. The absorbed lead-waker is one runtime owner.
// Legacy statusDir files remain available only to explicit offline readers/tests.
import { readWakerLedger } from '../organs/waker-read.mjs'

export function isWakerPath (req) {
  try {
    const p = new URL(req.url, 'http://x').pathname
    return p === '/api/waker' || p === '/api/waker/decide'
  } catch { return false }
}

function sendJson (res, code, obj) {
  if (res.writableEnded || res.headersSent) return
  let body
  try { body = JSON.stringify(obj) } catch { body = JSON.stringify({ ok: false, error: '结果不能序列化' }) }
  try {
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    })
    res.end(body)
  } catch (e) {}
}

function readBody (req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 2 * 1024 * 1024) { try { req.destroy() } catch (e) {} resolve(null); return }
      chunks.push(c)
    })
    req.on('error', () => resolve(null))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch { resolve(null) }
    })
  })
}

/**
 * @param {object} req @param {object} res
 * @param {{ledger: object, log?: Function}} o
 */
export async function handleWakerApi (req, res, o) {
  let p = ''
  try { p = new URL(req.url, 'http://x').pathname } catch { return false }
  if (p !== '/api/waker' && p !== '/api/waker/decide') return false

  const ledger = o && o.ledger
  const log = (o && o.log) || (() => {})
  if (!ledger || typeof ledger.views !== 'function') {
    sendJson(res, 503, { ok: false, error: '台账没接上（ledger 不可用）' })
    return true
  }

  // —— 读：五视图 + 徽章（★ 从真台账读，不是进程里那个实例）
  if (p === '/api/waker' && req.method === 'GET') {
    try {
      // Read the same v4-owned Ledger instance that the POST decide path mutates.
      // The pre-integration statusDir file is not a second live source of truth.
      const v = readWakerLedger({ ledger })
      // ★ 只回面板要的字段，别把整条事件（可能含长 facts）全推过去
      const slim = (arr) => (arr || []).slice(0, 200).map((e) => ({
        key: e.key,
        t: e.t || null,
        title: String(e.title || '').slice(0, 200),
        from: e.from || null,
        tier: e.tier || null,
        stage: e.stage || null,
        decision: e.decision || null,
        charter: e.charter || null,
        charterNote: String(e.charterNote || '').slice(0, 300),
        note: String(e.note || '').slice(0, 300),
      }))
      sendJson(res, 200, {
        ok: true,
        badge: v.badge,
        total: v.total || 0,
        file: v.file || null,
        why: v.why || null,
        counts: v.counts || { act: 0, done: 0, audit: 0, auto: 0 },
        views: {
          act: slim(v.views && v.views.act), done: slim(v.views && v.views.done),
          audit: slim(v.views && v.views.audit), auto: slim(v.views && v.views.auto),
          blocked: slim(v.views && v.views.blocked),
        },
      })
    } catch (e) {
      log('[waker] 读失败：' + String((e && e.message) || e))
      sendJson(res, 500, { ok: false, error: String((e && e.message) || e).slice(0, 300) })
    }
    return true
  }

  // —— 写：判定
  if (p === '/api/waker/decide' && req.method === 'POST') {
    const body = await readBody(req)
    if (!body || typeof body !== 'object') {
      sendJson(res, 400, { ok: false, error: '请求体不是 JSON 对象' })
      return true
    }
    const key = String(body.key || '').trim()
    if (!key) { sendJson(res, 400, { ok: false, error: '缺 key' }); return true }
    // ★ 只接受白名单字段 —— 别让请求体里的任意键写进台账
    const patch = {}
    for (const f of ['decision', 'charter', 'charterNote', 'note']) {
      if (body[f] !== undefined) patch[f] = String(body[f])
    }
    if (!Object.keys(patch).length) {
      sendJson(res, 400, { ok: false, error: '没有任何可写字段（decision/charter/charterNote/note）' })
      return true
    }
    try {
      const r = ledger.decide(key, patch)
      log('[waker] 判定 ' + key.slice(0, 40) + ' → ' + JSON.stringify(patch).slice(0, 120))
      sendJson(res, r && r.ok ? 200 : 400, r || { ok: false })
    } catch (e) {
      sendJson(res, 500, { ok: false, error: String((e && e.message) || e).slice(0, 300) })
    }
    return true
  }

  sendJson(res, 405, { ok: false, error: '方法不对：GET /api/waker，POST /api/waker/decide' })
  return true
}