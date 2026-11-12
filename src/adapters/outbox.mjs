// adapters · 出站口（core 唯一的「发消息」入口）
// ============================================================================
// ★ 为什么要这一份：进站已经有 core 的家（src/events/），**出站**却散在三个 DSH 插件里 ——
//   hub.js 的 sendSegments、aurabot-modules/lead-relay 的 flushOutbox、core/bridge.js 的 open+send。
//   三条路各自实现一次重试 / 脱敏 / 幂等，代价不是重复劳动，是**v4 数不出发了几条**：
//   面板上只能显示 0，而「0」和「没发过」长得一模一样（本项目为这类死读数付过代价）。
//   收成一个函数之后：发出去、记账、可读 —— 判据与显示在同一处。
//
// ★ 只走 OneBot 标准 HTTP（send_group_msg / send_private_msg）：
//   不引 DSH 的任何私有 API，也不读部署配置 —— baseUrl / token 全部从 opts 来。
//   换网关时坏的地方只在一处；这个文件也因此**不认识「谁在发」**，它只认 chatId。
//
// ★ 四条不妥协：
//   ① token 只进 Authorization 头。不进日志、不进错误串、不进 stats、不进记录
//      （日志与错误串全部过 redact()，记录里正文只留前 40 字）。
//   ② 网络错 / 超时 / 5xx 一律**返回** { ok:false }，绝不抛 ——
//      发不出去不该把调用它的那一轮炸掉（旧路径最疼的就是这一下）。
//   ③ 幂等：同一 (chatId, 内容摘要, 幂等键) 10 分钟内不重发，messageId 沿用第一次的。
//      只有**成功**的那一次会抑制后续 —— 失败必须能被重试，否则一次抖动就永久丢一条。
//   ④ 不自动重试。不是懒：重试和幂等放在一起自相矛盾（窗口内的重试必然被自己抑制）。
//      要等窗口过了再发，那是调用方对业务语义的判断，不该藏在传输层里。
// ============================================================================

import { stableStringify, sha256hex } from '../events/envelope.mjs'

/** 这口只读视图的自述 —— 验收脚本可以断言 writes===0、actions 只有两个。 */
export const OUTBOX_PORT = Object.freeze({
  id: 'outbox-core',
  v: 1,
  routes: ['GET /api/outbox'],
  writes: 0,
  actions: ['send_group_msg', 'send_private_msg'],
  note: '出站只用 OneBot 标准 HTTP 的两个 action；没有通用 call(action, params) 通道。',
})

const DEFAULT_TTL_MS = 10 * 60 * 1000
const DEFAULT_TIMEOUT_MS = 8000
const DEFAULT_RECENT = 20
const PREVIEW_MAX = 40
const MAX_ENTRIES = 500
const ERROR_MAX = 200

/**
 * chatId → 目标。写法与 events 层同一套：group:<gid> / private:<uid>。
 * ★ 用「同一个解析器」而不是各处 indexOf(':')：出站打错类型（群发成私聊）不会报错，
 *   只会静默发到错的地方 —— 那是最难发现的一类错。
 */
export function parseChatId (chatId) {
  const raw = String(chatId == null ? '' : chatId).trim()
  const m = /^(group|private):(\S+)$/.exec(raw)
  if (!m) return null
  const kind = m[1]
  const id = m[2]
  // OneBot v11 两种都收，但数字就用数字 —— 字符串 id 会让部分网关当成员号解析失败
  const targetId = /^\d+$/.test(id) ? Number(id) : id
  return kind === 'group'
    ? { chatId: 'group:' + id, kind, id, action: 'send_group_msg', field: 'group_id', targetId }
    : { chatId: 'private:' + id, kind, id, action: 'send_private_msg', field: 'user_id', targetId }
}

/**
 * 段归一：纯字符串自动包成一条 text 段。
 * 返回 null = 不合法（宁可拒，也不要把半条消息发出去 —— 收方看到的会是另一句话）。
 */
export function normalizeSegments (segments) {
  if (typeof segments === 'string') return segments ? [{ type: 'text', data: { text: segments } }] : []
  if (!Array.isArray(segments)) return null
  const out = []
  for (const s of segments) {
    if (typeof s === 'string') { out.push({ type: 'text', data: { text: s } }); continue }
    if (!s || typeof s !== 'object' || typeof s.type !== 'string' || !s.type) return null
    out.push(s)
  }
  return out
}

/** 内容摘要：段数组的稳定哈希（字段顺序不同不算两条）。 */
export function digestOf (segments) {
  return sha256hex(stableStringify(segments)).slice(0, 40)
}

/** 整条消息的可读文本（非文本段只留类型名 —— base64 不进任何视图）。 */
export function textOf (segments) {
  return segments
    .map((s) => (s && s.type === 'text' && s.data && typeof s.data.text === 'string' ? s.data.text : '[' + (s && s.type) + ']'))
    .join('')
}

/** 记录里的正文预览：只留前 40 字。 */
export function previewOf (segments) {
  return textOf(segments).slice(0, PREVIEW_MAX)
}

/**
 * 脱敏器。判据是「只抹形状，不依赖知道那个 token 是什么」——
 * 所以除了真 token，Bearer / token= 这类形状也一起抹（错误串常常来自网关原文）。
 */
function makeRedactor (secret) {
  const sec = String(secret || '')
  return function redact (text) {
    let out = String(text == null ? '' : text)
    if (sec.length >= 4) out = out.split(sec).join('***')
    out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{4,}/gi, '$1***')
    out = out.replace(/((?:access_token|authorization|token)["']?\s*[:=]\s*["']?)([^\s"',;&]{4,})/gi, '$1***')
    return out
  }
}

/**
 * 造一个出站口。
 *
 * opts: {
 *   baseUrl, token | tokenEnv, env,
 *   timeoutMs = 8000, dedupeTtlMs = 10min, recentMax = 20,
 *   fetchImpl, now, log, register = true,
 * }
 * ★ register：创建即登记为「本进程的出站口」（/api/outbox 读的就是它）。
 *   一个进程只该有一个出站口 —— 后建的覆盖前一个，不是并存；要并存必须显式 register:false。
 */
export function createOutbox (opts = {}) {
  const baseUrl = String(opts.baseUrl || '').trim().replace(/\/+$/, '')
  const env = opts.env || process.env
  const tokenEnv = String(opts.tokenEnv || '').trim()
  const token = String(opts.token != null && opts.token !== ''
    ? opts.token
    : (tokenEnv ? (env[tokenEnv] || '') : '')).trim()

  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS
  const ttlMs = Number(opts.dedupeTtlMs) > 0 ? Number(opts.dedupeTtlMs) : DEFAULT_TTL_MS
  const recentMax = Number(opts.recentMax) > 0 ? Math.floor(Number(opts.recentMax)) : DEFAULT_RECENT
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
  const fetchImpl = typeof opts.fetchImpl === 'function'
    ? opts.fetchImpl
    : (url, init) => globalThis.fetch(url, init)
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const redact = makeRedactor(token)

  const counters = { sent: 0, deduped: 0, failed: 0, lastAt: null }
  const entries = new Map()       // 幂等表：key → { at, ok, retcode, messageId }
  const recent = []               // 最近发送记录（新的在前，已脱敏）
  const inflight = new Set()      // 在途请求的 AbortController（close() 要能掐断）
  let closed = false

  const iso = (ms) => new Date(ms).toISOString()

  /** 记一条：只留计数、动作、结果、脱敏预览。token 与完整正文都不进这里。 */
  function record (row) {
    recent.unshift(row)
    if (recent.length > recentMax) recent.length = recentMax
  }

  /** 失败一律走这里：计数 + 记录 + 返回同一形状，调用方不用分辨是哪一类失败。 */
  function fail (chatId, action, error, extra = {}) {
    const msg = redact(String(error == null ? '' : error)).slice(0, ERROR_MAX)
    counters.failed += 1
    counters.lastAt = iso(now())
    record({ at: counters.lastAt, chatId: String(chatId || ''), action: action || null, ok: false, retcode: extra.retcode == null ? null : extra.retcode, messageId: null, deduped: false, error: msg, preview: extra.preview || '' })
    log('[outbox] 失败 ' + (action || '-') + ' ' + String(chatId || '-') + '：' + msg)
    return { ok: false, retcode: extra.retcode == null ? null : extra.retcode, messageId: null, deduped: false, error: msg }
  }

  /** 幂等表不能无限长：先按 TTL 清，再按最旧清（内存里只留窗口内的键）。 */
  function prune () {
    if (entries.size <= MAX_ENTRIES) return
    const t = now()
    for (const [k, v] of entries) if (t - v.at >= ttlMs) entries.delete(k)
    while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value)
  }

  async function send (chatId, segments, sendOpts = {}) {
    if (closed) return fail(chatId, null, '出站口已关闭（close() 之后不再发）')
    if (!baseUrl) return fail(chatId, null, '未配置 baseUrl —— 出站口没有接线，一条都没发')

    const target = parseChatId(chatId)
    if (!target) return fail(chatId, null, 'chatId 必须是 group:<gid> 或 private:<uid>')
    const segs = normalizeSegments(segments)
    if (segs === null) return fail(target.chatId, target.action, '消息段不合法（要 OneBot 消息段数组，或纯字符串）')
    if (!segs.length) return fail(target.chatId, target.action, '消息为空，不发')

    const digest = digestOf(segs)
    const idem = String(sendOpts.idempotencyKey == null ? '' : sendOpts.idempotencyKey).trim() || digest
    const key = target.chatId + '\u0000' + digest + '\u0000' + idem
    // 表里只会有成功的那几次（失败要能被重试），所以「命中」就等于「上次真的发出去了」
    const hit = entries.get(key)
    if (hit) {
      if (now() - hit.at < ttlMs) {
        counters.deduped += 1
        log('[outbox] 幂等命中 ' + target.action + ' ' + target.chatId + '（10 分钟内同一内容，不重发）')
        return { ok: true, retcode: hit.retcode, messageId: hit.messageId, deduped: true }
      }
      entries.delete(key)
    }

    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [target.field]: target.targetId, message: segs }),
    }
    if (token) init.headers.authorization = 'Bearer ' + token

    // 超时与 close() 共用同一个 abort —— 两套取消机制会让「关掉了还在发」成为可能
    const ctrl = new AbortController()
    inflight.add(ctrl)
    const timer = setTimeout(() => { try { ctrl.abort() } catch { /* 已结束 */ } }, timeoutMs)
    init.signal = ctrl.signal

    let res
    try {
      res = await fetchImpl(baseUrl + '/' + target.action, init)
    } catch (e) {
      // ★ 只报 message 会得到一句没用的 'fetch failed' —— 把 cause 的 code 带上，
      //   否则「连不上」和「被掐断」在日志里一模一样。
      const cause = e && e.cause && (e.cause.code || e.cause.message)
      return fail(target.chatId, target.action, '网络错误：' + String((e && e.message) || e) + (cause ? '（' + String(cause) + '）' : ''), { preview: previewOf(segs) })
    } finally {
      clearTimeout(timer)
      inflight.delete(ctrl)
    }

    let text = ''
    try { text = await res.text() } catch { text = '' }
    let body = null
    try { body = text ? JSON.parse(text) : null } catch { body = null }

    const retcode = body && body.retcode != null && Number.isFinite(Number(body.retcode)) ? Number(body.retcode) : null
    const wording = body && (body.wording || body.msg || body.message) ? String(body.wording || body.msg || body.message) : ''

    if (!res.ok) return fail(target.chatId, target.action, 'HTTP ' + res.status + (wording ? '：' + wording : ''), { retcode, preview: previewOf(segs) })
    if (!body || typeof body !== 'object') return fail(target.chatId, target.action, '网关回的不是 JSON', { retcode, preview: previewOf(segs) })
    if (retcode !== 0) return fail(target.chatId, target.action, 'retcode=' + String(retcode) + (wording ? '：' + wording : ''), { retcode, preview: previewOf(segs) })

    const messageId = body.data && body.data.message_id != null ? body.data.message_id : null
    counters.sent += 1
    counters.lastAt = iso(now())
    entries.set(key, { at: now(), ok: true, retcode: 0, messageId })
    prune()
    record({ at: counters.lastAt, chatId: target.chatId, action: target.action, ok: true, retcode: 0, messageId, deduped: false, len: textOf(segs).length, preview: previewOf(segs) })
    log('[outbox] 已发 ' + target.action + ' ' + target.chatId + ' → message_id=' + String(messageId))
    return { ok: true, retcode: 0, messageId, deduped: false }
  }

  /**
   * 戳一戳。**不是消息** —— OneBot 的 send_poke 是独立动作，不走 message 段。
   *
   * ★ 群戳要 user_id（戳谁）+ group_id；私聊只要 user_id。
   * ★ 目标必须由调用方给（engage.pokeTarget）—— 这里不猜。
   */
  async function poke (chatId, userId) {
    if (closed) return fail(chatId, 'send_poke', '出站口已关闭')
    if (!baseUrl) return fail(chatId, 'send_poke', '未配置 baseUrl')
    const target = parseChatId(chatId)
    if (!target) return fail(chatId, 'send_poke', 'chatId 必须是 group:<gid> 或 private:<uid>')
    const uid = String(userId == null ? '' : userId).trim()
    if (!/^\d{5,12}$/.test(uid)) return fail(target.chatId, 'send_poke', '没有可戳的 user_id（不在猜）')
    const body = target.kind === 'group'
      ? { user_id: Number(uid), group_id: Number(target.targetId) }
      : { user_id: Number(uid) }
    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    if (token) init.headers.authorization = 'Bearer ' + token
    const ctrl = new AbortController()
    const timer = setTimeout(() => { try { ctrl.abort() } catch { /* 已结束 */ } }, timeoutMs)
    init.signal = ctrl.signal
    let res
    try {
      res = await fetchImpl(baseUrl + '/send_poke', init)
    } catch (e) {
      counters.failed += 1
      return fail(target.chatId, 'send_poke', String((e && e.message) || e))
    } finally { clearTimeout(timer) }
    let body2 = null
    try { body2 = await res.json() } catch { body2 = null }
    if (!res.ok) { counters.failed += 1; return fail(target.chatId, 'send_poke', 'HTTP ' + res.status) }
    const ret = body2 && body2.retcode != null ? Number(body2.retcode) : 0
    if (ret !== 0) { counters.failed += 1; return fail(target.chatId, 'send_poke', 'retcode ' + ret) }
    counters.sent += 1
    counters.lastAt = iso(now())
    return { ok: true, retcode: 0, poked: uid }
  }

  function stats () {
    return { sent: counters.sent, deduped: counters.deduped, failed: counters.failed, lastAt: counters.lastAt }
  }

  /** 给 /api/outbox 的形状。★ 只读视图：脱敏预览 + 计数，正文请回网关日志看。 */
  function view (limit) {
    const raw = Number(limit)
    const n = Number.isFinite(raw) && raw > 0 ? Math.min(50, Math.floor(raw)) : DEFAULT_RECENT
    let host = ''
    try { host = new URL(baseUrl).host } catch { host = '' }
    return {
      port: OUTBOX_PORT.id,
      v: OUTBOX_PORT.v,
      mode: closed ? 'closed' : (baseUrl ? 'on' : 'off'),
      configured: Boolean(baseUrl),
      closed,
      host,
      tokenSet: Boolean(token),
      actions: OUTBOX_PORT.actions.slice(),
      stats: stats(),
      dedupe: { ttlMs, entries: entries.size },
      recent: recent.slice(0, n),
      note: '只给计数 + 脱敏预览（前 40 字）；要正文回网关日志看 —— 投影不该比权威更方便',
    }
  }

  function close () {
    if (closed) return
    closed = true
    for (const c of inflight) { try { c.abort() } catch { /* 已结束 */ } }
    inflight.clear()
    // ★ 不注销自己：关掉之后那些计数是本进程**唯一**一份「发过几条」的证据。
    //   抹掉它，面板会在关停那一刻把真话变成「没接线」—— 那不是干净，是撒谎。
    log('[outbox] 已关闭（计数保留，视图标记 closed）')
  }

  const api = { send, poke, stats, close, view, config: Object.freeze({ host: (() => { try { return new URL(baseUrl).host } catch { return '' } })(), timeoutMs, ttlMs, recentMax }) }
  if (opts.register !== false) current = api
  return api
}

// ────────────────────────────────────────────────────────────────────────────
// 本进程的出站口登记处
// ★ 为什么是模块级而不是 createServer 的参数：出站是**进程级**的唯一口，而 server 只是
//   读它的一个视图。挂在 createServer 的参数上会变成「谁创建谁传」，
//   于是第二个入口就有第二份读数 —— 那正是这一份要消掉的东西。
// ────────────────────────────────────────────────────────────────────────────
let current = null

/** 现在这个进程的出站口（没创建过就是 null）。 */
export function currentOutbox () { return current }

/**
 * 拼 GET /api/outbox 的响应。
 * 没创建过出站口时也要给**稳定形状** —— 但明说不是「发过 0 条」：
 * 空的 0 和真的 0 分不清，正是死读数的起点。
 */
export function outboxView (opts = {}) {
  if (current) return current.view(opts.limit)
  return {
    port: OUTBOX_PORT.id,
    v: OUTBOX_PORT.v,
    mode: 'off',
    configured: false,
    closed: false,
    host: '',
    tokenSet: false,
    actions: OUTBOX_PORT.actions.slice(),
    stats: { sent: 0, deduped: 0, failed: 0, lastAt: null },
    dedupe: { ttlMs: DEFAULT_TTL_MS, entries: 0 },
    recent: [],
    reason: '出站口没有创建（core 未创建它）—— 这组 0 是「没接线」，不是「发过 0 条」',
    note: OUTBOX_PORT.note,
  }
}
