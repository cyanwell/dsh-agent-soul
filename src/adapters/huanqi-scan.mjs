// 主动诊断：扫所有活跃会话，跑换气诊断（不等退化才起作用）
// ============================================================================
// ★ 为什么要有这个（爀曦 2026-11-13 定）：
//   「除了被动，还应该做主动的诊断和清除，不是要等到思考退化了才起作用，
//     这样子我们也能更快验证。」
//
//   v4 原来只有 `/api/huanqi/analyze` —— **一次一个会话、要人点名**。
//   那是「被动」：得先怀疑某个会话脏了，才去问它。
//
//   这个 scan 不一样：**它主动把最近活跃的会话都过一遍**，
//   所以不用等「思考退化」这种事后信号，**随时能看见污染长什么样**。
//
// ★ 设计上的三条：
//   ① **只诊断，不清理。** 清理是不可逆的（走宿主 pruner），必须人来点。
//   ② **按 mtime 取最近 N 个** —— 活动中的才值得看，几周没动的会话诊断了也没人管。
//   ③ **并发跑但限流** —— 每个会话一次 LLM 调用，扫 10 个就是 10 次，串行太慢、无限并发会打爆。
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { analyzeContext } from '../organs/huanqi-llm.mjs'

export function isHuanqiScanPath (req) {
  try { return new URL(req.url, 'http://x').pathname === '/api/huanqi/scan' } catch { return false }
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

/** 读一个会话的尾部帧 */
function readTailFrames (dir, sessionId, maxFrames) {
  const f = path.join(dir, 'sessions', sessionId, 'frames.jsonl')
  let st
  try { st = fs.statSync(f) } catch { return null }
  // 只读尾部 1MB —— 10MB 的会话全读太慢，而污染总在最近
  const tailBytes = 1024 * 1024
  const start = Math.max(0, st.size - tailBytes)
  let raw = ''
  try {
    const fd = fs.openSync(f, 'r')
    const buf = Buffer.alloc(st.size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    fs.closeSync(fd)
    raw = buf.toString('utf8')
  } catch { return null }
  const lines = raw.split('\n').filter((l) => l.trim())
  const frames = []
  for (const l of lines.slice(-maxFrames)) {
    try { frames.push(JSON.parse(l)) } catch { /* 半行丢掉 */ }
  }
  return { frames, bytes: st.size, mtimeMs: st.mtimeMs }
}

/**
 * @param {object} req @param {object} res
 * @param {{dataDir:string, llm:object, log?:Function, limit?:number, framesPerSession?:number}} o
 */
export async function handleHuanqiScan (req, res, o) {
  let p = ''
  try { p = new URL(req.url, 'http://x').pathname } catch { return false }
  if (p !== '/api/huanqi/scan') return false

  const dataDir = (o && o.dataDir) || ''
  const llm = (o && o.llm) || null
  const log = (o && o.log) || (() => {})
  const limit = Number((o && o.limit) || 5)
  const framesPer = Number((o && o.framesPerSession) || 40)

  if (!dataDir) { sendJson(res, 503, { ok: false, error: '没有 dataDir' }); return true }
  if (!llm) { sendJson(res, 503, { ok: false, error: '没有 llm（诊断要它判断语义）' }); return true }

  const t0 = Date.now()
  // ① 按 mtime 取最近活跃的 N 个会话
  let dirs = []
  try {
    dirs = fs.readdirSync(path.join(dataDir, 'sessions'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const f = path.join(dataDir, 'sessions', d.name, 'frames.jsonl')
        try { const st = fs.statSync(f); return { id: d.name, mtime: st.mtimeMs, bytes: st.size } } catch { return null }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit)
  } catch (e) {
    sendJson(res, 500, { ok: false, error: '读 sessions 目录失败：' + String((e && e.message) || e) })
    return true
  }

  if (!dirs.length) { sendJson(res, 200, { ok: true, scanned: 0, results: [], ms: Date.now() - t0 }); return true }

  // ② 逐个诊断（串行 —— 限流，避免同时打多个 LLM 请求）
  const results = []
  for (const d of dirs) {
    const got = readTailFrames(dataDir, d.id, framesPer)
    if (!got || !got.frames.length) {
      results.push({ sessionId: d.id, ok: false, why: '读不到帧', bytes: d.bytes })
      continue
    }
    const t1 = Date.now()
    try {
      const r = await analyzeContext({ llm, frames: got.frames, log: () => {} })
      results.push({
        sessionId: d.id,
        ok: true,
        bytes: got.bytes,
        frames: got.frames.length,
        polluted: Boolean(r && r.polluted),
        ranges: (r && r.ranges) || [],
        summary: String((r && r.summary) || '').slice(0, 300),
        ms: Date.now() - t1,
      })
    } catch (e) {
      results.push({ sessionId: d.id, ok: false, why: String((e && e.message) || e).slice(0, 200), ms: Date.now() - t1 })
    }
  }

  const polluted = results.filter((r) => r.polluted).length
  log('[huanqi/scan] 扫了 ' + results.length + ' 个会话，' + polluted + ' 个有污染（' + (Date.now() - t0) + 'ms）')
  sendJson(res, 200, {
    ok: true,
    scanned: results.length,
    polluted,
    ms: Date.now() - t0,
    results,
  })
  return true
}