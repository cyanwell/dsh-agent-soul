// 换气：上下文手术的 HTTP 入口（v4 → bridge 的 cap='context'）
//
// ★ 用途：让 v4 的干预能真的对宿主会话的上下文动刀。
//   两个动作：
//     GET  /api/huanqi/context/candidates?sessionId=xxx   列可清的点（只读）
//     POST /api/huanqi/context/purge                      按 seq 精准替换
//
// ★ 安全：purge 是**不可逆**的（虽然原文可回取），所以：
//   · 必须显式给 sessionId
//   · 必须给非空 items[]
//   · 回执里成功/失败分开列，全失败回 ok:false
// ★★★ 2026-11-13 安全加固（任务 4c）：purge 是**不可逆**的（虽然原文可回取），
//   所以加三道闸：
//     ① **必须显式 confirm: true** —— 防止误触发（curl 手滑、脚本重放）
//     ② **同一会话频率限制** —— 5 分钟内最多 3 次（防止一个循环把上下文反复削）
//     ③ **单次 items 上限** —— 最多 5 条（防止一次削掉半个会话）
//   ★ 三条都不是「防坏人」，是「防手滑」和「防自己循环」。
import fs from 'node:fs'

const PURGE_GUARD = {
  windowMs: 5 * 60 * 1000,
  maxPerWindow: 3,
  maxItemsPerCall: 5,
}
const purgeHistory = new Map()   // sessionId → [时间戳...]

// ★★ 2026-11-13（B）：**已清过的 seq 要记住**，否则 candidates 会一直把它们列出来。
//
//   为什么 candidates 会列：它扫的是 `eventAt(seq)` —— 而日志是 append-only，
//   `surfaceOp.replace` 只改**上下文（surface）**，原始事件还在。
//   所以「candidates 还能看到」是对的，但它不该再建议你去清第二次。
//
//   ★ 这份记录放 v4 侧（落盘 dataDir/huanqi-purged.json），不去动 bridge ——
//     动 bridge 要重启 DSH，而这件事 v4 自己能管。
const autoLastAt = new Map()   // sessionId → 上次自动干预时间

let _purgedFile = null
const purgedSeqs = new Map()   // sessionId → Set<seq>

export function setPurgedFile (p) { _purgedFile = p; loadPurged() }

function loadPurged () {
  if (!_purgedFile) return
  try {
    const j = JSON.parse(fs.readFileSync(_purgedFile, 'utf8'))
    for (const [sid, arr] of Object.entries(j || {})) purgedSeqs.set(sid, new Set(arr))
  } catch { /* 没有就算了 */ }
}

function savePurged () {
  if (!_purgedFile) return
  try {
    const obj = {}
    for (const [sid, set] of purgedSeqs) obj[sid] = [...set]
    fs.writeFileSync(_purgedFile, JSON.stringify(obj, null, 2), 'utf8')
  } catch { /* 写不进去不影响主流程 */ }
}

function markPurged (sessionId, seq) {
  let s = purgedSeqs.get(sessionId)
  if (!s) { s = new Set(); purgedSeqs.set(sessionId, s) }
  s.add(Number(seq))
  savePurged()
}

function purgeAllowed (sessionId, now) {
  const arr = (purgeHistory.get(sessionId) || []).filter((t) => now - t < PURGE_GUARD.windowMs)
  purgeHistory.set(sessionId, arr)
  if (arr.length >= PURGE_GUARD.maxPerWindow) {
    return { ok: false, why: '这个会话 ' + Math.round(PURGE_GUARD.windowMs / 60000) + ' 分钟内已经清过 ' + arr.length + ' 次（上限 ' + PURGE_GUARD.maxPerWindow + '）—— 冷却后再来' }
  }
  return { ok: true }
}

function purgeRecord (sessionId, now) {
  const arr = purgeHistory.get(sessionId) || []
  arr.push(now)
  purgeHistory.set(sessionId, arr)
}

// ★★★ 2026-11-13：手动触发一次完整干预（诊断 + 修复）。
//
//   POST /api/huanqi/intervene  { sessionId, dryRun?: bool }
//
//   ★ 这是爀曦说的「通路接好了之后，可以调用内嵌 LLM 立刻对会话做诊断和修复」的入口。
//   ★ dryRun=true 时只诊断不修（默认 true —— 安全第一）。
//   ★ 真正的自动干预不走这里，走 loop 里的三档判据。
/** 由 index.mjs 注入的干预函数 */
let _intervene = null
export function setIntervener (fn) { _intervene = fn }
/** 宿主会话扫描（主动巡视用） */
let _scanner = null
export function setHostScanner (fn) { _scanner = fn }

export function isContextPath (req) {
  try {
    const p = new URL(req.url, 'http://x').pathname
    // ★★★ 2026-11-13：这里是**真正那道门** —— handleContextApi 里那个 KNOWN 数组不管路由，
    //   是这道 isContextPath 决定请求能不能进到这个模块。加了新路由忘了这里，
    //   表现是 `{"error":"没有这个路由: /api/huanqi/panel"}`（我踩了一次）。
    return p === '/api/huanqi/panel'
      || p === '/api/huanqi/context/candidates'
      || p === '/api/huanqi/context/purge'
      || p === '/api/huanqi/intervene'
      || p === '/api/huanqi/auto'
  } catch { return false }
}

function sendJson (res, code, obj) {
  if (res.writableEnded || res.headersSent) return
  let body
  try { body = JSON.stringify(obj) } catch { body = JSON.stringify({ ok: false, error: '不能序列化' }) }
  try {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' })
    res.end(body)
  } catch {}
}

function readBody (req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => { size += c.length; if (size > 1024 * 1024) { try { req.destroy() } catch {} resolve(null); return } chunks.push(c) })
    req.on('error', () => resolve(null))
    req.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8'); if (!raw) return resolve({}); try { resolve(JSON.parse(raw)) } catch { resolve(null) } })
  })
}

/**
 * 换气主动巡视 —— 一份逻辑两处用。
 *
 * ★ 2026-11-13：原来它**只**存在于 /api/huanqi/auto 这个 HTTP 分支里，
 *   意思是「等外部来调」。而在心跳插件被禁用之后，再没有人调它 ——
 *   v4 的换气能力明明在，那只按时按它的手却断了。
 *   抽成函数之后，内部定时器（autonomy 规则，30 分钟一闸）和 HTTP 走同一条路。
 *
 * @returns {Promise<object>} 结构化结果（调用方决定是发 HTTP 还是记日志）
 */
export async function autoHuanqi (input) {
  const ab = input || {}
  if (!_scanner) return { ok: false, error: '扫描器没接上' }
  const activeMinutes = Number(ab.activeMinutes) > 0 ? Number(ab.activeMinutes) : 120
  const dryRun = ab.dryRun !== false   // ★ 默认 true（只诊断，不动手）
  const t0 = Date.now()
  // ① 扫
  let scanRes = null
  try { scanRes = await _scanner({ activeMinutes }) } catch (e) {
    return { ok: false, error: '扫描失败：' + String((e && e.message) || e) }
  }
  const list = (scanRes && Array.isArray(scanRes.sessions)) ? scanRes.sessions : []
  // ② 筛
  const hot = list.filter((x) => x && (x.level === 'intervene' || x.level === 'warn'))
  const acted = []
  // ③ 干预（带 cooldown）
  if (_intervene) {
    for (const s of hot.slice(0, 3)) {   // 一次最多 3 个，防止拖太久
      const last = autoLastAt.get(s.sessionId) || 0
      if (Date.now() - last < 10 * 60 * 1000) {
        acted.push({ sessionId: s.sessionId, level: s.level, skipped: '10 分钟内干预过' })
        continue
      }
      // ★★★ 2026-11-13（爀曦定）：**红线才真动手，预警只诊断。**
      //
      //   他说：「v4 的换气是有预警功能的，判据变成了检测推理文本的多样性，
      //          低到预警红线的时候，就应该触发，并对上下文进行修复。」
      //
      //   所以 dryRun 不再是一个**全局开关**，而是**按会话的档位**决定：
      //     level === 'intervene'（中位数 ≤ 0.10 红线）→ 真的清
      //     level === 'warn'      （≤ 0.15）          → 只诊断，记下它热了
      //   ★ 这个区分很重要：如果 warn 也动手，等于把「预警」变成「处分」，
      //     而 warn 的阈值离正常值（0.42~0.60）还远 —— 那会误删好东西。
      const perSessionDry = dryRun || s.level !== 'intervene'
      try {
        const r = await _intervene({ sessionId: s.sessionId, dryRun: perSessionDry })
        autoLastAt.set(s.sessionId, Date.now())
        acted.push({ sessionId: s.sessionId, level: s.level, median: s.median, stage: r && r.stage, ok: r && r.ok })
      } catch (e) {
        acted.push({ sessionId: s.sessionId, level: s.level, error: String((e && e.message) || e).slice(0, 120) })
      }
    }
  }
  const out = {
    ok: true, dryRun,
    activeMinutes,
    scanned: list.length,
    byLevel: (scanRes && scanRes.byLevel) || null,
    hot: hot.length,
    actedCount: acted.length,
    acted,
    ms: Date.now() - t0,
    note: hot.length === 0 ? '没有到该干预的会话 —— 这是正常结果' : null,
  }
  // ★ log 由调用方传（原来这里直接用 handleContextApi 闭包里的 log —— 而 autoHuanqi
  //   被抽出来之后就拿不到了，实测报 `log is not defined`。默认 no-op，绝不因为
  //   打日志失败而让巡视本身失败）。
  const say = (ab.log || (() => {}))
  say('[huanqi/auto] 扫 ' + list.length + ' · 热 ' + hot.length + ' · 动 ' + acted.length + ' · ' + out.ms + 'ms')
  return out
}

export async function handleContextApi (req, res, o) {
  let p = ''
  try { p = new URL(req.url, 'http://x').pathname } catch { return false }
  const KNOWN = ['/api/huanqi/panel', '/api/huanqi/context/candidates', '/api/huanqi/context/purge', '/api/huanqi/intervene', '/api/huanqi/auto']
  if (!KNOWN.includes(p)) return false

  const dispatch = o && o.dispatch
  const log = (o && o.log) || (() => {})
  if (!dispatch) { sendJson(res, 503, { ok: false, error: '没有 dispatch（session-dispatch 没接上）' }); return true }

  try {
    // ★★★ 2026-11-13：自动巡视（心跳调这个）—— **条件触发为主，省性能**。
    //
    //   爀曦：「换气以条件触发为主，这样子就可以省性能；定时触发要集成进心跳，
    //          随着心跳一起运行，这样运维层、稳态层也会更加健全」。
    //
    //   三层筛，每层都能提前退出（这是「省性能」的全部意义）：
    //     ① 只扫最近 activeMinutes 分钟内有写入的会话（默认 120）
    //     ② 只对 level ∈ {intervene, warn} 的动手
    //     ③ 同一会话 cooldown 分钟内只干预一次
    //
    //   ★ 没到阈值 → 什么都不做，返回 {acted:0} —— 那是**正常结果**，不是失败。
    // ★★★ 2026-11-13（爀曦）：换气**面板** —— 原来这里只有「诊断」（一次一个会话的候选段）。
    //   他要的是「展示不同活跃会话的预警状态、换气的出手记录」。
    //   一份数据两件事：① 所有活跃会话的档位（谁在往红线走）② 已经清过什么。
    //   ★ 只读：GET 一次扫一遍（几十秒），不做缓存 —— 面板看的就是**现在**。
    if (p === '/api/huanqi/panel') {
      if (!_scanner) { sendJson(res, 503, { ok: false, error: '扫描器没接上' }); return true }
      const t0 = Date.now()
      let scan = null
      try { scan = await _scanner({ activeMinutes: 180 }) } catch (e) {
        sendJson(res, 500, { ok: false, error: '扫描失败：' + String((e && e.message) || e) })
        return true
      }
      const list = (scan && Array.isArray(scan.sessions)) ? scan.sessions : []
      // 只把「有过长推理」的列出来 —— longTurns=0 的会话判据算不出来，列出来是噪音。
      const rows = list.filter((x) => x && x.longTurns > 0).map((x) => ({
        sessionId: x.sessionId,
        level: x.level,
        median: x.median,
        window: x.window || [],
        longTurns: x.longTurns,
        totalTurns: x.totalTurns,
        ageMinutes: x.ageMinutes,
      }))
      const out = {
        ok: true,
        at: new Date().toISOString(),
        activeMinutes: 180,
        scanned: list.length,
        judged: rows.length,
        byLevel: (scan && scan.byLevel) || {},
        sessions: rows,
        // purgedSeqs 是 Map<sessionId, Set<seq>> —— 摊平成数组给前端
        purged: (() => {
          const flat = []
          for (const [sid, set] of purgedSeqs) for (const seq of set) flat.push({ sessionId: sid, seq })
          return flat.slice(-80).reverse()
        })(),
        purgedCount: (() => { let n = 0; for (const set of purgedSeqs.values()) n += set.size; return n })(),
        // ★ 阈值一起发出去 —— 面板要画出「离红线还有多远」，不能让前端猜。
        thresholds: { watch: 0.25, warn: 0.15, intervene: 0.10 },
        ms: Date.now() - t0,
      }
      log('[huanqi/panel] ' + rows.length + '/' + list.length + ' 可判 · ' + out.ms + 'ms')
      sendJson(res, 200, out)
      return true
    }
    if (p === '/api/huanqi/auto') {
      if (!_scanner) { sendJson(res, 503, { ok: false, error: '扫描器没接上' }); return true }
      const ab = await readBody(req)
      const out = await autoHuanqi({ activeMinutes: ab.activeMinutes, dryRun: ab.dryRun, log })
      sendJson(res, out.ok ? 200 : 500, out)
      return true
    }
    // ★ 手动干预：调内嵌 LLM 诊断 + 可选修复
    if (p === '/api/huanqi/intervene') {
      if (!_intervene) { sendJson(res, 503, { ok: false, error: '干预函数没接上' }); return true }
      const ib = await readBody(req)
      const iSid = String((ib && ib.sessionId) || '').trim()
      if (!iSid) { sendJson(res, 400, { ok: false, error: '缺 sessionId' }); return true }
      const dryRun = ib.dryRun !== false   // ★ 默认 true（只诊断）
      const r = await _intervene({ sessionId: iSid, dryRun })
      log('[huanqi/intervene] ' + iSid.slice(0, 20) + ' dryRun=' + dryRun + ' → ' + (r && r.stage))
      sendJson(res, 200, { ok: true, dryRun, ...r })
      return true
    }
    if (p === '/api/huanqi/context/candidates') {
      const u = new URL(req.url, 'http://x')
      const sessionId = String(u.searchParams.get('sessionId') || '').trim()
      if (!sessionId) { sendJson(res, 400, { ok: false, error: '缺 sessionId' }); return true }
      const limit = Number(u.searchParams.get('limit') || 0) || undefined
      const r = await dispatch.candidates({ sessionId, limit })
      // ★ B：过滤掉已经清过的（它们还在日志里，但上下文里已被替换）
      if (r && r.ok && Array.isArray(r.items)) {
        const done = purgedSeqs.get(sessionId) || new Set()
        const before = r.items.length
        r.items = r.items.filter((x) => !done.has(Number(x.seq)))
        r.filteredOut = before - r.items.length
        r.count = r.items.length
      }
      sendJson(res, r && r.ok ? 200 : 400, r)
      return true
    }
    const body = await readBody(req)
    if (!body || typeof body !== 'object') { sendJson(res, 400, { ok: false, error: '请求体不是 JSON' }); return true }
    const sessionId = String(body.sessionId || '').trim()
    const items = Array.isArray(body.items) ? body.items : null
    if (!sessionId) { sendJson(res, 400, { ok: false, error: '缺 sessionId' }); return true }
    if (!items || !items.length) { sendJson(res, 400, { ok: false, error: '缺 items[]' }); return true }
    // ★ 闸①：必须显式确认
    if (body.confirm !== true) {
      sendJson(res, 400, {
        ok: false,
        error: 'purge 是不可逆操作，必须带 confirm:true 才执行',
        willDo: items.length + ' 条',
        hint: '先调 GET /api/huanqi/context/candidates 看候选，确认无误再加 confirm:true',
      })
      return true
    }
    // ★ 闸③：单次上限
    if (items.length > PURGE_GUARD.maxItemsPerCall) {
      sendJson(res, 400, { ok: false, error: '一次最多清 ' + PURGE_GUARD.maxItemsPerCall + ' 条（这次给了 ' + items.length + '）' })
      return true
    }
    // ★ 闸②：频率
    const now = Date.now()
    const allow = purgeAllowed(sessionId, now)
    if (!allow.ok) { sendJson(res, 429, { ok: false, error: allow.why }); return true }
    const r = await dispatch.purge({ sessionId, items })
    if (r && r.ok) {
      purgeRecord(sessionId, now)
      // ★ B：记下清过哪些 seq
      for (const x of (r.purged || [])) markPurged(sessionId, x.seq)
    }
    log('[huanqi/context] purge ' + sessionId.slice(0, 20) + ' → ' + (r && r.ok ? 'ok' : 'fail') + ' ' + JSON.stringify(r && r.ok ? { p: r.purgedCount, f: r.failedCount } : { code: r && r.code }))
    sendJson(res, r && r.ok ? 200 : 400, r)
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String((e && e.message) || e).slice(0, 300) })
  }
  return true
}