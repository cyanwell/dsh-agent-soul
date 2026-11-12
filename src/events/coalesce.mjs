// 帧 → 事件（聚合层）—— **纯函数**：不读文件、不读时间、不打印
// ============================================================================
// 「帧是事实，事件是解释。」
//
//   · 帧（Envelope）：一条消息一行，append-only，永远不动。
//   · 事件：把「同一段对话里连发的 N 帧」解释成「一次处理」。**可以从帧重算**。
//
// 所以本文件只有三件出口：DEFAULT_RULES / coalesce / eventIdOf。
// 不 import fs、不取当前时间、不写日志 —— 时间由 opts.now 传进来。
// 这样「实时」和「重算」两条路走的是同一段代码、给出同一个结果；
// 一旦这里偷偷拿一次当前时间，两条路就会走出不同的边界。
//
// ★★ 边界口径（全模块只有这一种）：
//    窗口是**左闭右开** [openedAt, deadline)。
//      帧的 at  **严格小于** deadline  → 并入当前事件，并把窗口续到 at + extendMs
//      帧的 at  **大于等于** deadline  → 开新事件
//    即「恰好到期那一毫秒」到的消息算**新事件**，不算在旧事件里。
//    关闭判定用同一个口径：now >= deadline 才算已关闭（now 恰好等于 deadline 算已关）。
//    两者必须同向，否则会出现「事件已经关了，却还有帧进得来」。
//    代码里用 at < deadline（不是 <=），自检 d) 三条 ±1ms 把这个边界钉死。
//
// ★ 已知取舍（写在这里，别当成 bug）：
//   · 不排序。输入必须按 at 非递减（同毫秒允许）。要排自己排 —— 排序会让
//     「重算（先拿全量再排）」和「实时（来一条算一条）」两条路的结果分叉。
//   · 帧缺 id 也算坏帧：没有 id 就派生不出稳定的事件 id，宁可不给事件。
//   · at 只收**毫秒数字**。传 ISO 字符串一律 BAD_FRAME —— 让解析发生在调用方，
//     免得两条路各自解析出不同的毫秒还都自认为对。
// ============================================================================

import { createHash } from 'node:crypto'

/**
 * 默认合并规则（按 chatId 前缀分派，chatId 形如 private:<uid> / group:<gid>）。
 * 数值口径来自 aurabot，但规则本身是**参数**，可以整体覆盖。
 *   firstMs  —— 第一条消息开启窗口的时长
 *   extendMs —— 窗口内又来消息时，把关闭时刻推到 「该消息 at + extendMs」（滑动）
 * default 这一档给「既不是 private: 也不是 group:」的 chatId 兜底，取较保守的短窗口：
 * 合并错了（把两段无关对话并成一次）比合并少了更难挽回。
 */
export const DEFAULT_RULES = Object.freeze({
  private: Object.freeze({ firstMs: 2500, extendMs: 8000 }),
  group: Object.freeze({ firstMs: 5000, extendMs: 15000 }),
  default: Object.freeze({ firstMs: 2500, extendMs: 8000 }),
})

const RULE_KINDS = Object.freeze(['private', 'group', 'default'])

/** chatId → 规则档位。不认识的一律 'default'（不猜、不抛）。 */
export function kindOf (chatId) {
  const s = typeof chatId === 'string' ? chatId : String(chatId == null ? '' : chatId)
  if (s.startsWith('private:')) return 'private'
  if (s.startsWith('group:')) return 'group'
  return 'default'
}

/**
 * 事件 id：由**首帧 id + 帧数**派生，稳定。
 *   同一批帧（顺序不变）→ 永远同一个 id；换一批 → 不同 id。
 * ★ 只取首帧 + 条数，前提是**帧 id 全局唯一**（Envelope 的 event_id 满足）。
 *   若帧 id 会重复（例如两条 ingress 各自从 1 编号），先修帧 id，别在这里加 chatId 打补丁。
 * ★ 规则变了 → 同一个首帧可能并进不同的条数 → id 跟着变。这是对的：
 *   规则换了，事件本身就不是原来那件事了。
 */
export function eventIdOf (frameIds) {
  if (!Array.isArray(frameIds) || frameIds.length === 0) return null
  const first = String(frameIds[0] == null ? '' : frameIds[0])
  if (first === '') return null
  const h = createHash('sha256').update(first + '|' + frameIds.length, 'utf8').digest('hex')
  return 'ev_' + h.slice(0, 16)
}

/** 合并 opts.rules 与 DEFAULT_RULES，并校验数值。配置错返回 BAD_RULES，不抛、不静默回落。 */
function resolveRules (override) {
  const src = override && typeof override === 'object' ? override : {}
  for (const k of Object.keys(src)) {
    if (!RULE_KINDS.includes(k)) {
      return { ok: false, code: 'BAD_RULES', kind: k, field: 'kind', message: '规则键只能是 ' + RULE_KINDS.join(' / ') + '（收到 ' + k + '）：chatId 前缀只认 private: 和 group:，其余一律落 default 档' }
    }
  }
  const kinds = RULE_KINDS
  const out = {}
  for (const kind of kinds) {
    const base = DEFAULT_RULES[kind] || DEFAULT_RULES.default
    const patch = src[kind] && typeof src[kind] === 'object' ? src[kind] : null
    const firstMs = patch && patch.firstMs !== undefined ? patch.firstMs : base.firstMs
    const extendMs = patch && patch.extendMs !== undefined ? patch.extendMs : base.extendMs
    if (typeof firstMs !== 'number' || !Number.isFinite(firstMs) || firstMs <= 0) {
      return { ok: false, code: 'BAD_RULES', kind, field: 'firstMs', message: '规则 ' + kind + '.firstMs 必须是正有限数（收到 ' + JSON.stringify(firstMs) + '）' }
    }
    if (typeof extendMs !== 'number' || !Number.isFinite(extendMs) || extendMs < 0) {
      return { ok: false, code: 'BAD_RULES', kind, field: 'extendMs', message: '规则 ' + kind + '.extendMs 必须是 >=0 的有限数（收到 ' + JSON.stringify(extendMs) + '）' }
    }
    out[kind] = { firstMs, extendMs }
  }
  return { ok: true, rules: out }
}

/**
 * 把帧合并成事件。
 *
 * frames  按 at 非递减排列的数组，每项至少 { id, chatId, at }（at = 毫秒时间戳）。
 *         其余字段一概不看、不假设。
 * opts.now       —— 「现在」的毫秒（由调用方给）。不传 = 当作历史重算，所有事件都算已关闭。
 * opts.closedOnly —— true 时 events 里只放已关闭的事件，未关闭的只出现在 open。
 * opts.rules      —— 覆盖 DEFAULT_RULES，如 { group: { extendMs: 30000 } }；键只认 private/group/default。
 *
 * 返回：
 *   成功 { ok:true, events, open }
 *        events —— 按 openedAt 升序（同 openedAt 按 chatId 排），每条
 *                  { id, chatId, frameIds, openedAt, closedAt, windowMs, rule }
 *                  closedAt === null 表示还没关（只在 closedOnly=false 时出现在 events 里）
 *        open   —— 未关闭事件的数组；没有未关闭的就 null（空输入就是这条）
 *   失败 { ok:false, code:'BAD_FRAME'|'UNSORTED'|'BAD_RULES', ... }，不做任何猜测性修补
 *
 * ★ 字段含义：
 *   closedAt = 窗口到期时刻 = 最后一帧 at + windowMs。**不是**「发现它关了的时刻」。
 *   windowMs = 决定这次关闭的窗口长度：只收到一帧就是 firstMs，收到续窗就是 extendMs。
 *   于是对任何已关闭事件恒有 closedAt === lastAt + windowMs（自检里逐条验）。
 *   rule     = 命中的规则档位名字（'private' / 'group' / 'default' 或自定义键），
 *              不是数值副本 —— 数值看 windowMs 与你传进来的 rules。
 */
export function coalesce (frames, opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {}

  if (!Array.isArray(frames)) {
    return { ok: false, code: 'BAD_FRAME', index: -1, field: 'frames', message: 'frames 必须是数组' }
  }

  // —— 一、逐帧校验（先验字段、再验顺序；先遇到哪个报哪个）——
  let prevAt = -Infinity
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]
    if (!f || typeof f !== 'object') {
      return { ok: false, code: 'BAD_FRAME', index: i, field: 'frame', message: '第 ' + i + ' 帧不是对象' }
    }
    if (typeof f.chatId !== 'string' || f.chatId === '') {
      return { ok: false, code: 'BAD_FRAME', index: i, field: 'chatId', message: '第 ' + i + ' 帧没有 chatId（空串也算没有）' }
    }
    if (!Number.isFinite(f.at)) {
      return { ok: false, code: 'BAD_FRAME', index: i, field: 'at', message: '第 ' + i + ' 帧的 at 不是有限数字（' + JSON.stringify(f.at) + '）；毫秒时间戳，ISO 字符串请先转' }
    }
    if (typeof f.id !== 'string' || f.id === '') {
      return { ok: false, code: 'BAD_FRAME', index: i, field: 'id', message: '第 ' + i + ' 帧没有 id（空串也算没有）' }
    }
    if (f.at < prevAt) {
      return { ok: false, code: 'UNSORTED', index: i, prevIndex: i - 1, prevAt, at: f.at, message: '第 ' + i + ' 帧的 at(' + f.at + ') 小于第 ' + (i - 1) + ' 帧的 at(' + prevAt + ')：输入必须按 at 非递减，本函数不替你排序' }
    }
    prevAt = f.at
  }

  const rr = resolveRules(o.rules)
  if (!rr.ok) return rr
  const rules = rr.rules

  const hasNow = Number.isFinite(o.now)
  const now = hasNow ? o.now : Infinity
  const closedOnly = Boolean(o.closedOnly)

  // —— 二、按 chatId 各自维护一个「当前窗口」：不同会话互不串味 ——
  const cur = new Map()   // chatId → { chatId, rule, openedAt, lastAt, deadline, windowMs, frameIds }
  const done = []         // 已落定的候选事件（内部对象，最后再排序/裁剪）

  const openWindow = (f, rule) => {
    const r = rules[rule] || rules.default
    return {
      chatId: f.chatId,
      rule,
      openedAt: f.at,
      lastAt: f.at,
      deadline: f.at + r.firstMs,   // 左闭右开：[at, at+firstMs)
      windowMs: r.firstMs,
      frameIds: [f.id],
    }
  }

  const settle = (b) => {
    done.push({
      id: eventIdOf(b.frameIds),
      chatId: b.chatId,
      frameIds: b.frameIds.slice(),
      openedAt: b.openedAt,
      closedAt: b.deadline <= now ? b.deadline : null,
      windowMs: b.windowMs,
      rule: b.rule,
    })
  }

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]
    const b = cur.get(f.chatId)
    if (!b) {
      cur.set(f.chatId, openWindow(f, kindOf(f.chatId)))
      continue
    }
    if (f.at < b.deadline) {        // ★ 严格小于：恰好等于 deadline 的那帧不进这个事件
      const r = rules[b.rule] || rules.default
      b.frameIds.push(f.id)
      b.lastAt = f.at
      b.deadline = f.at + r.extendMs  // 续窗：从**这一帧**重新起算（不是从上一帧累加）
      b.windowMs = r.extendMs
      continue
    }
    // 窗口已过期：先关旧事件，再开新事件（同一帧同时完成这两件事）
    settle(b)
    cur.set(f.chatId, openWindow(f, kindOf(f.chatId)))
  }
  for (const b of cur.values()) settle(b)

  // —— 三、排序 + 裁剪。排序键带 chatId，保证同一毫秒开两个事件时顺序也不漂 ——
  done.sort((a, b) => (a.openedAt - b.openedAt) ||
    (a.chatId < b.chatId ? -1 : a.chatId > b.chatId ? 1 :
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)))

  const open = done.filter((e) => e.closedAt === null)
  const events = closedOnly ? done.filter((e) => e.closedAt !== null) : done
  return { ok: true, events, open: open.length === 0 ? null : open }
}
