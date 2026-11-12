// 宿主活跃会话的扫描接口（只读诊断）
//
// ★ 和 /api/huanqi/scan 的区别：
//   /api/huanqi/scan      → 扫 **v4 自己的** data/sessions（v4 跑过的回合）
//   /api/huanqi/host-scan → 扫 **宿主（DSH）的** sessions（所有活跃会话）
//
// ★★ 爀曦 2026-11-13：「活跃会话是最近在活跃的，超过 3 天静息的不纳入扫描。」
//   实测：3 天内 229 个（全量 930 个）—— 扫 229 个只要 10.8 秒。
import { scanActiveHostSessions, listActiveHostSessions } from './host-sessions.mjs'

export function isHostScanPath (req) {
  try {
    const p = new URL(req.url, 'http://x').pathname
    return p === '/api/huanqi/host-scan' || p === '/api/huanqi/host-list'
  } catch { return false }
}

function sendJson (res, code, obj) {
  if (res.writableEnded || res.headersSent) return
  let body
  try { body = JSON.stringify(obj) } catch { body = JSON.stringify({ ok: false, error: '不能序列化' }) }
  try {
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    })
    res.end(body)
  } catch {}
}

/**
 * @param {object} req @param {object} res
 * @param {{root?:string, log?:Function}} o
 */
export function handleHostScan (req, res, o) {
  let p = ''
  try { p = new URL(req.url, 'http://x').pathname } catch { return false }
  if (p !== '/api/huanqi/host-scan' && p !== '/api/huanqi/host-list') return false

  const root = (o && o.root) || 'D:/AI/dsh/home/sessions'
  const log = (o && o.log) || (() => {})
  const t0 = Date.now()

  try {
    if (p === '/api/huanqi/host-list') {
      // 只列表，不诊断（快）
      const l = listActiveHostSessions({ root, activeDays: 3 })
      sendJson(res, 200, { ok: true, root: l.root, activeDays: 3, count: l.sessions.length, sessions: l.sessions })
      return true
    }
    const r = scanActiveHostSessions({ root, activeDays: 3 })
    const ms = Date.now() - t0
    log('[huanqi/host-scan] ' + r.scanned + ' 个会话 · ' + ms + 'ms · ' + JSON.stringify(r.byLevel))
    sendJson(res, 200, { ok: true, ms, ...r })
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String((e && e.message) || e).slice(0, 300) })
  }
  return true
}