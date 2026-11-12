// events · engage —— 决定「要不要插话」的三份状态
// ============================================================================
// policy.mjs 的 decideGroupReply 要三样东西，之前一直是空的（于是插话被强制关掉）：
//   interjectTimes   本群最近「插话」的时间戳 —— 用于 cooldownSec / maxPerHour
//   botReplyTimes    本群最近「说话」的时间戳 —— 用于「刚说太多就歇一会儿」的刹车
//   engagedUntil     加入这个话题到什么时候 —— 在这之前可以接着聊，不受冷却限制
//
// ★ 三者的语义分工（照抄 aurabot hub.js 的做法，但写清楚为什么）：
//   · **说话**（botReplyTimes）= 任何一次对外发言，包括被 @ 回答。它管「别刷屏」。
//   · **插话**（interjectTimes）= 只算「没人叫她、她自己开口」。它管「别自嗨」。
//   · **加入话题**（engagedUntil）= 她说过话 = 这一小段时间里她算在聊。它管「别每次都要 @ 才能续话」。
//   混成一个时间戳会同时错两头：用说话算插话 → 正常回答把插话额度吃光；
//   用插话算说话 → 她插一次话就以为「刚说过」，刹车失灵。
//
// ★★ 与 aurabot 的一处不同：这里是**显式对象**而不是闭包里的三张 Map。
//   aurabot 那三张 Map 在 hub.js 的闭包里，外面既看不到也测不了；
//   这里可以被自检直接喂。
//
// ★ 已知限制：**只存内存，core 重启会清零**。
//   后果是重启后「刚说过多少」归零 —— 她可能在重启后立刻多说几句。
//   不做持久化的理由：这三份状态是「最近几分钟」的短时记忆，值得留的时长很短，
//   而频繁写盘（每条消息一次）比这点误差贵得多。
//   真要做持久化，接口已经留好（set/load），加一个 JSON 文件即可。
// ============================================================================

const DEFAULT_MAX_TIMES = 50

/** 一张「群 → 时间戳列表」的表，带长度上限（只留最近的）。 */
function makeTimeTable (maxLen) {
  const m = new Map()
  return {
    get (gid) { return m.get(String(gid)) || [] },
    push (gid, at) {
      const k = String(gid)
      const list = m.get(k) || []
      list.push(Number(at))
      // 只留最近的 maxLen 条：判定只用得到最近几分钟的，留多了是浪费
      while (list.length > maxLen) list.shift()
      m.set(k, list)
    },
    size () { return m.size },
    all () { return [...m.entries()] },
  }
}

/**
 * createEngage({ now, maxTimes })
 *   → { noteReply, noteInterject, joinTopic, leaveTopic, stateOf, view, clear }
 *
 * noteReply      她对外说了一次话（任何原因）
 * noteInterject  她自己插了一次话（同时也算一次说话 —— 内部会同时记 reply）
 * joinTopic      她在这个群里说话了 → 加入话题一小段时间
 * leaveTopic     她选择沉默 → 退出这个话题
 */
export function createEngage (opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
  const maxTimes = Number(opts.maxTimes) > 0 ? Number(opts.maxTimes) : DEFAULT_MAX_TIMES
  // ★ 加入话题保持多久。aurabot 的 ENGAGE_MS 是 5 分钟，这里沿用 ——
  //   太短等于每次都要重新 @，太长会让她一直赖在一个已经冷掉的话题里。
  const engageMs = Number(opts.engageMs) > 0 ? Number(opts.engageMs) : 5 * 60 * 1000

  const interjects = makeTimeTable(maxTimes)
  const replies = makeTimeTable(maxTimes)
  const engagedUntil = new Map() // gid → 毫秒
  // ★★ 2026-11-12：戳一戳要的两份状态。
  //   群戳必须知道「戳谁」，而 <poke/> 只说了「戳一下」——
  //   aurabot 的做法是：戳最近戳她的人，没人戳过就戳这一段最后说话的人。
  //   这两份 Map 就是那个判据的来源。
  const lastPoker = new Map() // gid → 最近戳她的 QQ 号
  const lastSpeaker = new Map() // gid → 这一段最后说话的 QQ 号
  const counters = { replies: 0, interjects: 0, joins: 0, leaves: 0 }

  function noteReply (gid, at) {
    if (gid) { replies.push(gid, at == null ? now() : at); counters.replies += 1 }
  }
  function noteInterject (gid, at) {
    if (!gid) return
    const t = at == null ? now() : at
    interjects.push(gid, t)
    // ★ 插话也是一次说话 —— 不记的话刹车（botReplyTimes）看不见她插的话。
    replies.push(gid, t)
    counters.interjects += 1
    counters.replies += 1
  }
  function joinTopic (gid, untilMs) {
    if (!gid) return 0
    const until = Number(untilMs) > 0 ? Number(untilMs) : now() + engageMs
    engagedUntil.set(String(gid), until)
    counters.joins += 1
    return until
  }
  function leaveTopic (gid) {
    if (!gid) return
    if (engagedUntil.delete(String(gid))) counters.leaves += 1
  }

  /** 记一次「有人戳了她」—— 她戳回去时优先找这个人。 */
  function notePoker (gid, qq) {
    const s = String(qq || '').trim()
    if (!gid || !/^\d{5,12}$/.test(s)) return
    lastPoker.set(String(gid), s)
  }

  /**
   * 从一条 OneBot notice 里认出「谁戳了她」，记下来。
   *
   * ★ 为什么单独抽出来：这段逻辑有五个条件（是不是 notice / 是不是 poke /
   *   有没有群号 / 戳的是不是她 / 是不是她自己戳的），漏一个就会记错人。
   *   内联在 index.mjs 的闭包里就测不了 —— 抽出来能单测。
   *
   * @returns {string} 记下的 QQ 号；没记返回 ''
   */
  function notePokeNotice (n) {
    if (!n || n.notice_type !== 'notify' || n.sub_type !== 'poke') return ''
    const gid = String(n.group_id || '')
    if (!gid) return ''                       // 私聊：戳回去不需要目标
    const self = String(n.self_id || '')
    const target = String(n.target_id || '')
    const from = String(n.user_id || '')
    if (!self || !target) return ''
    if (target !== self) return ''             // 戳的是别人，不是她
    if (!from || from === self) return ''      // 自己戳自己
    if (!/^\d{5,12}$/.test(from)) return ''
    lastPoker.set(gid, from)
    return from
  }

  /** 记一次「这一段最后说话的人」。 */
  function noteSpeaker (gid, qq) {
    const s = String(qq || '').trim()
    if (!gid || !/^\d{5,12}$/.test(s)) return
    lastSpeaker.set(String(gid), s)
  }

  /**
   * 戳一戳的目标：最近戳她的人 → 这一段最后说话的人 → 空。
   * ★ **不猜**：两个都没有就返回空，让调用方放弃（而不是随便戳一个人）。
   */
  function pokeTarget (gid) {
    const k = String(gid || '')
    if (!k) return ''
    return lastPoker.get(k) || lastSpeaker.get(k) || ''
  }

  /** 给 decideGroupReply 用的那一组参数。 */
  function stateOf (gid) {
    const k = String(gid)
    return {
      interjectTimes: interjects.get(k),
      botReplyTimes: replies.get(k),
      engagedUntil: engagedUntil.get(k) || 0,
    }
  }

  return {
    noteReply,
    noteInterject,
    joinTopic,
    leaveTopic,
    notePoker,
    notePokeNotice,
    noteSpeaker,
    pokeTarget,
    stateOf,
    engageMs: () => engageMs,
    clear () { interjects.all().forEach(() => {}); replies.all().forEach(() => {}); engagedUntil.clear() },
    view () {
      return {
        replies: counters.replies,
        interjects: counters.interjects,
        joins: counters.joins,
        leaves: counters.leaves,
        engagedGroups: engagedUntil.size,
        pokers: lastPoker.size,
        speakers: lastSpeaker.size,
        now: now(),
      }
    },
  }
}
