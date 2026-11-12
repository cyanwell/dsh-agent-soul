// 事件 → 唤醒：把「已经关闭的合并窗口」翻译成「一次投递请求」
// ============================================================================
// 它补的是链路的**最后一段**，也是此前唯一空着的那段：
//
//   帧（envelopes） → 事件（events，只有 frameIds） → **本文** → session/followup
//
// 在它之前，v4 的事件层只写不读：帧进了账、事件算出来了，然后没有然后。
// 事件里**没有正文**（只有 frameIds），所以「叫醒一个会话」需要有人回帧账取原文、
// 拼成「谁说了什么」、再交给调度器。这个文件的全部职责就是这个翻译，且只有这个。
//
// ── 三条边界（写进结构，不靠自觉）──────────────────────────────
//   · **不投递**。它只产出 { ok:true, asks:[{chatId, text, eventId}] }，投递由调用方
//     （web 层 / 将来的事件循环）注入一个 dispatch 去做。这样它能在没有网关、没有 DSH
//     的情况下被单测 —— 也正因为能单测，它才敢说自己对。
//   · **不做策略**。「这条消息该不该回」是群聊策略（aurabot 的 group-policy 那一层）的事，
//     这一层只解决「能不能拼出可以投的正文」。策略接进来之前，白名单默认 **none**。
//   · **正文不进日志、不进 view()、不进返回值以外的地方**。text 只存在于 asks[] 里，
//     交给调用方之后本模块不再持有。
//
// ── 为什么不在这里调 dispatch ──────────────────────────────────
//   因为投递会**真的叫醒一个会话**（花钱、动文件）。让「拼」和「投」分家，
//   就能先跑拼、验拼对了，再打开投递。合成一个函数的话，验拼就等于验投。
// ============================================================================

const MAX_TEXT = 4000          // 单个事件拼出来的正文上限（防一条长消息撑爆一轮）
const MAX_FRAMES = 60          // 一个事件最多带多少帧（超出的截断并记账，不静默丢）

/** 把 markdown 里的 [文字](链接) 剥成 文字；其余原样。 */
function stripMdLinks (s) {
  return String(s).replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim()
}

/** OneBot 的消息段（array 格式）→ 纯文本。未知段保留壳，不假装它是空的。 */
export function textOfMessage (message) {
  if (typeof message === 'string') return message
  if (!Array.isArray(message)) return ''
  const out = []
  for (const s of message) {
    if (!s || typeof s !== 'object') continue
    const d = s.data && typeof s.data === 'object' ? s.data : {}
    if (s.type === 'text') out.push(String(d.text || ''))
    else if (s.type === 'image') out.push('[图片]')
    else if (s.type === 'face') out.push('[表情]')
    else if (s.type === 'record') out.push('[语音]')
    else if (s.type === 'video') out.push('[视频]')
    else if (s.type === 'at') out.push('@' + String(d.qq || ''))
    // ★★ 2026-11-12：markdown 段的**正文在 data.content 里**，不能只给壳。
    //   实测漏过一次：群里有人发 markdown（QQ 的富文本），拼出来是「小绪：@839124348[markdown]」——
    //   会话收到的是一句看不懂的话。markdown 的正文就是 data.content，
    //   里面夹着 [@某某](mqqapi://…) 这种链接，剥成纯文本再用。
    //   ★ 这不是「猜格式」：这是那条消息**本来要显示的内容**，丢了它等于把话吞掉一半。
    else if (s.type === 'markdown') out.push(stripMdLinks(String(d.content || '')))
    else out.push('[' + String(s.type || '?') + ']')
  }
  return out.join('')
}

/** 一条帧（Envelope）→ { nick, text }。取不到正文返回 null（调用方负责计数）。 */
export function lineOfFrame (env) {
  if (!env || typeof env !== 'object') return null
  const p = env.payload && typeof env.payload === 'object' ? env.payload : null
  if (!p) return null
  const sender = p.sender && typeof p.sender === 'object' ? p.sender : {}
  const nick = String(sender.card || sender.nickname || p.user_id || '').trim()
  const raw = typeof p.raw_message === 'string' ? p.raw_message : ''
  const fromSegs = textOfMessage(p.message)
  const text = (fromSegs || raw || '').trim()
  if (!text) return null
  return { nick: nick || '?', text }
}

/**
 * 把一条已关闭事件 + 帧账 → 一次投递请求。
 *
 * @param {object} event  coalesce 产出的事件 { id, chatId, frameIds, openedAt, closedAt, windowMs, rule }
 * @param {Map}    byId   帧账索引：event_id → Envelope（由 createEventWaker 建）
 * @param {object} opts   { allow, maxChars }
 * @returns {{ ok:true, chatId, text, eventId, frames } | { ok:false, code, why }}
 */
export function composeWake (event, byId, opts = {}) {
  const e = event && typeof event === 'object' ? event : null
  if (!e) return { ok: false, code: 'BAD_EVENT', why: '事件不是对象' }
  const chatId = String(e.chatId || '')
  if (!chatId) return { ok: false, code: 'NO_CHAT', why: '事件没有 chatId' }
  const ids = Array.isArray(e.frameIds) ? e.frameIds : []
  if (!ids.length) return { ok: false, code: 'NO_FRAMES', why: '事件里没有 frameIds（不可能在正常路径出现）' }

  const allow = opts.allow || { all: false, chats: [] }
  const allowAll = Boolean(allow.all)
  const allowSet = new Set((Array.isArray(allow.chats) ? allow.chats : []).map(String))
  if (!allowAll && !allowSet.has(chatId)) {
    return { ok: false, code: 'NOT_ALLOWED', why: '这个会话不在唤醒白名单里（wake.allow）' }
  }

  const maxChars = Number.isFinite(opts.maxChars) && opts.maxChars > 0 ? Math.floor(opts.maxChars) : MAX_TEXT
  const lines = []
  let missing = 0
  let noText = 0
  const usedIds = []
  const capped = ids.slice(0, MAX_FRAMES)
  for (const id of capped) {
    const env = byId.get(String(id))
    if (!env) { missing++; continue }
    const ln = lineOfFrame(env)
    if (!ln) { noText++; continue }
    lines.push(ln.nick + '：' + ln.text)
    usedIds.push(String(id))
  }
  if (missing) return { ok: false, code: 'FRAME_MISSING', why: missing + ' 帧在账里找不到' }
  if (!lines.length) return { ok: false, code: 'NO_TEXT', why: '这些帧里没有可用正文（只有图片/表情之类）' }

  let text = lines.join('\n')
  if (text.length > maxChars) text = text.slice(0, maxChars) + '…（截断）'

  return {
    ok: true,
    chatId,
    text,
    eventId: String(e.id || ''),
    frames: usedIds.length,
    truncated: ids.length > capped.length || text.endsWith('…（截断）'),
    windowMs: Number(e.windowMs) || 0,
  }
}

/**
 * 造一个唤醒器。
 *
 * opts.store   —— 要 readAll()（帧账）
 * opts.allow   —— 白名单 { all, chats }；**默认 none**
 * opts.now     —— 可注入时间
 * opts.maxChars
 * opts.log     —— 一行一次，**不含正文**
 */
export function createEventWaker (opts = {}) {
  const store = opts.store || null
  const allow = opts.allow || { all: false, chats: [] }
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const maxChars = opts.maxChars

  const stats = {
    attempts: 0,
    ok: 0,
    bytes: 0,              // 累计拼出来的正文字数（不是字节；名字沿用，别把它当内存读数）
    skipped: {},           // code → 次数
    lastAt: null,
    lastCode: null,
    lastError: null,
  }

  function bump (code) { stats.skipped[code] = (stats.skipped[code] || 0) + 1 }

  /** 每次调用都重建索引：帧账是 append-only，重建是精确的（少一个会漂的缓存）。 */
  function frameIndex () {
    if (!store || typeof store.readAll !== 'function') return null
    const rows = store.readAll()
    const m = new Map()
    for (const r of Array.isArray(rows) ? rows : []) {
      if (r && typeof r.event_id === 'string') m.set(r.event_id, r)
    }
    return m
  }

  /**
   * 把一批事件翻成投递请求。**不投递**。
   * @returns {{ ok:true, asks:Array, skipped:Object } | { ok:false, code, why }}
   */
  function compose (events) {
    const list = Array.isArray(events) ? events : [events]
    const byId = frameIndex()
    if (!byId) return { ok: false, code: 'NO_STORE', why: '没有可读的帧账（store.readAll 缺失）' }

    const asks = []
    const skipped = {}
    for (const ev of list) {
      stats.attempts++
      const r = composeWake(ev, byId, { allow, maxChars })
      if (!r.ok) {
        skipped[r.code] = (skipped[r.code] || 0) + 1
        bump(r.code)
        stats.lastCode = r.code
        continue
      }
      asks.push(r)
      stats.ok++
      stats.bytes += r.text.length
    }
    stats.lastAt = new Date().toISOString()
    // ★ 日志只有「拼了几条、跳过几种」，不写正文。
    if (asks.length || Object.keys(skipped).length) {
      log('[wake] 拼出 ' + asks.length + ' 条投递请求' +
        (Object.keys(skipped).length ? '，跳过 ' + JSON.stringify(skipped) : ''))
    }
    return { ok: true, asks, skipped }
  }

  function view () {
    return {
      allowAll: Boolean(allow.all),
      allowChats: (Array.isArray(allow.chats) ? allow.chats : []).map(String),
      maxChars: maxChars || MAX_TEXT,
      ...stats,
    }
  }

  return { compose, view }
}

export default { createEventWaker, composeWake, lineOfFrame, textOfMessage, MAX_TEXT, MAX_FRAMES }
