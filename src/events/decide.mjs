// 事件 → 「该不该回」的判定
// ============================================================================
// policy.mjs 是从 aurabot 原样搬来的**判断函数**（decideGroupReply），它要的是一组
// 场景参数：被@没有、叫到她名字没有、群里最近在不在聊、当前几点……
//
// 本文的职责就是把 v4 手里那个东西（一条事件 + 帧账）翻译成那组参数。
// 这一层是新写的，因为 v4 的输入形状和 aurabot 不一样：
//   aurabot 那边是「一条刚到的消息 + 内存里的计数器」
//   v4 这边是「一个已关闭的合并窗口 + 一本全量帧账」
//
// ── 三条边界 ────────────────────────────────────────────────
//   · **只判定，不投递**。返回 { reply, mode, reason }，投不投由上层决定。
//   · **不维护跨事件状态**（interjectTimes / botReplyTimes / engagedUntil 全空），
//     所以第一版**强制关掉插话**（interjectChance = 0）。理由写在 policy.mjs 头注里：
//     拿空数组跑冷却检查等于「永远不冷却」，那不是保守，是失控。
//   · **必须真的判断**，不许「拿不准就回」。默认是**不回**，回要有理由。
//
// ── 一个诚实的缺口 ──────────────────────────────────────────
//   repliedToBot（有人引用她的话）**做不到**：要知道哪些消息是她自己发的，
//   得有一份「她说过什么」的记录，v4 现在没有。这里传 false —— 不是「判断为否」，
//   是「没这个信息」，两者不能混。等 botReplyTimes 那份状态建起来才能补。
// ============================================================================

import { policyFor, decideGroupReply, topicRelevance, DEFAULT_GROUP_POLICY } from './policy.mjs'
// ★ 正文提取**必须**和 wake.mjs 用同一个函数。
//   第一版这里自己写了一遍：「图片」变成空、「markdown」没剥链接 ——
//   于是判定看到的文本和真正投出去的内容不是一句东西。判据只写一处。
import { textOfMessage } from './wake.mjs'

/** OneBot 的 at 段里 qq 可能是数字也可能是字符串 —— 统一成字符串比。 */
function qqEq (a, b) {
  const x = String(a == null ? '' : a).trim()
  const y = String(b == null ? '' : b).trim()
  return x !== '' && x === y
}

/** 从一帧里抽出「这条说了什么、有没有点我」 */
function scanFrame (env, fallbackSelfId, extraSelfIds) {
  const p = (env && env.payload && typeof env.payload === 'object') ? env.payload : null
  if (!p) return null
  // ★★ selfId **必须先取出来再用**。第一版把判断写在使用空参数的地方，
  //   于是 at@1901372960 那条明明点了我，mentions 却是 0 —— must 永远不触发。
  // ★★ 2026-11-12：**一组**"自己"，不是一个。
  //   起因：砚青号（3937956599）的 OneBot 只推心跳、不推群消息（SnowLuma/腾讯侧的问题，
  //   关 historySync 也没用）。所以 v4 只能退回听 1901372960 那只耳朵 ——
  //   而群里 @ 的可能是砚青号（3937956599）。
  //   如果只认帧里的 self_id，那种消息会被判成「没被 @」→ 不回。
  //   于是这里接受一组 id：帧里的 self_id 是"收这条消息的那张嘴"，
  //   extraSelfIds 是"还算我自己的其它 id"（两个号都是我）。
  const selfId = String(p.self_id || fallbackSelfId || '')
  const selfSet = new Set([selfId, String(fallbackSelfId || ''), ...(extraSelfIds || []).map(String)].filter(Boolean))
  const segs = Array.isArray(p.message) ? p.message : []
  let mentioned = false
  let repliedTo = ''
  for (const s of segs) {
    if (!s || typeof s !== 'object') continue
    const d = s.data && typeof s.data === 'object' ? s.data : {}
    if (s.type === 'at' && [...selfSet].some((id) => qqEq(d.qq, id))) mentioned = true
    else if (s.type === 'reply') repliedTo = String(d.id || '')
  }
  const sender = (p.sender && typeof p.sender === 'object') ? p.sender : {}
  return {
    userId: String(p.user_id || ''),
    nick: String(sender.card || sender.nickname || p.user_id || ''),
    selfId,
    mentioned,
    repliedTo,
    // 与 wake.mjs 同一份提取：图片给 [图片]、markdown 剥链接、未知段给壳
    text: textOfMessage(p.message).trim(),
    at: Date.parse(env.created_at),
  }
}

/**
 * @param {object} opts
 *   store     —— 要 readAll()（帧账）
 *   policy    —— 全局策略覆盖（透传给 policyFor）
 *   overrides —— 单群覆盖 { '661580035': {...} }
 *   ownerQQ   —— 主人 QQ（可选；给了才能判断「这条是主人说的」）
 *   selfId    —— 机器人自己的 QQ（配置给；帧里的 self_id 优先）
 *   log
 */
export function createEventDecider (opts = {}) {
  const store = opts.store || null
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const ownerQQ = String(opts.ownerQQ || '')
  const fallbackSelfId = String(opts.selfId || '')
  // ★ 一组「还算我自己」的 id（两个 QQ 号都是我）。
  const extraSelfIds = Array.isArray(opts.selfIds) ? opts.selfIds.map(String).filter(Boolean) : []
  const overrides = opts.overrides || null
  // ★ 三份跨事件状态（插话冷却 / 说话刹车 / 加入话题）。没有它们时插话必须关。
  const engage = opts.engage || null
  // ★★ 插话是**显式开关**（opts.interject），默认关。
  //
  //   2026-11-12 之前这里无条件写死 interjectChance: 0，理由是「没有那三份状态，
  //   冷却检查全过 = 每条都插」。那个理由在当时是对的。
  //   现在 engage.mjs 把三份状态建起来了（interjectTimes / botReplyTimes / engagedUntil），
  //   前提条件满足，所以改成「有状态 + 显式允许」才开。
  //
  //   ★ 仍然默认关：插话＝她主动说话，那是对外行为，不该由「配置文件里恰好有这个值」触发。
  //     判据是配置里 events.wake.interject: true —— 一个专门为它存在的键。
  //
  //   ★ 这里踩过一次：第一版写的是 { interjectChance: 0, ...opts.policy } —— 展开在后，
  //     于是配置文件里的 0.15 把 0 盖掉，插话根本没关上。
  //     判据：**"强制" 写在展开之后才算强制**，写在前面只是个默认值。
  const interjectEnabled = Boolean(opts.interject) && Boolean(opts.engage)
  const effectivePolicy = interjectEnabled
    ? { ...(opts.policy || {}) }
    : { ...(opts.policy || {}), interjectChance: 0 }

  const stats = {
    judged: 0,
    must: 0,
    none: 0,
    byReason: {},
    lastAt: null,
    lastError: null,
  }

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
   * 判一条事件要不要回。
   * @param {object} event  coalesce 产出的事件 { id, chatId, frameIds, closedAt, windowMs }
   * @returns {{ ok:true, reply:boolean, mode:string, reason:string, chatId, eventId, text, mentions:number }
   *          | { ok:false, code, why }}
   */
  function decide (event) {
    const e = event && typeof event === 'object' ? event : null
    // ★★ 2026-11-12 20 分钟前实测出来的：私聊被当成群走 decideGroupReply，
    //   于是私聊第一句就判成 "none:插话关着" —— 他跟她说句话，她不理。
    //
    //   根因：decideGroupReply 是**群策略**（名字里就有 Group）。
    //   私聊没有「刷屏」「群里冷清」这些问题，也不需要 @ 才叫得动。
    //
    //   所以私聊在这里**直接判 must**，不进群策略。
    //   （白名单已经在 ingress 那层挡过一遍，能走到这里的私聊就是允许的。）
    if (!e) return { ok: false, code: 'BAD_EVENT', why: '事件不是对象' }
    const chatId = String(e.chatId || '')
    if (!chatId) return { ok: false, code: 'NO_CHAT', why: '事件没有 chatId' }
    const ids = Array.isArray(e.frameIds) ? e.frameIds : []
    if (!ids.length) return { ok: false, code: 'NO_FRAMES', why: '没有 frameIds' }

    const byId = frameIndex()
    if (!byId) return { ok: false, code: 'NO_STORE', why: '没有可读的帧账' }

    // 本事件涉及的那些帧
    const mine = []
    for (const id of ids) {
      const env = byId.get(String(id))
      if (env) mine.push(env)
    }
    if (!mine.length) return { ok: false, code: 'FRAME_MISSING', why: '帧在账里找不到' }

    // ★ 私聊：不走群策略，直接算「她在跟他说话，要回」。
    if (chatId.startsWith('private:')) {
      const scannedAll = mine.map((x) => scanFrame(x, fallbackSelfId, extraSelfIds)).filter(Boolean)
      const textOfPrivate = scannedAll.map((s) => String(s.text || '')).filter(Boolean).join('\n')
      // ★ now 在这里**还不能用** —— 它是下面才定义的局部变量（closedAt/openedAt）。
      //   这里自己算一次，别去动那个共享变量的位置（那会牵动群策略的每一行）。
      const atPrivate = Number.isFinite(e.closedAt) ? e.closedAt : (Number.isFinite(e.openedAt) ? e.openedAt : Date.now())
      stats.judged++
      stats.must++
      stats.byReason['must:私聊'] = (stats.byReason['must:私聊'] || 0) + 1
      stats.lastAt = new Date(atPrivate).toISOString()
      return {
        ok: true,
        reply: true,
        mode: 'must',
        reason: '私聊',
        chatId,
        eventId: String(e.id || ''),
        text: textOfPrivate,
        mentions: scannedAll.reduce((n, s) => n + (Number(s.mentions) || 0), 0),
        relevance: 1,
      }
    }

    const scanned = mine.map((x) => scanFrame(x, fallbackSelfId, extraSelfIds)).filter(Boolean)
    if (!scanned.length) return { ok: false, code: 'NO_PAYLOAD', why: '这些帧没有 payload' }

    // 机器人自己的 QQ：取帧里出现的 self_id（它比配置可靠 —— 是网关自己填的）
    const selfId = scanned.find((s) => s.selfId)?.selfId || fallbackSelfId
    const mentioned = scanned.some((s) => s.mentioned)
    const fromOwner = ownerQQ ? scanned.some((s) => qqEq(s.userId, ownerQQ)) : false
    const text = scanned.map((s) => s.nick + '：' + s.text).join('\n')

    // 本群最近消息的时间（从全账算 —— 这是 coalesce 之外唯一需要「历史」的地方）
    const recentTimes = []
    for (const env of byId.values()) {
      if (String(env.chatId || '') !== chatId) continue
      const t = Date.parse(env.created_at)
      if (Number.isFinite(t)) recentTimes.push(t)
    }

    const groupId = chatId.startsWith('group:') ? chatId.slice(6) : ''
    const policy = { ...policyFor(effectivePolicy, overrides, groupId) }
    const now = Number.isFinite(e.closedAt) ? e.closedAt : (Number.isFinite(e.openedAt) ? e.openedAt : Date.now())
    const hour = new Date(now).getHours()

    // 话题相关度：把本事件里说的内容拿去和她感兴趣的话题比
    const relevance = topicRelevance([text], policy.interests || DEFAULT_GROUP_POLICY.interests, 0)

    let verdict
    try {
      // ★★ 2026-11-12：三份状态从 engage 拿。之前是空数组，
      //   于是 cooldownSec / maxPerHour / 「刚说太多就歇会儿」的刹车**全部失效** ——
      //   那正是当初把插话强制关掉的原因。现在状态有了，开关也能显式打开。
      const engageState = engage ? engage.stateOf(groupId) : { interjectTimes: [], botReplyTimes: [], engagedUntil: 0 }
      verdict = decideGroupReply({
        policy,
        mentioned,
        repliedToBot: false,      // ★ 见头注：做不到，不是判断为否
        fromOwner,
        text,
        now,
        recentTimes,
        interjectTimes: engageState.interjectTimes,
        botReplyTimes: engageState.botReplyTimes,
        engagedUntil: engageState.engagedUntil,
        hour,
        relevance,
      })
    } catch (err) {
      stats.lastError = { code: 'DECIDE_THREW', detail: String((err && err.message) || err) }
      return { ok: false, code: 'DECIDE_THREW', why: 'decideGroupReply 抛异常' }
    }

    stats.judged++
    if (verdict.reply) stats.must++
    else stats.none++
    stats.byReason[verdict.mode + ':' + verdict.reason] = (stats.byReason[verdict.mode + ':' + verdict.reason] || 0) + 1
    stats.lastAt = new Date().toISOString()

    return {
      ok: true,
      reply: Boolean(verdict.reply),
      mode: String(verdict.mode || 'none'),
      reason: String(verdict.reason || ''),
      chatId,
      eventId: String(e.id || ''),
      text,
      mentions: scanned.filter((s) => s.mentioned).length,
      relevance,
      // ★ 2026-11-12：这一段最后说话的 QQ 号。戳一戳的「戳谁」要用它做兜底
      //   （没有「最近戳她的人」时，戳这一段最后说话的人）。
      //   ★ 从后往前取第一个能拿到 userId 的帧 —— 那才是「最后」说的。
      lastUserId: (() => {
        for (let i = scanned.length - 1; i >= 0; i--) {
          const u = String(scanned[i] && scanned[i].userId || '')
          if (/^\d{5,12}$/.test(u)) return u
        }
        return ''
      })(),
    }
  }

  function view () {
    return {
      policyOverrideKeys: Object.keys(opts.policy || {}),
      // ★ 报**真实值**，不是常量 true。第一版这里写死 true，于是「插话有没有关」这个
      //   问题永远得到「关了」—— 那个信号比没有更坏，因为它让人不再去看。
      // ★ 判据从「最终 chance 是不是 0」改成「开关有没有开」——
      //   前者会被配置里的值掩盖（0.15 覆盖 0 那次就是栽在这），
      //   后者只如实回答一个事实：插话这条路通不通。
      interjectForcedOff: !interjectEnabled,
      hasEngage: Boolean(engage),
      hasOwnerQQ: Boolean(ownerQQ),
      ...stats,
    }
  }

  return { decide, view }
}

export default { createEventDecider }
