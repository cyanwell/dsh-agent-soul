/**
 * ★★★ 这是一个【架构专属组件】，不是通用插件。
 *
 * 它依赖三个东西，缺一个就跑不起来：
 *   ① 一个「事件队列」JSONL（分会话往里写请求）
 *   ② 《墨》账本（用它判断谁是当前主导会话）
 *   ③ 至少一条 live 的主导会话（叫醒目标）
 *
 * DEFAULT_CONFIG 里的路径是作者本机（砚青）的目录约定，**别人要用必须全部改 config**。
 * 改法见同目录 DESIGN.md 与 README。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

export const name = 'dsh-agent-lead-waker'
// ★ 三个都是本机实测存在的服务：agents（叫醒/投递）、webServer（面板读写）、tools（lead 落判定）。
//   少写一个 -> cordis 一直等它 -> apply 永不执行 -> 整包静默失效（这条坑 dsh-yanqing-triad 记过）。
export const inject = ['agents', 'webServer', 'tools']

const TAG = '[yanqing-lead-waker]'

const DEFAULT_CONFIG = {
  eventFile: 'D:/AI/yanqing-soul/30-状态/事件队列.jsonl',
  ledgerFile: 'D:/AI/yanqing-soul/02-墨.jsonl',
  stateFile: 'D:/AI/yanqing-soul/30-状态/lead-waker-已投递.json',
  // ★ 台账（状态机）与下发（下行）—— DESIGN §一 划给本插件的两个写域
  accountFile: 'D:/AI/yanqing-soul/30-状态/lead-waker-台账.json',
  downFile: 'D:/AI/yanqing-soul/30-状态/下发.jsonl',
  pollMs: 30000,
  maxPerPoll: 2,
  maxPerDay: 12,
  quietHours: [2, 7],
  // ★ 叫醒失败后隔多久再试。没有这个间隔，30 秒一 tick 的轮询会在 1.5 分钟内
  //   把 wakeCount 推到 3、当场判 stuck —— 那等于「开机就判死」，stuck 会失去意义。
  wakeRetryMs: 300000,
  staleMs: 30 * 60 * 1000, // ★ 叫醒后一直没判定 → 多久再叫一次（否则台账变成安静的垃圾桶）,
  maxWakeFails: 3,
  // 单次轮询最多投递几条下行指令，避免一口气把几十条怼进同一个会话
  maxDownPerPoll: 3,
}

// 状态机的合法取值。严格校验的理由：台账是给人看的状态，一个拼错的 stage
// 会让这条事件在四个视图里全部消失 —— 消失比报错更坏。
const STAGES = ['pending', 'woken', 'decided', 'done', 'held', 'auditing', 'stuck']
const DECISIONS = ['resume', 'hold', 'audit']
const CHARTERS = ['pass', 'ask', 'block', 'unchecked']

// decision -> 终态。DESIGN 状态图里 decided 是「过路态」：写判定的同一次事务里就穿过它。
// ★ 为什么不在 decided 停留：四视图的判据全读 decision，没有一个视图看 decided；
//   停在 decided 只会让人以为「还有一步没做」，而实际上那一步就是判定本身。
const STAGE_BY_DECISION = { resume: 'done', hold: 'held', audit: 'auditing' }

// ─────────────────────────── 小工具 ───────────────────────────

function readJsonSafe (file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch { return fallback }
}

/** 从《墨》读最后一条 lead 的 by → 会话 id 前缀（如 '3c9267ca'） */
function currentLeadPrefix (ledgerFile) {
  try {
    const lines = readFileSync(ledgerFile, 'utf8').split('\n')
    let last = null
    for (const ln of lines) {
      const s = ln.trim()
      if (!s) continue
      try {
        const o = JSON.parse(s)
        if (o && o.type === 'lead' && o.by) last = o
      } catch { /* 坏行跳过，不让一行毁掉整个读取 */ }
    }
    // ★ 去掉可能的 'session-' 前缀再取 8 位。真实《墨》里 by 是裸 id（如 "3c9267ca"），
    //   但也见过写成完整会话 id 的写法 —— 带前缀时 slice(0,8) 会得到 "session-"，
    //   于是永远匹配不上任何 agent。这一行是那种「看着正常、其实永远叫不醒」的防线。
    return last ? String(last.by).replace(/^session-/, '').slice(0, 8) : null
  } catch { return null }
}

function isQuiet (cfg, now) {
  const [a, b] = cfg.quietHours || []
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  const h = new Date(now).getHours()
  return a <= b ? (h >= a && h < b) : (h >= a || h < b)
}

const eventKey = (e) => String(e.t || '') + '|' + String(e.title || '').slice(0, 60)

/** 队列行 → 台账的四个来源字段。缺的字段一律落空串，不留 undefined */
function mapEvent (e) {
  return {
    key: eventKey(e),
    t: String(e.t || ''),
    title: String(e.title || ''),
    // ★ 事件行里来源字段不统一（有的写 from，有的写 chatId），两个都认
    from: String(e.from || e.chatId || ''),
    tier: String(e.tier || ''),
  }
}

/** 逐字段对齐 DESIGN §二。★ 字段顺序也照抄示例，方便对着文档核 */
function normalizeRecord (raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const stage = STAGES.includes(r.stage) ? r.stage : 'pending'
  const decision = DECISIONS.includes(r.decision) ? r.decision : null
  return {
    key: String(r.key || ''),
    t: String(r.t || ''),
    title: String(r.title || ''),
    from: String(r.from || ''),
    tier: String(r.tier || ''),
    stage,
    wakeCount: Number.isFinite(r.wakeCount) ? Math.max(0, Math.floor(r.wakeCount)) : 0,
    wokenAt: Number.isFinite(r.wokenAt) ? r.wokenAt : null,
    decision,
    // ★★ 关键一行：不合法/缺失一律回落 unchecked，绝不回落 pass（DESIGN §六）
    charter: CHARTERS.includes(r.charter) ? r.charter : 'unchecked',
    charterNote: String(r.charterNote || ''),
    decidedAt: Number.isFinite(r.decidedAt) ? r.decidedAt : null,
    note: String(r.note || ''),
  }
}

const emptyLedger = () => ({ version: 1, updatedAt: new Date().toISOString(), events: [] })

/** 读台账。宽容：文件不存在、坏 JSON、旧版裸数组都能起来，不因一份坏文件停掉叫醒 */
function loadLedger (file) {
  const raw = readJsonSafe(file, null)
  const events = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.events) ? raw.events : [])
  return {
    version: raw && raw.version ? raw.version : 1,
    updatedAt: (raw && raw.updatedAt) || null,
    events: events.map(normalizeRecord).filter((x) => x.key),
  }
}

/**
 * 原子写：先写 .tmp 再 rename。
 * ★ 为什么这样写：台账有两个写者（轮询 tick 与 POST 判定），中途崩掉留半截 JSON
 *   等于把整本账读坏。rename 在同一分区是原子的。
 *
 * ★★ 但 Windows 上 rename 覆盖已存在的目标会偶发 EPERM（杀软扫描、文件句柄未放），
 *   不是每次都成功 —— 实测踩到过。所以留一条回退：直写。
 *   回退的代价是这一次不原子（极小概率留半截）；不回退的代价是台账**长时间停止更新**，
 *   而一个不更新的台账比一次非原子写坏得多（面板会一直显示旧状态，人以为没事）。
 */
function writeAtomic (file, text, onWarn) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  try {
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, file)
    return true
  } catch (e) {
    try {
      writeFileSync(file, text, 'utf8')
      if (onWarn) onWarn('原子写回退成直写（' + String(e && e.code || e) + '）: ' + file)
      return true
    } catch (e2) {
      if (onWarn) onWarn('写不进去: ' + String(e2 && e2.message || e2))
      return false
    }
  }
}

/** 写台账。updatedAt 由写者负责刷新（它是「这份账最后动过」的时间，不是泛用的时间戳） */
function saveLedger (file, ledger, onWarn) {
  ledger.updatedAt = new Date().toISOString()
  return writeAtomic(file, JSON.stringify(ledger, null, 2) + '\n', onWarn)
}

/**
 * 写一次判定。纯函数（就地改 ledger.events 里那一条），便于自测。
 * ★ charter 不传就保留原值 —— 不是「默认 pass」，而是「判定者这次没表态，维持 unchecked」。
 */
function applyDecision (ledger, key, patch) {
  const ev = ledger.events.find((x) => x.key === key)
  if (!ev) return { ok: false, err: '台账里没有这条 key' }
  const decision = String((patch && patch.decision) || '')
  if (!DECISIONS.includes(decision)) {
    return { ok: false, err: 'decision 只能是 resume / hold / audit' }
  }
  const charterRaw = patch && patch.charter
  const charter = (charterRaw === undefined || charterRaw === null || charterRaw === '')
    ? ev.charter
    : String(charterRaw)
  if (!CHARTERS.includes(charter)) {
    return { ok: false, err: 'charter 只能是 pass / ask / block / unchecked' }
  }
  ev.decision = decision
  ev.charter = charter
  if (patch.charterNote !== undefined && patch.charterNote !== null) {
    ev.charterNote = String(patch.charterNote).slice(0, 300)
  }
  if (patch.note !== undefined && patch.note !== null) {
    ev.note = String(patch.note).slice(0, 600)
  }
  ev.decidedAt = Date.now()
  ev.stage = STAGE_BY_DECISION[decision]
  return { ok: true, event: ev }
}

/**
 * 四类视图（DESIGN §三）。一条事件可以同时出现在两个视图里 ——
 * 「你已执行」问的是「做完了什么」，「你自己决定做的」问的是「谁拍的主意」，
 * 这是两个问题，重叠是设计，不是 bug。
 */
function viewsOf (events) {
  const act = []
  const done = []
  const audit = []
  const auto = []
  for (const ev of events) {
    if (ev.stage === 'woken' && !ev.decision) act.push(ev)
    if (ev.decision === 'resume') done.push(ev)
    // ★ stuck 归进「要审计但没审」：DESIGN 说它「会被审计看见」，
    //   但四视图的判据里没有它的位置 —— 严格按判据它会在界面上彻底消失。
    //   「叫不醒」恰恰是最不该消失的一种，所以这里显式收进来。
    if (ev.decision === 'audit' || ev.charter === 'ask' || ev.stage === 'stuck') audit.push(ev)
    if (ev.decision && ev.charter === 'pass') auto.push(ev)
  }
  // 时间倒序（新的在前）。t 是 ISO 串，直接比字符串即可；空 t 沉底。
  const byT = (a, b) => String(b.t || '').localeCompare(String(a.t || ''))
  act.sort(byT); done.sort(byT); audit.sort(byT); auto.sort(byT)
  return { act, done, audit, auto }
}

function badgeOf (views) {
  // 徽章 = 未处理数。「要你执行」+「要审计但没审」的并集（同一条可能两边都在，去重）。
  const s = new Set()
  for (const ev of views.act) s.add(ev.key)
  for (const ev of views.audit) s.add(ev.key)
  return s.size
}

/** 叫醒文案。放台账 key 进去 —— lead 回写判定时要能对上是哪一条。 */
function buildWakeText (rec, rawEvent) {
  const e = rawEvent || {}
  return [
    '【事件层 · 有人找你】',
    '',
    '标题：' + (rec.title || '(无标题)'),
    '来自：' + (rec.from || '未知渠道') + '　层级：' + (e.level || '?') + '　类型：' + (e.kind || '?'),
    rec.tier === 'act' ? '★ 标了 act —— 分身判断这一条该由主导会话动手。' : '',
    '',
    String(e.facts || '').slice(0, 3000),
    '',
    e.why ? '分身的判断：' + String(e.why).slice(0, 600) : '',
    '',
    '————————————————',
    '这是事件层（lead-relay → lead-waker）转上来的，不是他本人刚说的话。',
    '自己判断要不要接手；做就做完，做完把结论落盘。',
    '台账 key：' + rec.key,
    '（判定：面板右上角点按钮，或用 lead_waker 工具写 decision/charter）',
    e.auditDeadline ? '审计截止：' + e.auditDeadline : '',
  ].filter(Boolean).join('\n')
}

function findAgentById (agents, id) {
  if (!agents || !id) return null
  // ★ 先走 get(id)：DESIGN §四 要求「按 sessionId 精确找 live agent」。
  //   get 也可能返回一个不是 agent 的对象（服务里同 id 的东西），所以两路都验 followup。
  try {
    const a = typeof agents.get === 'function' ? agents.get(id) : null
    if (a && typeof a.followup === 'function') return a
  } catch { /* 掉到下面按 roots 找 */ }
  try {
    const roots = agents.roots() || []
    return roots.find((a) => a && String(a.id || '') === id && typeof a.followup === 'function') || null
  } catch { return null }
}

function findLeadAgent (agents, prefix) {
  if (!agents || !prefix) return null
  try {
    const roots = agents.roots() || []
    return roots.find((a) => String(a && a.id || '').startsWith('session-' + prefix) &&
      typeof a.followup === 'function') || null
  } catch { return null }
}

/**
 * 读下发文件的「新生完整行」。
 * ★ 只消费到最后一个换行：JSONL 是流式追加的，读到半行时 JSON.parse 必失败，
 *   而游标一旦越过它，那半行就再也不会被重试 —— 一条指令就这么静默丢了。
 *   宁可这一轮不处理，也不要丢。
 */
function readDownChunk (file, cursor) {
  if (!existsSync(file)) return { cursor: 0, rows: [] }
  let raw
  try { raw = readFileSync(file, 'utf8') } catch { return { cursor, rows: [] } }
  const end = raw.lastIndexOf('\n')
  const complete = end < 0 ? '' : raw.slice(0, end + 1)
  let cur = Number.isFinite(cursor) && cursor >= 0 ? cursor : 0
  if (cur > complete.length) cur = 0 // 文件被截断重写过，游标作废，从头来
  const chunk = complete.slice(cur)
  const rows = []
  for (const ln of chunk.split('\n')) {
    const s = ln.trim()
    if (!s) continue
    try { rows.push(JSON.parse(s)) } catch { /* 坏行跳过：坏行不该卡死后面的好行 */ }
  }
  return { cursor: complete.length, rows }
}

// ─────────────────────────── 插件主体 ───────────────────────────

export function apply (ctx, config) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) }
  const log = (m) => { try { console.log(TAG + ' ' + m) } catch { } }
  const warn = (m) => { try { console.warn(TAG + ' ' + m) } catch { } }

  // 运行态（非台账）：已投递时间、失败重试节流、下行游标。
  // ★ 为什么不进台账：台账是给人看的状态机（DESIGN 定死了字段）；
  //   重试节流是插件的运行细节，写进去只会让台账多出一堆没人看的字段。
  const state = (() => {
    const s = readJsonSafe(cfg.stateFile, {}) || {}
    return {
      sent: s.sent && typeof s.sent === 'object' ? s.sent : {},
      tries: s.tries && typeof s.tries === 'object' ? s.tries : {},
      dayKey: String(s.dayKey || ''),
      dayCount: Number.isFinite(s.dayCount) ? s.dayCount : 0,
      downCursor: Number.isFinite(s.downCursor) ? s.downCursor : 0,
      downFails: Array.isArray(s.downFails) ? s.downFails.slice(-20) : [],
      lastPollAt: Number.isFinite(s.lastPollAt) ? s.lastPollAt : null,
    }
  })()

  const persistState = () => {
    writeAtomic(cfg.stateFile, JSON.stringify(state, null, 2), warn)
  }

  // ── 上行：收事件 → 入账 → 叫醒 ────────────────────────────────────────

  const tickUp = () => {
    const now = Date.now()
    const dayKey = new Date(now).toISOString().slice(0, 10)
    if (dayKey !== state.dayKey) { state.dayKey = dayKey; state.dayCount = 0 }

    const ledger = loadLedger(cfg.accountFile)
    let changed = false

    // ① 收新事件。★ 只读文件，绝不写队列。
    const rawByKey = new Map()
    if (existsSync(cfg.eventFile)) {
      let raw = ''
      try { raw = readFileSync(cfg.eventFile, 'utf8') } catch { raw = '' }
      for (const ln of raw.split('\n')) {
        const s = ln.trim()
        if (!s) continue
        let e
        try { e = JSON.parse(s) } catch { continue }
        if (!e || e.status !== 'pending') continue
        const r = mapEvent(e)
        if (!r.key) continue
        rawByKey.set(r.key, e)
        if (ledger.events.some((x) => x.key === r.key)) continue

        // ★ 旧 state.sent 里有的 key = 上一版已经叫醒过。把它补成 woken，
        //   否则升级当天会把历史事件全部重新叫醒一遍 —— 那是打扰，不是功能。
        const seen = state.sent[r.key]
        ledger.events.push(normalizeRecord({
          ...r,
          stage: seen ? 'woken' : 'pending',
          wakeCount: seen ? 1 : 0,
          wokenAt: seen || null,
          charter: 'unchecked',
          note: seen ? '历史已投递（沿用旧 state），不重复叫醒' : '',
        }))
        changed = true
      }
    }

    // ② 叫醒。安静时段与日上限只拦「叫醒」，不拦「入账」——
    //    事件先进账，人等醒了再看，不会因为夜里没人叫而丢掉这件事。
    // ★ 2026-11-05 修：原来只捞 pending —— 一旦 woken 就永不再处理，
//   woken + 未判定 的事件会一直挂在台账里没人管（安静的垃圾桶）。
//   现在把「叫醒过但超过 staleMs 还没判定」的也捞回来重叫。
const pendingList = ledger.events.filter((x) => {
  if (x.stage === 'pending') return true
  if (x.stage !== 'woken') return false
  if (x.decision || x.charter !== 'unchecked') return false // 已判定/已过宪章：不再打扰
  return now - Number(x.wokenAt || 0) >= cfg.staleMs
})
    if (pendingList.length) {
      const quiet = isQuiet(cfg, now)
      const overCap = state.dayCount >= cfg.maxPerDay
      const prefix = currentLeadPrefix(cfg.ledgerFile)
      const agents = ctx.get('agents')
      let wokenNow = 0

      for (const rec of pendingList) {
        if (wokenNow >= cfg.maxPerPoll) break
        if (quiet || overCap) break

        const last = Number(state.tries[rec.key] || 0)
        if (now - last < cfg.wakeRetryMs) continue // 节流：失败后等一会儿再试
        state.tries[rec.key] = now
        rec.wakeCount += 1
        changed = true

        const fail = (why) => {
          // ★ wakeCount 同时是「尝试次数」：一旦叫醒成功就转 woken、不再重试，
          //   所以「wakeCount >= 3 且 wokenAt 仍为空」天然等于「连续 3 次失败」。
          //   用一个字段表达两件事 —— 是为了让台账字段与 DESIGN 逐字对得上。
          rec.note = '第 ' + rec.wakeCount + ' 次叫醒失败：' + why
          if (rec.wakeCount >= cfg.maxWakeFails) {
            rec.stage = 'stuck'
            rec.note += ' ⇒ 连续 ' + cfg.maxWakeFails + ' 次失败，判 stuck'
            log('判 stuck：' + String(rec.title || '').slice(0, 40))
          }
        }

        if (!prefix) { fail('《墨》里没有 lead'); continue }
        if (!agents) { fail('agents 服务不可用'); continue }
        const target = findLeadAgent(agents, prefix)
        if (!target) { fail('找不 lead 的 live agent（' + prefix + '）'); continue }

        try {
          target.followup({
            id: 'wake-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
            role: 'user',
            content: [{ type: 'text', text: buildWakeText(rec, rawByKey.get(rec.key)) }],
            source: { kind: 'plugin:dsh-agent-lead-waker' },
          })
          rec.stage = 'woken'
          rec.wokenAt = Date.now()
          rec.note = '已叫醒 lead'
          state.sent[rec.key] = rec.wokenAt
          state.dayCount++
          wokenNow++
          log('已叫醒 lead ← ' + String(rec.title || '').slice(0, 40))
        } catch (e) {
          fail(String(e && e.message || e).slice(0, 160))
        }
      }
    }

    if (changed) {
      saveLedger(cfg.accountFile, ledger, warn)
    }
    return ledger
  }

  // ── 下行：下发.jsonl → 目标会话 followup ────────────────────────────────

  const tickDown = () => {
    const agents = ctx.get('agents')
    if (!agents) return false
    const { cursor, rows } = readDownChunk(cfg.downFile, state.downCursor)
    if (!rows.length) {
      if (cursor !== state.downCursor) { state.downCursor = cursor; return true }
      return false
    }
    let done = 0
    const fails = []
    for (const row of rows) {
      if (done >= cfg.maxDownPerPoll) break
      const rec = row && typeof row === 'object' ? row : {}
      const sid = String(rec.sessionId || rec.to || '')
      if (!sid) {
        // ★ chatId 路由是 DESIGN §四 明确留的口子（交给 aurabot 侧），第一版不做。
        //   但必须留痕，不能静默吞掉 —— 一条指令写下来却没人投递，比报错更坏。
        fails.push({ at: Date.now(), why: '没有 sessionId（chatId 路由未实现，见 DESIGN §四）', title: String(rec.text || '').slice(0, 40) })
        continue
      }
      const target = findAgentById(agents, sid)
      if (!target) {
        fails.push({ at: Date.now(), why: '找不到 live agent：' + sid, title: String(rec.text || '').slice(0, 40) })
        continue
      }
      try {
        target.followup({
          id: 'down-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
          role: 'user',
          content: [{ type: 'text', text: String(rec.text || rec.content || '') }],
          source: { kind: 'plugin:dsh-agent-lead-waker', from: 'lead' },
        })
        done++
        log('已下行 → ' + sid + '｜' + String(rec.text || '').slice(0, 30))
      } catch (e) {
        fails.push({ at: Date.now(), why: 'followup 失败：' + String(e && e.message || e).slice(0, 120), title: String(rec.text || '').slice(0, 40) })
      }
    }
    state.downCursor = cursor
    if (fails.length) {
      state.downFails = state.downFails.concat(fails).slice(-20)
      for (const f of fails) warn('下行失败: ' + f.why)
    }
    return true
  }

  const tick = () => {
    try {
      tickUp()
      tickDown()
      state.lastPollAt = Date.now()
      persistState()
    } catch (e) {
      warn('tick 失败: ' + String(e && e.message || e).slice(0, 200))
    }
  }

  // ── HTTP：面板的读写口 ─────────────────────────────────────────────────

  const sendJson = (res, code, obj) => {
    try {
      res.statusCode = code
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(obj))
    } catch { }
  }

  const snapshot = () => {
    // ★ 每次请求都读盘，不读内存缓存：台账有两个写者（轮询 + 工具/判定），
    //   缓存一份会让面板显示过期状态，而「看不出有没有变」正是这个面板要治的病。
    const led = loadLedger(cfg.accountFile)
    const views = viewsOf(led.events)
    return {
      ok: true,
      version: led.version,
      updatedAt: led.updatedAt,
      counts: {
        total: led.events.length,
        act: views.act.length,
        done: views.done.length,
        audit: views.audit.length,
        auto: views.auto.length,
        stuck: led.events.filter((x) => x.stage === 'stuck').length,
        badge: badgeOf(views),
      },
      views,
      down: {
        fails: state.downFails.slice(-5),
        cursor: state.downCursor,
      },
      runtime: {
        pollMs: cfg.pollMs,
        lastPollAt: state.lastPollAt,
        leadPrefix: currentLeadPrefix(cfg.ledgerFile),
        dayCount: state.dayCount,
        maxPerDay: cfg.maxPerDay,
        quietHours: cfg.quietHours,
        maxWakeFails: cfg.maxWakeFails,
      },
    }
  }

  const webServer = ctx.get('webServer') || (ctx && ctx.webServer)
  if (webServer && typeof webServer.register === 'function') {
    const route = (path, handler) =>
      ctx.effect(() => webServer.register({ kind: 'exact', path, handler }), 'yanqing-lead-waker: ' + path)

    // GET /lead-waker/state —— 面板轮询这一个口，拿全四视图 + 计数 + 运行态
    route('/lead-waker/state', async (_req, res) => {
      try { sendJson(res, 200, snapshot()) } catch (e) {
        sendJson(res, 500, { ok: false, err: String(e && e.message || e).slice(0, 200) })
      }
    })

    // POST /lead-waker/decide —— 写一次判定。只接受白名单取值，不改事件原文
    route('/lead-waker/decide', async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, err: '只接受 POST' })
      let body = ''
      req.on('data', (c) => { body += c; if (body.length > 32768) req.destroy() })
      req.on('end', () => {
        try {
          const patch = JSON.parse(body || '{}')
          const led = loadLedger(cfg.accountFile)
          const r = applyDecision(led, String(patch.key || ''), patch)
          if (!r.ok) return sendJson(res, 400, r)
          if (!saveLedger(cfg.accountFile, led, warn)) {
            return sendJson(res, 500, { ok: false, err: '台账写不进去' })
          }
          const snap = snapshot()
          sendJson(res, 200, { ok: true, event: r.event, counts: snap.counts })
        } catch (e) {
          sendJson(res, 400, { ok: false, err: '判定失败: ' + String(e && e.message || e).slice(0, 200) })
        }
      })
    })
  } else {
    warn('webServer 不可用 —— 面板读写接口没注册（叫醒与台账不受影响）')
  }

  // ── 工具：lead 自己落判定，不必去点面板 ─────────────────────────────────
  // ★ 为什么给工具而不只给面板：DESIGN §一 把「写判定」定为 lead 的职责。
  //   只有面板的话，lead 判完只能靠人去点 —— 那又把决定权推回给了爀曦。
  const tools = ctx.get('tools')
  if (tools && typeof tools.register === 'function') {
    tools.register({
      name: 'lead_waker',
      description:
        '事件层台账（lead-waker）。action=list 看四视图与每条的状态；' +
        'action=decide 写一条判定：decision=resume|hold|audit，charter=pass|ask|block|unchecked。' +
        '★ 只有主导会话该写判定；未表态时 charter 必须留 unchecked（不允许「没写就当通过」）。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'decide', 'wake'], description: 'wake=上报并叫醒主导（任何会话可调）；list 默认；decide 只有主导可调' },
          title: { type: 'string', description: 'wake 必填：一句话说清要主导做什么' },
          facts: { type: 'string', description: 'wake 可选：背景/证据/已查过什么（越具体越好）' },
          from: { type: 'string', description: 'wake 可选：谁在请求（如 group:661580035）' },
          tier: { type: 'string', enum: ['act', 'watch', 'info'], description: 'wake 可选：紧急度，默认 act' },
          key: { type: 'string', description: '台账 key（list 里能拿到）' },
          decision: { type: 'string', enum: ['resume', 'hold', 'audit'], description: '判定' },
          charter: { type: 'string', enum: ['pass', 'ask', 'block', 'unchecked'], description: '宪章结论' },
          charterNote: { type: 'string', description: '宪章结论的一句话说明' },
          note: { type: 'string', description: '附注' },
        },
        required: [],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            text: { type: 'string' },
            counts: { type: 'object', additionalProperties: true },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value && value.text ? value.text : JSON.stringify(value, null, 2) }],
      },
      execute: async (args, ctx) => {
        try {
          const a = args || {}
          const who = (() => {
            try {
              const g = ctx && (ctx.agent || ctx)
              return String((g && (g.id || g.sessionId || g.session)) || '')
            } catch { return '' }
          })()

          // ── wake：任何会话可调。写一条 pending 进台账，然后立刻叫醒主导 ──
          //    ★ 不写事件队列 —— 那是 lead-relay 的 append-only 域。
          //    ★ tickUp 只补充台账里没有的 key，不会重建，所以这条不会被冲掉。
          if (a.action === 'wake') {
            const title = String(a.title || '').trim()
            if (!title) return { ok: false, error: 'wake 需要 title（一句话说清要主导做什么）' }
            const now = Date.now()
            const key = new Date(now).toISOString() + '|wake|' + title.slice(0, 60)
            const led = loadLedger(cfg.accountFile)
            if (led.events.some((x) => x.key === key)) {
              return { ok: true, text: '同一条请求 5 秒内已上报过，未重复入账', counts: snapshot().counts }
            }
            led.events.push(normalizeRecord({
              key, t: new Date(now).toISOString(), title,
              from: String(a.from || who || 'unknown'),
              tier: String(a.tier || 'act'),
              stage: 'pending', wakeCount: 0, wokenAt: null,
              charter: 'unchecked', charterNote: '', decidedAt: null,
              decision: null,
              note: '由分会话上报（wake）' + (a.facts ? '：' + String(a.facts).slice(0, 400) : ''),
              // ★ 回邮地址：谁唤的醒，回信就寄给谁。有了它，主导不需要知道
              //   「群 661580035 对应哪个 session」—— 分身自己留了门牌。
              fromSession: who || String(a.from || ''),
            }))
            writeAtomic(cfg.accountFile, JSON.stringify(led, null, 2), warn)
            try { tickUp() } catch (e) { warn('wake 后立即 tick 失败（下一轮仍会重试）：' + String(e && e.message || e)) }
            const n = snapshot().counts
            return {
              ok: true,
              counts: n,
              text: '已上报并触发叫醒：' + title.slice(0, 50) + '（台账 ' + n.total + ' 条，待处理 ' + n.act + '）',
            }
          }

          // ── decide：只有当前主导能写判定 ──
          //    ★ 上报是无辜的，判定是权力。不用「不给工具」来拦（改 preset 就能绕），
          //      改用身份：本会话是不是《墨》最后一条 lead 的署名者。
          //    ★ 取不到调用者身份时【放行】并在 warn 里留痕 —— 宁可偶尔多信一次，
          //      也不能因为拿不到 ctx 就让主导自己判不了。日志里能看出是谁判的。
          if (a.action === 'decide') {
            let caller = ''
            try {
              const g = ctx && (ctx.agent || ctx)
              caller = String((g && (g.id || g.sessionId || g.session)) || '')
            } catch { caller = '' }
            const lead = currentLeadPrefix(cfg.ledgerFile)
            if (caller && lead && !caller.includes(lead)) {
              return {
                ok: false,
                error: '只有当前主导会话能写判定（本会话 ' + caller.slice(0, 12) +
                  ' 不是《墨》最后一条 lead 的署名者 ' + lead + '）。你可以用 action=wake 上报。',
                counts: snapshot().counts,
              }
            }
            if (!caller) warn('decide 调用者身份取不到（ctx.agent 无 id），已放行；判定 key=' + String(a.key || '').slice(0, 40))
          }

          if ((a.action || 'list') === 'list') {
            const snap = snapshot()
            const fmt = (arr) => arr.map((x) =>
              '- [' + x.stage + '] ' + String(x.title || '(无标题)').slice(0, 70) +
              '｜tier=' + (x.tier || '?') + '｜charter=' + x.charter +
              (x.decision ? '｜decision=' + x.decision : '') +
              '\n  key=' + x.key +
              (x.note ? '\n  note=' + x.note : '')
            ).join('\n') || '（空）'
            return {
              ok: true,
              counts: snap.counts,
              text: [
                '台账 ' + snap.counts.total + ' 条｜要你执行 ' + snap.counts.act +
                  '｜已执行 ' + snap.counts.done + '｜要审计 ' + snap.counts.audit +
                  '｜自主 ' + snap.counts.auto + '｜stuck ' + snap.counts.stuck,
                '',
                '## 要你执行（stage=woken 且没判定）',
                fmt(snap.views.act),
                '',
                '## 要审计但没审（decision=audit / charter=ask / stuck）',
                fmt(snap.views.audit),
              ].join('\n'),
            }
          }
          const led = loadLedger(cfg.accountFile)
          const r = applyDecision(led, String(a.key || ''), a)
          if (!r.ok) return { ok: false, error: r.err, text: '判定没写进去：' + r.err }
          if (!saveLedger(cfg.accountFile, led, warn)) {
            return { ok: false, error: '台账写不进去', text: '判定没落盘' }
          }
          // ── 回信：判定完把结论下发回「唤醒者」那里 ──
          //    ★ 只发给 fromSession 存在的那条（人手从面板点的也走这里，
          //      但面板判定通常没有 fromSession，就不发 —— 不制造噪音）。
          if (r && r.event && r.event.fromSession) {
            try {
              const to = String(r.event.fromSession)
              const line = JSON.stringify({
                sessionId: to,
                from: 'lead-decide',
                text: '【主导已判定】' + String(r.event.title || '').slice(0, 60) +
                  '\n判定：' + String(r.event.decision || '') +
                  '｜宪章：' + String(r.event.charter || '') +
                  (r.event.charterNote ? '（' + r.event.charterNote + '）' : '') +
                  (r.event.note ? '\n附注：' + String(r.event.note).slice(0, 300) : '') +
                  '\n\n★ 接下来是你的活：由你决定要不要、以及怎么在群里回话。主导不下场替你说。',
              }) + '\n'
              appendFileSync(cfg.downFile, line, 'utf8')
              log('已回信 → ' + to + '｜' + String(r.event.title || '').slice(0, 30))
            } catch (e) {
              warn('回信失败（判定仍已写入）：' + String(e && e.message || e))
            }
          }
          return { ok: true, counts: snapshot().counts, text: '已写入判定：' + r.event.key + ' → stage=' + r.event.stage }
        } catch (e) {
          return { ok: false, error: String(e && e.message || e).slice(0, 200), text: '工具失败' }
        }
      },
    })
  } else {
    warn('tools 不可用 —— lead_waker 工具没注册（面板仍可写判定）')
  }

  // ── 轮询循环 ──────────────────────────────────────────────────────────
  ctx.effect(() => {
    // 启动即跑一次：否则第一次 tick 要等满一个 pollMs，重启后的事件会干等
    tick()
    const t = setInterval(tick, cfg.pollMs)
    return () => clearInterval(t)
  }, 'lead-waker: poll loop')

  log('已加载｜轮询 ' + Math.round(cfg.pollMs / 1000) + 's｜每日上限 ' + cfg.maxPerDay +
    '｜安静时段 ' + cfg.quietHours.join('-') + ' 点｜台账 ' + cfg.accountFile)
}
