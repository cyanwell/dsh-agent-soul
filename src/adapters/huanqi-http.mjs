// adapters · 换气语义分析的 HTTP 口（用 v4 内嵌 LLM，只在 core 进程里能用）
// ============================================================================
// ★ 为什么必须在 core 里跑，不能写成独立脚本：
//   `llm.apiKeyRef` 是 `dpapi:` 密文 —— 只有 **AgentSoul.exe 以当前用户身份起的进程**
//   才解得开。独立脚本（node tools/xxx.mjs）永远拿到 ready=false。
//   这条 2026-11-12 实测过：探针跑出来 `LLM ready = false`，而 core 的 /api/health 是 llmReady:true。
//
// ★ 这个口只做**判断**，不动手：
//   POST /api/huanqi/analyze  { sessionId?, frames? }
//   → { ok, polluted, ranges:[{start,end,kinds,reasons}], confidence, ms }
//   执行清理是另一件事（cleanup.mjs 的 targeted-cleanup，有宿主回执核对）。
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { analyzeContext } from '../organs/huanqi-llm.mjs'

let analyses = 0
let failures = 0
let lastMs = 0

export const HUANQI_ANALYZE_PORT = Object.freeze({
  id: 'huanqi-analyze-core',
  v: 1,
  routes: ['POST /api/huanqi/analyze'],
  writes: 0,
  capabilities: { receive: true, send: false, sendRoutes: [], apiCalls: ['llm'] },
})

export function huanqiView () {
  return { port: HUANQI_ANALYZE_PORT.id, v: HUANQI_ANALYZE_PORT.v, analyses, failures, lastMs }
}

/** 从 dataDir/sessions/<id>/frames.jsonl 取最近 n 帧 */
function readFrames (dataDir, sessionId, n) {
  const f = path.join(dataDir, 'sessions', sessionId, 'frames.jsonl')
  if (!fs.existsSync(f)) return { ok: false, error: '会话帧不存在：' + f }
  let lines = []
  try { lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) } catch (e) {
    return { ok: false, error: '读帧失败：' + String((e && e.message) || e) }
  }
  const out = []
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    let r = null
    try { r = JSON.parse(lines[i]) } catch { continue }
    if (!r || r.type === 'session' || typeof r.seq !== 'number') continue
    const t = String(r.text || '')
    if (!t) continue
    out.push({ seq: r.seq, type: r.type || 'unknown', text: t })
  }
  out.reverse()
  return { ok: true, frames: out }
}

/**
 * 处理 POST /api/huanqi/analyze。命中返回 true。
 * @param {object} req @param {object} res
 * @param {{llm:object, dataDir:string, log?:Function}} opts
 */
export function handleHuanqiAnalyze (req, res, opts) {
  let p = ''
  try { p = new URL(req.url, 'http://x').pathname } catch { return false }
  if (p !== '/api/huanqi/analyze') return false

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

  if (req.method !== 'POST') { reply(405, { ok: false, error: '只接受 POST' }); return true }

  let raw = ''
  let size = 0
  req.on('data', (c) => {
    size += c.length
    if (size > 512 * 1024) { try { req.destroy() } catch {} return }
    raw += c
  })
  req.on('end', async () => {
    const t0 = Date.now()
    try {
      let body = {}
      try { body = raw ? JSON.parse(raw) : {} } catch { reply(400, { ok: false, error: 'body 不是 JSON' }); return }

      let frames = Array.isArray(body.frames) ? body.frames : null
      let sid = String(body.sessionId || '')
      if (!frames) {
        if (!sid) { reply(400, { ok: false, error: '要么给 sessionId，要么给 frames' }); return }
        const g = readFrames(opts.dataDir, sid, Number(body.frames > 0 ? body.frames : 60) || 60)
        if (!g.ok) { reply(404, { ok: false, error: g.error }); return }
        frames = g.frames
      }
      if (!frames.length) { reply(400, { ok: false, error: '没有可分析的帧' }); return }

      const r = await analyzeContext({ llm: opts.llm, frames, log: opts.log })
      const ms = Date.now() - t0
      if (r.ok) { analyses++; lastMs = ms } else { failures++ }
      reply(r.ok ? 200 : 502, { ...r, ms, sessionId: sid || null })
    } catch (e) {
      failures++
      reply(500, { ok: false, error: String((e && e.message) || e).slice(0, 300) })
    }
  })
  req.on('error', () => { failures++; try { reply(400, { ok: false, error: '请求体读失败' }) } catch {} })
  return true
}