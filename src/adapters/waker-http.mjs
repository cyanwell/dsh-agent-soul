// 台账页的后端：读 waker 的五视图，写判定
// ============================================================================
// ★ 为什么在 v4 里做：v3 的 `dsh-yanqing-lead-waker` 面板就是这个。
//   爀曦的目标是解耦 —— 尽量少往 DSH 里装东西。所以这个面板要搬进 v4。
//
// ★ 数据源是 v4 自己的 `organs/waker.mjs`（Ledger 类），不是 v3 的那个 json：
//     views() → { act, done, audit, auto, blocked, badge }
//     decide(key, patch) → 写判定（applyDecision）
//   v3 的台账文件仍是**上游**（只追加、别人写），v4 只读它、自己的判定写在 v4 侧。
// ============================================================================

// ★★ 2026-11-13：**必须用 readWakerLedger()，不是 ledger.views()。**
//
//   `organs/waker-read.mjs` 的头注里写着这个坑（2026-11-10 修过）：
//     · 一代：soul_waker 读 <dataDir>/ledger.json（进程里那个 Ledger 实例）
//     · 真事件在 <状态目录>/lead-waker-台账.json
//   **两个文件同构、字段同名，所以读错不会报错，只会安静地显示一个很小的数**
//   （本机实测：1 条 vs 43 条）。
//
//   ★ 我第一版就是用的 ledger.views() —— 面板上全是 0，正是那个「安静的小数」。
//   现在读真台账；写判定仍走 ledger.decide（v4 自己的账本）。
import { readWakerLedger } from '../organs/waker-read.mjs'
import { wakerLedgerFileOf } from '../config.mjs'
import { viewsOf, badgeOf } from '../organs/waker.mjs'

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
      // ★★ 必须传 config（或 file）—— 传空对象它会直接返回「没有台账路径」，
      //    面板上就是全 0。我第一次就是这么错的。
      // ★ 而且它自己就返回 views / counts / badge（waker-read.mjs:37-40），
      //    **不用我再 viewsOf 算一遍** —— 算两遍反而可能和它对不上。
      // ★★ 传 file 而不是 config：
      //   `wakerLedgerFileOf(config)` 依赖 config 里的 statusDir / soul.root，
      //   而 core 那份 config.json **没有这两项** —— 于是它 fallback 到
      //   `appRoot()/workspace/lead-waker-台账.json`（一个不存在的路径）。
      //   不带参数调 `wakerLedgerFileOf()` 才是对的：它会用默认状态目录。
      const led = readWakerLedger({ file: wakerLedgerFileOf() })
      const v = led || {}
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