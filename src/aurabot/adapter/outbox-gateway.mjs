// Aurabot · 出站口适配层（OneBot client → 进程内 outbox）
// ============================================================================
// 为什么需要这一层：v4 里「发消息」只有一个出口（src/adapters/outbox.mjs），
// 而 Aurabot 是后来挂进同一个进程的 —— 它自带一份 OneBot client，会**直连网关**。
// 于是同一句「发消息」有两条路，而 v4 只数得着其中一条（/api/outbox 只认识自己那条）。
//
// ★ 这一层改两类动作，共22个名字：3 send/poke + 19 act。
//   已知写动作都按严格名单改道；读动作和未知/custom action仍原样转给真客户端。
//   未知/custom不等于已授权：要迁移必须逐个追加精确action名，不提供通用call(action, params)。
//
// ★ 2026-11-24 第二片为什么放那五个：它们只改**自己**的资料 / 状态，
//   不动群、不动别人、不传文件。凡是能碰到别人群的（set_group_ban / kick /
//   上传 / Qzone）都留在外面 —— 那是下一片的事，不是顺手带上的事。
// ★ 第三片又收进来两个，判据是同一条（只动自己）：set_qq_avatar 换自己的头像，
//   add_custom_face 往自己的收藏表情库里加一张。它们**仍然**和那五个一样走 act()，
//   于是 enabled / dryRun 两道闸照旧在上游（本层不复制判据）。
// ★ 第四片（2026-11-24）再收两个：set_friend_add_request / set_doubt_friends_add_request
//   —— 通过 / 拒绝别人加她为好友的申请。★ 判据在这里必须改写，不能照抄「只动自己」：
//   通过申请就是把另一个人加进自己的好友列表。准确的说法是「**只动机器人自己这一侧**」
//   （自己的资料 / 表情库 / 好友列表），不碰群、不碰第三方、不替任何人拍板。
//   ★ 本层一个字都不改它们的行为：flag 与 approve 原样传（见 actViaOutbox），
//     授权 / 工具可见性 / dryRun / 待处理申请匹配 / 缓存清理全在 contacts 模块里；
//     这一层只做一件事 —— 把这**两个确切的动作名**送进同一个 strict outbox.act。
//     名单外（上传 / Qzone 的发、评论、点赞 / 群管理 / 其它动作）仍旧原样转给真 client。
// ★ 第五片（2026-11-24）再收**一个**：delete_qzone_msg（删掉自己发过的一条说说）。
//   ★ 判据第三次改写，理由写在出站口那一份（src/adapters/outbox.mjs）：
//     它是**撤回**（把公开面收窄回自己这一侧）；Qzone 另外三个（发 / 评论 / 点赞）
//     方向相反，没有迁 —— 这一片只动这一个名字。
//   ★ 本层对它唯一的附加要求是「别动参数」：params 原样交出（actViaOutbox 的同一个对象那条），
//     { tid } 里的字符一个都不许被 trim / 归一 —— 改写它就是删另一条说说。
//   ★ 空 tid / enabled / dryRun 三道闸在上游（src/aurabot/src/features/qzone.js 的 remove()，
//     第 70-88 行）：先 trim、先判非空、再判 enabled / dryRun，到这里时 tid 已经是干净的。
//     这一层**不复制**判据，也不重复 trim。
//   ★ 本地 diary.json 的 deletedAt 由调用方在 outbox **没抛错**之后才写（qzone.js 第 79-88 行）——
//     所以「删失败了但本地记成已删」这件事不会发生。这条由测试钉住，不是靠注释保证。
//
// ★ 第六片（2026-11-24）再收**一对**：upload_group_file / upload_private_file。
//   ★ 判据这一次**不是**前面任何一条 —— 传文件的落点是别人的群 / 别人的私聊，
//     既不是「只动自己这一侧」，也不是「撤回」。唯一成立的理由是**用户明确授权**，
//     并且只授权了这一对：群管理四件与 Qzone 剩三个**一个都没动**。
//   ★ 本层对它们做的事只有一件：把**两个确切的动作名**连同 params 原样送进 outbox.act。
//     上游 hub.js 的 sendFile 一个字都没改，三件闸仍然在它那里（capture / 总开关 / 试运行），
//     另外四条也在它那里（files.enabled / 非空且本机文件要绝对路径 + 存在 + 普通文件 +
//     允许目录 / maxBytes）。这一层**不复制**其中任何一条 —— 复制就是两份判据。
//   ★★ 最容易被顺手破坏的一条：**base64 回落是 hub 的业务决定，不是传输层的事**。
//     hub 在「本机路径那次失败」之后，会自己再调一次 onebot.call，file 换成 'base64://'+内容
//     （只有 ≤ min(30MB, maxMB) 才这么干）。所以一次成功的回落，在这一层看起来
//     **就是两次 outbox.act**，两次都走 transport、都没有重试。这条由测试钉住：
//     谁要是在这一层加了「失败自动重试」或「改走 base64」，那条测试会红。
//   ★ 超时：hub 的 sendFile 每次显式给 FILE_TIMEOUT_MS=120000。这一层把 opts.timeoutMs
//     原样传下去（callTimeoutMs 只判「正数才认」），**不封顶、不改写** —— 120000 进、120000 出。
//
// ★★ 为什么不去改 hub.js：hub 里的三道理（capture / 总开关 / 试运行）本来就架在
//   「客户端」之上 —— 只要客户端是这一层、而不是真 client，那三道闸**自动仍然在上游**。
//   把闸搬到下面的传输层，才是真正会出事的那种「顺手重构」。
//
// ★ 三条不妥协：
//   ① 幂等键**每次调用新生成**（randomUUID）。
//      ★ 这是本文件最容易写错的一条：outbox 的默认键是「内容摘要」，
//      照抄那个默认值，10 分钟内两条**故意一模一样**的话会被静默并成一条。
//      调用方显式给了 opts.idempotencyKey 才用它（重试要沿用同一个键才有意义）。
//   ② 没有出站口就**拒绝**，绝不回落直连网关。
//      回落会让「到底走没走 outbox」变成靠运气，而两种行为在日志里长得一模一样。
//   ③ send_poke 在 outbox 侧**没有幂等** —— 别把它当成和发消息一样安全的重试对象。
// ============================================================================

import { randomUUID } from 'node:crypto'
// ★ 2026-11-24：模式判据只存在于出站口（src/adapters/outbox.mjs）那一处。
//   适配层**引用**它，不是另抄一份 —— 抄一份就是两份判据，而它们只会在某个拼错的配置上分叉。
import { ACT_ACTIONS, EGRESS_MODE_ON, selectOutbox } from '../../adapters/outbox.mjs'

/** 改道走 outbox.send / outbox.poke 的三个动作。别的都不在这里 —— 那是未迁移，不是漏了。 */
export const MIGRATED_ACTIONS = Object.freeze(['send_group_msg', 'send_private_msg', 'send_poke'])

/**
 * 改道走 outbox.act 的十九个白名单动作（**单独一份冻结集合**）。
 *
 * ★ 它和出站口的白名单是**同一份**（ACT_ACTIONS）—— 这里只是给它一个本层的名字，
 *   因为「这一层改道了哪些动作」要能被读出来（gateway.migratedActs / 测试 / 面板）。
 *   ★ 为什么不再抄一遍字面量：两份名单只会某个下午在一个拼错的名字上分叉，
 *     而分叉的表现是「适配层把它送进 act，act 拒绝」——一个看起来像故障的正确拒绝。
 *   ★ 第四片因此**没有**在本文件里加任何名单：往 ACT_ACTIONS 追加两个名字，
 *     这份集合（以及 OUTBOX_PORT / 面板）自动跟上。改动只在一处 —— 这是可核对的那种小。
 *   ★ 第五片照同一条走：只往出站口的 ACT_ACTIONS 末尾追加 delete_qzone_msg，
 *     本文件一个字都没改（除了注释）—— 名单仍然只有一处。
 *   ★ 第六片也照同一条走：upload_group_file / upload_private_file 追加在 ACT_ACTIONS 末尾，
 *     这份集合自动跟上（12 个名字）。**没有第二个地方抄名单**，也没有为上传开第二条通道 ——
 *     它们和前面那些走的是同一个 actViaOutbox / 同一个 strict outbox.act。
 *   ★ 第七片**还是**同一条：set_group_special_title / _send_group_notice 追加在末尾，
 *     本文件除注释外无需维护第二份名单；集合来自 ACT_ACTIONS。**没有群管理特例分支**。
 *     ★ 这里也**没有**「上传特例」：不剥 file、不判大小、不碰 base64 —— 全是上游 hub 的事。
 */
export const MIGRATED_OUTBOX_ACTIONS = Object.freeze(ACT_ACTIONS.slice())

/**
 * 迁移后**每次调用的默认超时**：30000ms。
 *
 * ★★ 为什么必须是这个数（2026-11-24 的迁移回归）：Aurabot 原来的 OneBot client
 *   （src/aurabot/src/onebot/client.js 的 `call(action, params, { timeoutMs = 30000 })`）
 *   默认就是 30s，而 hub 发消息时**不传** opts.timeoutMs。改成走出站口之后，
 *   如果不补这一层，同一句话就落进 outbox 的 8s 默认 —— 慢一点的网关从此开始
 *   「莫名其妙发不出去」，而失败串长得像网络问题。迁移不该改变调用方的默认值。
 *
 * ★ 出站口那边仍然接受 per-call 覆盖（它自己的配置默认留在 8s）——
 *   这一层只负责「OneBot 的默认值」，两边各管一件事，不互相猜。
 * ★ 与 client.js 的一致性由测试钉住（test/aurabot-outbox-gateway.test.mjs）：
 *   谁改了 client 的默认，那条测试会立刻红。
 */
export const ONEBOT_DEFAULT_TIMEOUT_MS = 30000

/** 显式给了正的有限数就照用；否则回到 OneBot 的 30s（**不是**出站口的 8s）。 */
function callTimeoutMs (opts) {
  const n = Number(opts && opts.timeoutMs)
  return Number.isFinite(n) && n > 0 ? n : ONEBOT_DEFAULT_TIMEOUT_MS
}

const SEND_ACTIONS = new Set(['send_group_msg', 'send_private_msg'])
/** 走 outbox.act 的十九个名字。★ 集合来自白名单本身，不是第二次手抄。 */
const ACT_ROUTED = new Set(MIGRATED_OUTBOX_ACTIONS)

/**
 * 未迁移清单（明确写下来，而不是「大家都知道」）—— **已知写动作剩余 0 个**。
 *   ✗ 写动作：没有了。群管理（set_group_ban / set_group_kick）与 Qzone（like_qzone）
 *     在第八片（2026-11-24）迁完 —— 那是最后三个已知的写动作。
 *   ✓ 剩下的只有**读动作**，它们仍然直达 OneBot client（读不算出站，出站口也不该管读）：
 *      get_login_info / get_group_member_list / get_group_member_info / get_group_info /
 *      get_stranger_info / get_msg / get_record / fetch_ptt_text / get_forward_msg /
 *      get_image / get_friend_list / *_msg_history / get_qzone_* …
 * ★★ 「已知写动作剩余 0 个」这句话**必须带「已知」两个字**，别省略：
 *   白名单只覆盖 OneBot **已知**的写动作。未知的 / 自定义的 / 第三方 facade 上加的
 *   动作仍然直达 client，而且**必须**继续直达 —— 想让它改道，只有一条路：
 *   把确切名字追加进 ACT_ACTIONS（逐字相等，前缀像、大小写像都不算数）。
 * ★ 已迁走的不再列在这里（当前 19 个，由 ACT_ACTIONS 提供；
 *   见 MIGRATED_OUTBOX_ACTIONS）：
 *   set_input_status / modify_custom_face / delete_custom_face / set_self_longnick /
 *   set_qq_profile / set_qq_avatar / add_custom_face /
 *   set_friend_add_request / set_doubt_friends_add_request / delete_qzone_msg /
 *   upload_group_file / upload_private_file /
 *   set_group_special_title / _send_group_notice /
 *   send_qzone_msg / comment_qzone /
 *   set_group_ban / set_group_kick / like_qzone。
 * ★ 第四片**故意**只加好友申请那两个名字：
 *   它们一次性处理「待处理的申请」，判据是「只动自己这一侧」；
 *   上传 / 群管理动的是别的群和别人，Qzone 动的是公开动态 —— 判据不同，不顺手带上。
 * ★ 第五片只加 delete_qzone_msg **一个**，把 Qzone 从 4 拆成 1 + 3：
 *   删除是**撤回**（公开面收窄回自己这一侧），发 / 评论 / 点赞是**投出去**。
 *   ★ 同一个 Qzone 里只会迁走这一个名字 —— 另外三个留在这里，是待办不是漏了。
 * ★ 第六片把**上传那一对**迁走（upload_group_file / upload_private_file），
 *   剩下 7 个写动作仍然直达旧 client。
 *   ★ 判据在这里又改了一次：上传既不是「只动自己这一侧」（落点是别人的群 / 别人的私聊），
 *     也不是「撤回」。成立的理由是**用户明确授权，而且只授权了这一对** ——
 *     四件群管理与 Qzone 剩三个**没有**跟着走：它们是待办不是漏了，也不需要在这里再找理由。
 * ★ 第七片把**群头衔 / 群公告**两个名字迁走（set_group_special_title / _send_group_notice），
 *   剩下 5 个写动作仍然直达旧 client。
 *   ★ 判据这一片**没有**再改写：它和第六片是同一条 —— **用户明确授权，而且只授权了这两个名字**。
 *     禁言 / 踢人是**对人下手**，改头衔 / 发公告是**对群的标识下手**；
 *     授权了两个不等于授权了四个，这两件事不能合成一件。
 * ★ 第八片把**最后三个已知写动作**迁走（set_group_ban / set_group_kick / like_qzone），
 *   已知写动作剩余 0 个。判据仍然没有变：**用户明确授权，而且只授权了这三个名字**。
 *   ★ 这一片有一条前几片没有的注记：授权的是**迁移代码路径**，不是「现在就去真禁言 /
 *     真踢人 / 真点赞」。测试里全是假网关、假 client、假 outbox，没有一个真请求离开本机。
 *   ★ 也不做「通用 action 透传」把剩下的（未知 / 自定义 / facade 上的）一把提上来 ——
 *     那等于把白名单这道闸拆了。名单短不是缺陷，**名单之外的一切不存在**才是这道闸。
 */
export const DELEGATED_NOTE = '只有 3 个发送动作（send_group_msg / send_private_msg / send_poke）与 19 个 act 白名单动作（set_input_status / modify_custom_face / delete_custom_face / set_self_longnick / set_qq_profile / set_qq_avatar / add_custom_face / set_friend_add_request / set_doubt_friends_add_request / delete_qzone_msg / upload_group_file / upload_private_file / set_group_special_title / _send_group_notice / send_qzone_msg / comment_qzone / set_group_ban / set_group_kick / like_qzone）走 outbox；**没有剩下的已知写动作**（第八片把最后三个已知写动作也迁完了），但未知的 / 自定义的 / 第三方 facade 上的动作仍在白名单外，逐字相等；没有通用 call(action, params) 通道 —— 白名单外一律拒。'

/** 出站口拒绝时抛这个：形状对齐 OneBotError（action / data），另外带上 code 便于断言。 */
export class OutboxGatewayError extends Error {
  constructor (action, reason, info = {}) {
    const why = String(reason == null ? '' : reason)
    super(action + ' 失败（出站口）：' + why)
    this.name = 'OutboxGatewayError'
    this.action = action
    this.stage = 'outbox'
    this.code = info.code || 'outbox-rejected'
    this.reason = why
    this.retcode = info.retcode == null ? null : info.retcode
    // ★ 不标 transport：重试会真的再发一条（幂等键每次是新的），所以「可以重连再试」是错的结论
    this.transport = false
    this.data = { message: why, code: this.code, retcode: this.retcode }
  }
}

/**
 * 从 aurabot 的 ctx 里取出站口。
 * ★ 两条路都试：ctx.get('outbox') 是 cordis 的 service 语义；ctx.outbox 是 services 摊平的结果。
 *   哪条都没有 → null（= 没接线，调用方必须拒绝，不许回落）。
 */
export function outboxFromCtx (ctx) {
  if (!ctx) return null
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get('outbox') : null
    if (viaGet) return viaGet
  } catch {
    // cordis 里取不到 service 会抛；「取不到」和「没有」在这里是同一件事
  }
  try { return ctx.outbox || null } catch { return null }
}

const text = (v) => String(v == null ? '' : v).trim()

/** aurabot 认的那一个出站模式。★ 与出站口同源（EGRESS_MODE_ON），不是第二次定义。 */
export const AURABOT_OUTBOX_EGRESS_MODE = EGRESS_MODE_ON

/**
 * 核心 → aurabot 的**唯一**一道选择：什么情况下才把出站口交出去。
 *
 * ★ 为什么需要它（2026-11-24 的真缺口）：createOutbox 只判 baseUrl，不判
 *   config.events.egress.mode；而 managed 配置**强制 mode=off 却可能留着 httpUrl**。
 *   于是 core 原来无条件把 outbox 交给 aurabot → 适配层拿得到出站口 → mode=off
 *   照样能发出去。**「关着」和「能发」同时成立，正是最难看的那种状态。**
 *
 * ★ 判据写在这里、而不是散在 core 里：它是「谁配拿到出站口」这一件事的唯一定义，
 *   测试可以只测这个纯函数，不用起 core-entry。
 * ★ 失败方向只有一个：**不认的模式 = 不交出站口 = 适配层拒绝**（outbox-unavailable），
 *   绝不回落到 OneBot client。多认一个拼错的模式，就是把这道闸变成装饰。
 *
 * @param {unknown} mode    config.events.egress.mode
 * @param {object|null} outbox 已经建好的出站口（可能非 null —— 那不代表能交）
 * @returns {object|null} 只有 mode === 'onebot-http' 且 outbox 可用时才返回它
 */
export function selectAurabotOutbox (mode, outbox = null) {
  // ★ 判据本体在 adapters/outbox.mjs 的 selectOutbox：出站口自己拿它挡 send / poke，
  //   这里拿它决定「交不交」。**同一份判据** —— 于是「关着」不可能和「能发」同时成立。
  return selectOutbox(mode, outbox)
}

/** 目标 id 取出来并验证：空 / 带空格的 id 宁可拒，也不要发到一个错的地方。 */
function targetId (action, field, value) {
  const raw = text(value)
  if (!raw) throw new OutboxGatewayError(action, '缺少 ' + field + '（不知道发给谁，不猜）', { code: 'outbox-bad-target' })
  if (/\s/.test(raw)) throw new OutboxGatewayError(action, field + ' 里有空白字符：' + JSON.stringify(raw), { code: 'outbox-bad-target' })
  return raw
}

/**
 * 造一个「看起来就是 OneBot client」的适配器。
 *
 * @param {object} o
 * @param {object} o.client       真的 OneBot client（start/stop/restart/state/call）
 * @param {object} [o.outbox]     进程内出站口（核心的 createOutbox 产物）
 * @param {() => object|null} [o.getOutbox] 晚绑定的取法（出站口可能比 client 晚一步就位）
 * @param {(m:string) => void} [o.log]
 * @param {() => string} [o.newKey] 幂等键生成器（测试注入；默认 randomUUID）
 */
export function createOutboxGateway ({ client, outbox = null, getOutbox = null, log = null, newKey = null } = {}) {
  const say = typeof log === 'function' ? log : () => {}
  const makeKey = typeof newKey === 'function' ? newKey : () => randomUUID()

  function requireClient () {
    if (!client || typeof client.call !== 'function') {
      const error = new Error('OneBot 客户端不可用（适配层拿不到 client）')
      error.code = 'onebot-client-missing'
      error.stage = 'adapter'
      throw error
    }
    return client
  }

  /** 每次现取：出站口是「本进程的那一个」，可能比 client 晚就位。 */
  function resolveOutbox () {
    if (outbox) return outbox
    if (typeof getOutbox === 'function') {
      try {
        const o = getOutbox()
        if (o) return o
      } catch (e) {
        // 读不到就是没有 —— 下面会拒绝，不回落
      }
    }
    return null
  }

  function requireOutbox (action) {
    const ob = resolveOutbox()
    if (!ob || typeof ob.send !== 'function') {
      throw new OutboxGatewayError(action, '没有出站口（v4 未接线 outbox）—— 已拒绝，不回落直连网关', { code: 'outbox-unavailable' })
    }
    return ob
  }

  /** 显式给了就用它；没给就**新生成**（绝不退化成内容摘要）。 */
  function idempotencyKey (opts) {
    const explicit = opts && opts.idempotencyKey != null ? text(opts.idempotencyKey) : ''
    if (explicit) return explicit
    const made = text(makeKey())
    return made || randomUUID()
  }

  const failReason = (res) => {
    const r = res && typeof res === 'object' ? res : {}
    return String(r.error || r.message || ('retcode=' + String(r.retcode == null ? '?' : r.retcode)))
  }

  async function sendViaOutbox (action, params, opts) {
    const ob = requireOutbox(action)
    const group = action === 'send_group_msg'
    const id = targetId(action, group ? 'group_id' : 'user_id', group ? params.group_id : params.user_id)
    const chatId = (group ? 'group:' : 'private:') + id
    const message = params.message
    if (message === undefined || message === null) {
      throw new OutboxGatewayError(action, '缺少 message（不发一条空消息）', { code: 'outbox-empty' })
    }
    const key = idempotencyKey(opts)
    let res
    try {
      // ★ timeoutMs 必须一起传：不传就等于把调用方的时间预算换成出站口的默认值。
      res = await ob.send(chatId, message, { idempotencyKey: key, timeoutMs: callTimeoutMs(opts) })
    } catch (e) {
      // 出站口自己是不抛的（它把失败做成 {ok:false}）；抛了说明是契约外的错，也要变成拒绝
      throw new OutboxGatewayError(action, '出站口抛错：' + String((e && e.message) || e), { code: 'outbox-threw' })
    }
    if (!res || res.ok !== true) {
      throw new OutboxGatewayError(action, failReason(res), { code: 'outbox-rejected', retcode: res && res.retcode })
    }
    if (res.deduped) say('[outbox] ' + action + ' ' + chatId + ' 被幂等命中（message_id=' + String(res.messageId) + '）')
    // OneBot 的形状：data.message_id。上游（hub）就是靠它记 sentIds 的。
    return { message_id: res.messageId == null ? null : res.messageId }
  }

  async function pokeViaOutbox (params, opts) {
    const action = 'send_poke'
    const ob = requireOutbox(action)
    if (!ob || typeof ob.poke !== 'function') {
      throw new OutboxGatewayError(action, '出站口不支持 poke —— 已拒绝，不回落直连网关', { code: 'outbox-unavailable' })
    }
    // 群戳要 group_id；私聊只要 user_id（目标就是对方）
    const inGroup = params.group_id !== undefined && params.group_id !== null && text(params.group_id) !== ''
    const chatId = inGroup
      ? 'group:' + targetId(action, 'group_id', params.group_id)
      : 'private:' + targetId(action, 'user_id', params.user_id)
    let res
    try {
      // ★ 戳一戳也有超时：hub 传的是 10s（hub.js 的 send_poke 那处），以前这一层把它丢了。
      res = await ob.poke(chatId, params.user_id, { timeoutMs: callTimeoutMs(opts) })
    } catch (e) {
      throw new OutboxGatewayError(action, '出站口抛错：' + String((e && e.message) || e), { code: 'outbox-threw' })
    }
    if (!res || res.ok !== true) throw new OutboxGatewayError(action, failReason(res), { code: 'outbox-rejected', retcode: res && res.retcode })
    return { ok: true }
  }

  /**
   * 白名单动作 → outbox.act（资料 / 状态 / 表情库 / 好友申请审批 / Qzone 删除 / 上传文件
   * 都在这一条通道上）。
   *
   * ★ 第五片的 delete_qzone_msg 也走这一条：**没有**为它开第二条通道、也没有特例分支。
   *   失败 → OutboxGatewayError（outbox-rejected / outbox-threw / outbox-unavailable），
   *   **不回落真 client**，与其它十一个名字一模一样。
   *
   * ★ 第六片的上传那一对（upload_group_file / upload_private_file）**还是**这一条 ——
   *   没有第二条通道、没有 if (upload) 分支、没有「上传特例」。
   *   ★ 这对这一层意味着三件具体的事，每一件都有测试钉着：
   *     ① **file 字符串原样**：可能是 'C:\Users\…\a.pdf'，也可能是 'base64://' + 一整个文件，
   *        还可能是 http(s) 网址。这里不 trim、不 resolve、不换形态 —— 改一个字符就是另一个文件；
   *     ② **一次调用 = 一次传输**：失败**不重试**、**不自己改走 base64**。本机路径失败后改走
   *        base64 是 hub.sendFile 的业务决定（它才知道 30MB 上限和这个文件多大）。
   *        所以「一次成功的回落」在这一层看起来**就是两次 outbox.act** —— 这是对的，不是重复发送；
   *     ③ **timeoutMs 原样往下**：hub 每次给 120000（FILE_TIMEOUT_MS）。callTimeoutMs 只判
   *        「正数才认」，不封顶、不改写 —— 大文件不该被 30s 默认判死。
   *
   * ★ params **原样**传下去（同一个对象、同样的字段）：emoji_id / longNick / nickname
   *   的字段名由调用方和网关约定，这一层不重排、不裁剪、不补默认值。
   *   ★ 好友申请那两个名字（set_friend_add_request / set_doubt_friends_add_request）
   *     也走这一条，而且它们的两个字段**一个字符都不许动**：
   *       · `flag` 是网关签发给某一条申请的凭据（来自事件或 get_doubt_friends_add_request 的 uid），
   *         **必须原样** —— 改写它指的就是另一条申请，而失败会长成「网关说 flag 无效」；
   *       · `approve` 是布尔（true 通过 / false 拒绝），不许被压成 0/1 或字符串：
   *         在网关那边 'false' 可能就是「通过」。
   *     ★ 所以这里**不做任何归一**（连 Boolean(...) 都不做）—— 原对象直接交出去。
   *   ★ 第五片的 delete_qzone_msg 同理，而且它是这一条最锋利的一例：
   *     `tid` 是那条说说的门牌。这里**连 trim 都不做**（更不做 String() / Number()）——
   *     上游 qzone.js 已经 trim 过了，再 trim 一次不算「更干净」，只算「多一份判据」。
   *     真要把 ' post-2 ' 与 'post-2' 都当合法，那是上游的事（它已经这么做），不是这一层的事。
   * ★ 没有幂等键：这些动作重复执行是调用方的意图（同一句签名连改两次）。
   *   **换头像 / 加收藏表情 / 审批好友申请同理**：同一张图加两次是「真的再加一张」；
   *   同一条申请连点两次通过是两次请求（第二次由网关判「已处理」）—— 这里**不替它去重**，
   *   因为摘要去重会让「第一次失败了、第二次被静默吞掉」变成可能。**也不自动重试**。
   * ★ 成功时返回 outbox 给的 `data` 原件 —— 与 OneBot client 的 `return j.data` 同形状
   *   （client.js 的 callOnce），调用方接着读 emoji_id 之类不会断。
   *   ★ add_custom_face 就靠这条：stickers.js 拿 data.emoji_id 去写备注、记本地库。
   *   ★ 好友申请**不靠**这条：contacts 模块不看返回值（它只判有没有抛错）。
   *     所以这里既不造 data，也不替它编一个 { ok:true } —— 网关给什么就是什么。
   */
  async function actViaOutbox (action, params, opts) {
    const ob = requireOutbox(action)
    if (typeof ob.act !== 'function') {
      // ★ 旧出站口（没有 act）也是「没有出站口」：拒绝，绝不回落到真 client。
      throw new OutboxGatewayError(action, '出站口不支持 act —— 已拒绝，不回落直连网关', { code: 'outbox-unavailable' })
    }
    const p = params && typeof params === 'object' && !Array.isArray(params) ? params : {}
    let res
    try {
      res = await ob.act(action, p, { timeoutMs: callTimeoutMs(opts) })
    } catch (e) {
      throw new OutboxGatewayError(action, '出站口抛错：' + String((e && e.message) || e), { code: 'outbox-threw' })
    }
    if (!res || res.ok !== true) {
      throw new OutboxGatewayError(action, failReason(res), { code: 'outbox-rejected', retcode: res && res.retcode })
    }
    return res.data
  }

  /**
   * 与真 client 同签名：call(action, params, opts)。
   * 迁移的 22 个动作 → outbox（3 个 send / poke + 19 个 act 白名单）；
   * 其余 → 原样转发（含 opts，比如 timeoutMs / retries）。
   */
  async function call (action, params = {}, opts = {}) {
    const name = text(action)
    const p = params && typeof params === 'object' ? params : {}
    if (SEND_ACTIONS.has(name)) return sendViaOutbox(name, p, opts || {})
    if (name === 'send_poke') return pokeViaOutbox(p, opts || {})
    if (ACT_ROUTED.has(name)) return actViaOutbox(name, p, opts || {})
    return requireClient().call(action, params, opts)
  }

  // ---------- client 的生命周期三件套 + state：原样透传 ----------
  // ★ 不包一层「不许连」之类的东西：要不要连由 host.js 的 watchdog 决定，
  //   这一层只负责「发出去的那一步」。
  function start () { return requireClient().start() }
  function stop () { return requireClient().stop() }
  function restart () { return requireClient().restart() }

  return {
    call,
    start,
    stop,
    restart,
    get state () { return client ? client.state : 'stopped' },
    // 让「这一层到底改道了哪些动作」可读 —— 面板/自检脚本能直接断言，不用猜
    migrated: MIGRATED_ACTIONS.slice(),
    migratedActs: MIGRATED_OUTBOX_ACTIONS.slice(),
    note: DELEGATED_NOTE,
  }
}