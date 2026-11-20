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

// 兼容现有启动接线；预览关闭期间，HTTP 不保存也不使用会话目录。
export function setSessionsDir () {}

let _purgedFile = null
const purgedSeqs = new Map()   // sessionId → Set<seq>

// ═══ 巡视运行记录（2026-11-18 加）═══════════════════════════════════════════
// ★ 为什么需要它：在这之前，「巡视跑了但没到档」和「巡视跑了、真清但失败了」
//   在系统里**长得一模一样** —— 两边都只留一行 console.log，进程一重启就没了，
//   而日志里也没有任何可回溯的落点。诊断时我只能靠 huanqi-purged.json 的
//   mtime 反推「六天没动过」，那是猜，不是证据。
// ★ 只追加（jsonl）：多写者环境里改同一个 JSON 文件是万恶之源，而这里
//   可能同时有「自动巡视」和「HTTP 手动触发」两条路在写。
// ★ 写不进去**不许影响巡视本身** —— 但要把失败说出来（存进 out.runLogged）。
let _runsFile = null
export function setHuanqiRunsFile (p) { _runsFile = p }

function appendRun (rec) {
  if (!_runsFile) return { written: false, why: '没接上落盘路径（setHuanqiRunsFile 未调用）' }
  try {
    fs.appendFileSync(_runsFile, JSON.stringify(rec) + '\n', 'utf8')
    return { written: true }
  } catch (e) {
    return { written: false, why: String((e && e.message) || e).slice(0, 160) }
  }
}

/** 读最近 n 条巡视记录（面板用）。★ 读不到就返回空数组 + 原因，不假装「没跑过」。 */
function readRecentRuns (n) {
  const want = Number(n) > 0 ? Number(n) : 20
  if (!_runsFile) return { runs: [], why: '没接上落盘路径' }
  try {
    if (!fs.existsSync(_runsFile)) return { runs: [], why: '还没有巡视记录（文件不存在）' }
    const raw = fs.readFileSync(_runsFile, 'utf8').trim()
    if (!raw) return { runs: [], why: '巡视记录文件是空的' }
    const lines = raw.split('\n')
    const out = []
    for (const line of lines.slice(-want)) {
      try { out.push(JSON.parse(line)) } catch { /* 坏行跳过，别让一行坏掉整块面板 */ }
    }
    return { runs: out.reverse(), why: null, total: lines.length }
  } catch (e) {
    return { runs: [], why: '读巡视记录失败：' + String((e && e.message) || e).slice(0, 120) }
  }
}


// ═══ 上下文成分（2026-11-18 加 · 爀曦：「要展示上下文具体的内容才行」）══════════
// ★ 为什么不是一张占比饼图：占比只能告诉你「多少」，回答不了「是什么」。
//   而换气要判的是「哪一段该动」—— 那必须先看得见内容。
//   所以这里返回的不只是汇总，还有**每一类的具体条目**（seq / 大小 / 内容开头 / 重复组）。
// ★ 重复怎么算：把内容归一化（去空白、去时间戳这类每轮都变的噪声）之后取指纹，
//   同一指纹出现多次就是一个重复组，并给出「重复了多少次、白占多少字符」。
//   这是今天查出来的最大浪费：system-reminder / runtime 快照每轮重注入，
//   逐字重复能到 71~88%，而逐字比对抓不到「时间戳变了一点」的那类。
import fsx from 'node:fs'
import pathx from 'node:path'

/** 归一化：抹掉每轮都会变的东西，让「结构相同」的注入能撞上同一个指纹 */
function normForFp (s) {
  return String(s || '')
    // ★ 2026-11-18 实测补的：运行时块里有「【此刻】2026-11-18 19:44」这种每轮都变的时间，
    //   原来只认 ISO 格式，抓不到它 —— 于是 11 条一模一样的注入被判成 11 个不同指纹，
    //   「重复浪费」恒等于 0。**这是我自己写出来的、会撒谎的仪表。**
    .replace(/【此刻】[^\n]*/g, '【此刻】<T>')
    .replace(/截至\s*\d{1,2}:\d{2}/g, '截至 <T>')
    .replace(/约剩\s*\d+\s*万/g, '约剩 <N> 万')
    .replace(/距上次记下的回合】\s*\d+/g, '距上次记下的回合】<N>')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?Z?/g, '<TS>')
    .replace(/\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}:\d{2}/g, '<TS>')
    .replace(/\d{1,2}:\d{2}:\d{2}/g, '<T>')
    .replace(/seq[=: ]*\d+/gi, 'seq=<N>')
    .replace(/pid\s*\d+/gi, 'pid <N>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<HEX>')
    .replace(/\b\d+(?:\.\d+)?\s*(?:KB|MB|GB|ms|万|条|帧|字|%)\b/g, '<NUM>')
    .replace(/\s+/g, ' ')
    .trim()
}

function hash32 (str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0).toString(36)
}

/**
 * 内容指纹（判「这是不是同一份东西」）。
 * ★★ 2026-11-18 实测纠正：第一版只用「全文 hash」，结果 11 条完全同形的运行时块
 *   被判成 11 个不同指纹 —— 因为末尾的时间戳变了一个字，全文 hash 就全变了。
 *   现在的指纹 = **归一化后的开头 400 字 + 长度分桶**：
 *   开头决定「是不是同一类东西」，长度分桶兜住尾部小漂移。
 *   ★ 这不是精确哈希，是「值得看一眼的相似」—— 判重本来就不该要求逐字相同。
 */
function fpOf (s) {
  const n = normForFp(s)
  const head = n.slice(0, 400)
  const bucket = Math.round(n.length / 50) * 50
  return hash32(head) + ':' + bucket
}

/** 分哪几类 —— 这份口径要和前端、和诊断文档一致，只在这里定义一次 */
const CTX_KINDS = [
  { key: 'reasoning', zh: '推理草稿', why: '每轮回灌，越长越重' },
  { key: 'userInjected', zh: '注入模板', why: '每轮重复注入，清了也会再来' },
  { key: 'userPlain', zh: '你的输入', why: '意图所在，不该动' },
  { key: 'toolResult', zh: '工具结果', why: '换气现在唯一能清的类型' },
  { key: 'toolCall', zh: '工具调用', why: '参数与调用记录' },
  { key: 'assistant', zh: '我的输出', why: '我说过的话' },
  { key: 'other', zh: '其它', why: '事件 / 错误 / 会话边界' },
]

function kindOfFrame (fr) {
  const t = typeof fr.text === 'string' ? fr.text : ''
  const r = typeof fr.reasoning === 'string' ? fr.reasoning : ''
  if (fr.type === 'user') {
    const injected = /<system-reminder>/.test(t) || /Current runtime context/.test(t)
      || /MNEMON RUNTIME MEMORY/.test(t) || /Instructions from:/.test(t)
    return injected ? 'userInjected' : 'userPlain'
  }
  if (fr.type === 'tool_result') return 'toolResult'
  if (fr.type === 'tool_call') return 'toolCall'
  if (fr.type === 'assistant') return r.length > (t.length || 0) ? 'reasoning' : 'assistant'
  return 'other'
}

function textOfFrame (fr) {
  const t = typeof fr.text === 'string' ? fr.text : ''
  const r = typeof fr.reasoning === 'string' ? fr.reasoning : ''
  return (r.length > t.length) ? r : t
}

/**
 * 离线草稿 reader，仅供受信任调用方使用；未做输入授权，不得直接接到 HTTP。
 * @param {string} sessionsDir  data/sessions
 * @param {string} sessionId
 * @param {number} [recentFrames] 只看最近多少帧（默认 400，防慢）
 */
export function readContextComposition (sessionsDir, sessionId, recentFrames) {
  const sid = String(sessionId || '').trim()
  if (!sid) return { ok: false, error: '没有 sessionId' }
  const path = pathx.join(String(sessionsDir || ''), sid, 'frames.jsonl')
  if (!fsx.existsSync(path)) return { ok: false, error: '这个会话没有 frames.jsonl：' + path }
  const want = Number(recentFrames) > 0 ? Number(recentFrames) : 400
  let raw = ''
  try { raw = fsx.readFileSync(path, 'utf8') } catch (e) {
    return { ok: false, error: '读不到：' + String((e && e.message) || e).slice(0, 120) }
  }
  const lines = raw.split('\n')
  const totalFrames = lines.length
  const use = []
  for (let i = lines.length - 1; i >= 0 && use.length < want; i--) {
    const line = lines[i]
    if (!line || !line.trim()) continue
    let fr = null
    try { fr = JSON.parse(line) } catch { continue }
    use.push(fr)
  }
  use.reverse()

  const groups = {}
  for (const k of CTX_KINDS) groups[k.key] = { kind: k.key, zh: k.zh, why: k.why, chars: 0, frames: 0, items: [], fp: {} }
  let totalChars = 0

  for (const fr of use) {
    const kind = kindOfFrame(fr)
    const txt = textOfFrame(fr)
    const n = txt.length
    const g = groups[kind] || groups.other
    g.chars += n
    g.frames += 1
    totalChars += n
    const fp = fpOf(txt)
    // 重复统计
    if (!g.fp[fp]) g.fp[fp] = { fp, count: 0, chars: 0, sampleSeq: fr.seq, preview: txt.slice(0, 90) }
    g.fp[fp].count += 1
    g.fp[fp].chars += n
    // 具体条目：每条都给 seq / 大小 / 内容开头（前端展开就看这个）
    if (g.items.length < 60) {
      g.items.push({
        seq: fr.seq === undefined ? null : fr.seq,
        chars: n,
        fp,
        type: fr.type || '?',
        preview: txt.slice(0, 220).replace(/\s+/g, ' ').trim(),
      })
    }
  }

  const out = []
  for (const k of CTX_KINDS) {
    const g = groups[k.key]
    const fps = Object.values(g.fp)
    const dupGroups = fps.filter((x) => x.count > 1)
      .sort((a, b) => (b.count - 1) * (b.chars / b.count) - (a.count - 1) * (a.chars / a.count))
    const dupChars = dupGroups.reduce((s, x) => s + (x.chars - x.chars / x.count), 0)
    out.push({
      kind: g.kind, zh: g.zh, why: g.why,
      chars: g.chars, frames: g.frames,
      pct: totalChars ? Math.round(g.chars / totalChars * 1000) / 10 : 0,
      // ★ 重复组：同一份内容出现了几次。降序，前 8 组足够看出问题。
      dupGroups: dupGroups.slice(0, 8).map((x) => ({
        count: x.count, charsEach: Math.round(x.chars / x.count),
        wasted: Math.round(x.chars - x.chars / x.count),
        sampleSeq: x.sampleSeq, preview: x.preview,
      })),
      dupChars: Math.round(dupChars),
      items: g.items,
    })
  }

  return {
    ok: true,
    sessionId: sid,
    at: new Date().toISOString(),
    // ★ 一定要说清「这是最近多少帧」—— 不然读者会以为是整个会话，
    //   而这正是今天反复踩的那个坑：数字不带口径就是假数。
    scope: { frames: use.length, totalFrames, recentOnly: use.length < totalFrames },
    totalChars,
    kinds: out,
  }
}

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

/**
 * 把 dispatch.purge 的回执里「真的清成了哪几条」捞出来写进记录文件。
 *
 * ★★ 2026-11-16（架构收敛第 3 批）：原来这里只认 `x.seq`。而 dispatch.purge 的
 *   purged[] 的键是 **`start`**（session-dispatch 把宿主的 purged 原样透传，
 *   宿主回的是 start/end/newSeq）—— 于是这条记录**一条都写不进去**，
 *   candidates 会一直把已经清过的 seq 再列出来，「清过的别再清」那条设计等于空转。
 *   ★ 修法：两种键都认（start 优先，兼容 task B 时期的 seq）；**没有可用 seq 就明说**
 *     不猜 —— 猜出来的 seq 会把没清过的东西标成已清，那是会误导人的。
 * @returns {{marked:number[], skipped:number}} marked / skipped 都是条数
 */
export function markPurgedFromReceipt (sessionId, receipt) {
  const items = (receipt && Array.isArray(receipt.purged)) ? receipt.purged : []
  const marked = []
  let skipped = 0
  for (const x of items) {
    const raw = (x && x.start != null) ? x.start : (x && x.seq)
    const n = Number(raw)
    if (!Number.isFinite(n)) { skipped += 1; continue }
    markPurged(sessionId, n)
    marked.push(n)
  }
  return { marked, skipped }
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
      || p === '/api/huanqi/context/composition'
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
  const cooled = []   // 到档但被冷却挡下 —— 单独一列，不算「动过」
  // ③ 干预（带 cooldown）
  if (_intervene) {
    for (const s of hot.slice(0, 3)) {   // 一次最多 3 个，防止拖太久
      const last = autoLastAt.get(s.sessionId) || 0
      if (Date.now() - last < 10 * 60 * 1000) {
        // ★ 2026-11-18：冷却跳过**不再混进 acted**。
        //   实测踩到：原来的 actedCount 把「被冷却挡下」也算成「动了一个」，
        //   面板上写着「动 1」，实际一次干预都没调 —— 那正是「看起来通了」的形状。
        cooled.push({ sessionId: s.sessionId, level: s.level, why: '10 分钟内干预过' })
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
  // ★ 2026-11-18：先算一次「为什么没动」，返回值和落盘**用同一个值** ——
  //   两处各算一次必然分叉，而分叉的症状是「面板说没动、日志说动了」这种最难查的错。
  const noAction = acted.length > 0
    ? null
    : (hot.length === 0
      ? 'no-hot：没有会话到 warn/intervene 档'
      : (!_intervene ? 'no-actor：到档了但干预器没接上（真故障）'
        : (cooled.length === hot.length
          ? 'cooldown：' + cooled.length + ' 个到档会话全在 10 分钟冷却内'
          : 'unknown：到档了但没动，且不在已知原因里（要查）')))
  const out = {
    ok: true, dryRun,
    activeMinutes,
    scanned: list.length,
    // ★ 2026-11-13：透传「这一轮扫描走的是哪条路」—— file（v4 直读 DSH 目录）或 bridge。
    //   不加这一行，调用方只能靠耗时猜 —— 而猜出来的东西不能当验收证据。
    viaBridge: !!(scanRes && scanRes.viaBridge),
    timings: (scanRes && scanRes.timings) || null,
    byLevel: (scanRes && scanRes.byLevel) || null,
    hot: hot.length,
    actedCount: acted.length,
    acted,
    cooledCount: cooled.length,
    cooled,
    ms: Date.now() - t0,
    note: hot.length === 0 ? '没有到该干预的会话 —— 这是正常结果' : null,
    // ★ 三种「没动」分开说（no-hot / no-actor / cooldown / unknown），
    //   不然「什么都没发生」和「整条链路断了」在事后分不出来。
    noAction,
  }
  // ★ log 由调用方传（原来这里直接用 handleContextApi 闭包里的 log —— 而 autoHuanqi
  //   被抽出来之后就拿不到了，实测报 `log is not defined`。默认 no-op，绝不因为
  //   打日志失败而让巡视本身失败）。
  const say = (ab.log || (() => {}))
  say('[huanqi/auto] 扫 ' + list.length + ' · 热 ' + hot.length + ' · 动 ' + acted.length
    + (cooled.length ? ' · 冷却 ' + cooled.length : '') + ' · ' + out.ms + 'ms')
  // ★★★ 2026-11-18：把这一轮**落盘**。
  //   ★ 关键不是记「动了什么」，是记 **「为什么没动」** ——
  //     没有这一条，「没到档」和「整条链路断了」在事后完全分不出来。
  //   ★ byLevel 直接透传扫描器给的档位分布：它回答「这一轮到底有几个在往红线走」。
  out.runLogged = appendRun({
    at: new Date().toISOString(),
    activeMinutes,
    dryRun,
    scanned: list.length,
    byLevel: out.byLevel || null,
    viaBridge: out.viaBridge,
    hot: hot.length,
    actedCount: acted.length,
    acted,
    cooledCount: cooled.length,
    cooled,
    ms: out.ms,
    // ★ 三种「没动」必须分开说，不能都是一个 silent：
    //   no-hot   = 一个会话都没到 warn/intervene（正常，多数情况是这样）
    //   cooldown = 到档了，但 10 分钟内已经干预过
    //   no-actor = 到档了，但干预器没接上（配置/启动问题 —— 这是真故障）
    noAction,
  })
  return out
}

export async function handleContextApi (req, res, o) {
  let p = ''
  try { p = new URL(req.url, 'http://x').pathname } catch { return false }
  const KNOWN = ['/api/huanqi/panel', '/api/huanqi/context/candidates', '/api/huanqi/context/composition', '/api/huanqi/context/purge', '/api/huanqi/intervene', '/api/huanqi/auto']
  if (!KNOWN.includes(p)) return false

  // 预览草稿未开放：所有 method 共用同一个响应，不解析查询参数或请求体，
  // 也不接触 dispatch 或 reader。接入授权前不得恢复读取。
  if (p === '/api/huanqi/context/composition') {
    sendJson(res, 503, { ok: false, code: 'CONTEXT_PREVIEW_DISABLED', error: '上下文预览未开放' })
    return true
  }

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
        viaBridge: !!(scan && scan.viaBridge),
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
        // ★★★ 2026-11-18：最近 20 次**巡视记录**。
        //   在这之前，面板只说「现在谁在往红线走」，说不出「换气到底有没有在干活」——
        //   而这两个问题的答案是两回事：一个会话都没到她也在跑，跑到档了她可能全失败。
        //   ★ 带上 why（读不到时的原因）：_runsFile 没接上就是没接上，不许显示成「0 次巡视」。
        recentRuns: (() => {
          const r = readRecentRuns(20)
          return { ...r, intervalMinutes: 30 }
        })(),
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
      // ★ B：记下清过哪些 seq（★ 2026-11-16 修：purged[] 的键是 start，不是 seq —— 见 markPurgedFromReceipt）
      const mk = markPurgedFromReceipt(sessionId, r)
      if (mk.skipped) log('[huanqi/context] ' + mk.skipped + ' 条回执没有可用 seq，没记（不猜）')
    }
    log('[huanqi/context] purge ' + sessionId.slice(0, 20) + ' → ' + (r && r.ok ? 'ok' : 'fail') + ' ' + JSON.stringify(r && r.ok ? { p: r.purgedCount, f: r.failedCount } : { code: r && r.code }))
    sendJson(res, r && r.ok ? 200 : 400, r)
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String((e && e.message) || e).slice(0, 300) })
  }
  return true
}