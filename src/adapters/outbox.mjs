// adapters · 出站口（core 唯一的「发消息」入口）
// ============================================================================
// ★ 为什么要这一份：进站已经有 core 的家（src/events/），**出站**却散在三个 DSH 插件里 ——
//   hub.js 的 sendSegments、aurabot-modules/lead-relay 的 flushOutbox、core/bridge.js 的 open+send。
//   三条路各自实现一次重试 / 脱敏 / 幂等，代价不是重复劳动，是**v4 数不出发了几条**：
//   面板上只能显示 0，而「0」和「没发过」长得一模一样（本项目为这类死读数付过代价）。
//   收成一个函数之后：发出去、记账、可读 —— 判据与显示在同一处。
//
// ★ 只走 OneBot 标准 HTTP（send_group_msg / send_private_msg / send_poke）：
//   不引 DSH 的任何私有 API，也不读部署配置 —— baseUrl / token 全部从 opts 来。
//   换网关时坏的地方只在一处；这个文件也因此**不认识「谁在发」**，它只认 chatId。
//
// ★ 2026-11-24 第二片：除了「发消息 / 戳一戳」，再开一条**白名单**动作通道 act()。
//   只认白名单里的资料类动作，**没有通用 call(action, params)** ——
//   通用通道等于把整张 OneBot 动作表（含群管理、上传、好友申请、Qzone）交给任何一个调用方。
//   白名单外一律拒，且拒在**网络之前**；这些动作**不进幂等表**（同一句签名改两次是意图，
//   不是事故），也**不自动重试**。
//
// ★ 2026-11-24 第三片：白名单从 5 个加到 7 个 —— set_qq_avatar（换自己的头像）与
//   add_custom_face（往自己的收藏表情库里加一张）。挑这两个的理由是同一个：
//   它们只动**机器自己的资料 / 表情库**，不碰任何群、不碰任何人、不传群文件。
//   ★ 两条各自的契约必须原样保住：
//     · set_qq_avatar 的 file 有**三种既有形态** —— base64://…（profile 与头像同步）、
//       本机临时文件路径（profile 换头像的第二手）、http(s) 网址（avatarSource）。
//       这一层**不归一、不裁剪、不改写**：原样进请求体（改一个字符就是换了一张图）。
//     · add_custom_face 成功时网关回 data.emoji_id，调用方（stickers.js）拿它继续去
//       写备注 / 记进本地库 —— 所以 act() 必须把 data **原件**交回去，不能被裁成 { ok:true }。
//   ★ 它们和那五个一样：mode 关着就 fail-closed、绝不回落旧 client、不自动重试、参数不进日志。
//
// ★ 2026-11-24 第四片：白名单从 7 个加到 9 个 —— set_friend_add_request /
//   set_doubt_friends_add_request（**通过 / 拒绝**别人加她为好友的申请；两份申请来源：
//   收到的事件走前者，被 QQ 过滤的「可能认识的人」走后者）。
//   ★ 这两个和前面七个的判据**不是同一条**，得说清楚，不能拿「只动自己」蒙过去：
//     前面七个改的是机器人自己的资料 / 状态 / 表情库，**不涉及第二个人**；
//     这两个改的是**机器人和另一个人的关系**（把人加进自己的好友列表，或拒绝）。
//     它们仍然不碰群、不碰第三方、不传文件 —— 但「只动自己」这句话对它们不成立，
//     所以判据在这里改写成：**只动机器人自己这一侧**（自己的资料 / 自己的表情库 /
//     自己的好友列表），不碰任何群，也不替别人做决定。
//   ★ 两条契约必须原样保住（这里不复制判据，只保证不破坏上游的判据）：
//     · flag **必须原样传**：它来自收到的事件（String(ev.flag)）或
//       get_doubt_friends_add_request 回的 uid，由网关签发。自己拼一个、归一化一个、
//       截断一个，指的就是**另一条申请** —— 而失败的样子是「网关说 flag 无效」，
//       看起来像网关的问题。
//     · approve 是布尔，原样传（true 通过 / false 拒绝）：把 false 写成 0 或字符串 'false'，
//       在网关那边可能就是「通过」。
//   ★ 授权 / 可见性 / dryRun / 待处理申请匹配 / 缓存清理全部留在 contacts 模块里
//     （profileToolVisible + guarded() 的 profilePermits 在 execute 时现判），这一层一个字都不碰。
//   ★ 它们是**审批类动作**：不挂摘要幂等、不自动重试。同一条申请连点两次通过，
//     是两次请求（第二次由网关判「已经处理过」），不是这里替它去重 —— 去重会让
//     「第一次失败了、第二次被静默吞掉」变成可能。
//
// ★ 2026-11-24 第五片：白名单从 9 个加到 10 个 —— **只加 delete_qzone_msg 一个**。
//   ★ 判据在这里必须再一次改写，不能顺手把整个 Qzone 带走。这一片只删**一条自己发过的说说**，
//     和前面十一个（资料 / 状态 / 表情库 / 好友列表）的共同点不是「只动自己」——
//     说说本来就是公开的。真正的判据是：**它是撤回，不是发出**。
//     删一条动态把公开面**收窄**回自己这一侧；发说说 / 评论 / 点赞是往公开面**投**东西，
//     方向相反。所以 send_qzone_msg / comment_qzone / like_qzone 一个都不迁 —— 那是下一片
//     要单独讨论的事，不是顺手带上的事。
//   ★ 参数 { tid } **原样**传：tid 是那条动态的门牌，由网关签发。改写 / 归一化一个字符，
//     指的就是另一条说说 —— 而失败会长成「网关说 tid 无效」，看起来像网关的问题。
//     ★ tid 不是秘密（它是已经公开发布过的那条动态的 id），但**同样不进日志 / 视图 / 记录**：
//       记录里只有动作名，读不出去「删了哪一条」。这条纪律不按「是不是秘密」分级，
//       按「投影不该比权威更方便」分级。
//   ★ 空 tid / 总开关 / 试运行三道闸**不在这一层**：它们在 src/aurabot/src/features/qzone.js
//     的 remove() 里（先 trim、先非空、再判 enabled / dryRun），到这里时已经是干净的 tid。
//     这一层不复制判据，也不重复 trim —— 两份判据只会在某个拼错的配置上分叉。
//   ★ **不挂摘要幂等、不自动重试**：删两次就是两次请求（第二次由网关判「已不存在」）。
//     摘要去重会让「第一次失败了、第二次被静默吞掉」变成可能 —— 那正是这里最不能让发生的事。
//
// ★ 2026-11-24 第六片：白名单从 10 个加到 12 个 —— **只加上传那一对**：
//   upload_group_file / upload_private_file。
//   ★ 判据这一次**必须第四次改写**，而且不能再用「只动自己这一侧」糊过去：
//     往群里传一个文件，落点是**别人的群**；往私聊传，落点是**另一个人的会话列表**。
//     它既不是「只动自己」，也不是「撤回」。这一片真正的判据是**用户明确授权**：
//     爀曦点名要迁的是这两个，且**只有这两个** —— 当时群管理（set_group_ban / set_group_kick /
//     set_group_special_title / _send_group_notice）与 Qzone 的 like_qzone 都还在外面。
//     ★ 随后两片靠**新的**授权分别迁走：第七片头衔 / 公告，第八片禁言 / 踢人 / 点赞。
//     这一段留作沿革；当前的全部已迁动作见适配层 DELEGATED_NOTE。
//   ★ 不破的那条底线：这一层仍然**只认名字、不认能力** —— 能不能发、发给谁、发多大，
//     全由上游 hub.js 的 sendFile 判（files.enabled / 绝对路径 / 存在 / 是普通文件 /
//     允许目录 / maxMB）。这一层不复制任何一条判据：两份判据只会在某个拼错的配置上分叉。
//   ★★ 这一片最锋利的一条：**参数不许进记录**。
//     { file } 可能是本机绝对路径（带用户名、带目录结构），也可能是 base64:// 的一整段内容。
//     记录 / 视图 / 日志里只许出现**动作名**。理由不是「它是秘密」，是另一条：
//     记录里出现路径 = 给出「她往谁那儿发过哪个文件」的索引，而投影不该比权威更方便。
//     ★ 传输层**不归一、不裁剪**那个 file 字符串：base64://… 与 C:\… 都是上游给的形态，
//       改一个字符就是另一个文件（或者另一种失败）。
//   ★ 超时：hub 的 sendFile 每次显式给 FILE_TIMEOUT_MS=120000（大文件上传不该被 30s 判死）。
//     这一层把 per-call timeoutMs 原样往下传，不改写、不封顶 —— 120000 到出站口还是 120000。
//   ★ **不自动重试、也不做 base64 回落**：本机路径失败之后改走 base64 是 hub 的**业务决定**
//     （只有它知道 30MB 上限和这个文件有多大），不是传输层的职责。传输层若自己重试，
//     hub 的两次调用就会变成四次真正上传 —— 那是个不会报错、只会慢慢烧带宽的回归。
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

/**
 * act() 认的动作 —— **白名单，逐字相等**。
 *
 * ★ 为什么是白名单而不是「除了群管理都放行」：黑名单要求我事先想全所有危险动作
 *   （set_group_ban / set_group_kick / set_group_whole_ban / upload_* / *_qzone /
 *    set_*_add_request / _send_group_notice …），漏一个就是多给别人一只手。
 *   白名单反过来：没写进去的一律不存在。
 * ★ 这几个的共同点：只动**机器人自己这一侧** —— 自己的资料 / 状态 / 表情库 /
 *   好友列表；不动任何群、不传文件、不替别人做决定。
 *   Aurabot 侧的真实调用点：hub 的按键状态（set_input_status）、收藏表情备注与删除
 *   （modify/delete_custom_face）、模块的昵称与签名（set_qq_profile / set_self_longnick）、
 *   头像（profile 模块 / 头像同步 handler → set_qq_avatar）、偷表情时收藏到 QQ
 *   （stickers.js → add_custom_face）、通过 / 拒绝好友申请
 *   （contacts 模块 → set_friend_add_request / set_doubt_friends_add_request）。
 *   ★ 最后两个是第四片（2026-11-24）加的。它们**不满足**「不涉及第二个人」那条判据：
 *     通过申请就是把人加进自己的好友列表。判据因此改写成「只动自己这一侧」，
 *     而不是含糊的「只动自己」—— 后者会让这两个看起来比实际的更无害。
 *   ★ 最后一个是第五片（2026-11-24）加的：delete_qzone_msg（删掉自己发过的一条说说）。
 *     它**也不满足**「只动自己这一侧」这条判据 —— 说说本来就是公开的。判据第三次改写：
 *     **它是撤回，不是发出**（把公开面收窄回自己这一侧）。
 *     send_qzone_msg / comment_qzone / like_qzone 都是往公开面投东西，必须**逐个**授权。
 *     ★ 「逐个」不是修辞：这三件确实分三次进来的（send_qzone_msg 本片、comment_qzone 第六片、
 *       like_qzone 第八片）。判据没变 —— 变的只是每件各自拿到了自己那张票。
 * ★ 加一个名字之前先问：它会不会动到别人的群 / 别人的东西 / 替别人拍板？
 *   会就留在这道白名单外面。★ 好友申请在名单里，是因为「同意」只有机器人自己能做，
 *   不存在替第三方拍板；而**禁言别人**（set_group_ban）、**踢人**（set_group_kick）
 *   同样越过这条线 —— 它们在第八片进名单，靠的**不是**这条判据，而是用户明确授权。
 *   ★ 把这两件事分开读很重要：判据说「对人下手本来该在外面」，授权说「这一次让你进」。
 *     判据一个字都没放宽；下一个人不该因为它们在名单里，就以为「对人下手」变得无害了。
 *   ★ 「往群里传文件」曾经也在这条线上（第六片靠用户明确授权进来的，不是靠这条判据）：
 *     判据被用户授权改写的前后两版都写在下面，别把两件事读成一件。
 * ★ 第六片（2026-11-24）加的是 upload_group_file / upload_private_file。
 *     ★ 它们**不满足**前面任何一条判据，这一点必须写清楚，不许含糊：
 *       传文件不「只动自己这一侧」（落点是别人的群 / 别人的私聊），也不是「撤回」。
 *       唯一的理由是**用户明确授权**：爀曦点名迁这一对，且**只有这一对**。
 * ★ 第七片（2026-11-24）加的是 set_group_special_title / _send_group_notice。
 *     ★ 它们同样**不满足**前面任何一条判据，同样必须写清楚：
 *       改别人的专属头衔、往群里发公告，落点都是**别人的群**——既不是「只动自己这一侧」，
 *       也不是「撤回」。成立的唯一理由也是**用户明确授权**：爀曦点名迁这两个名字，
 *       且**只有这两个**。
 *     ★ 第七片**当时**没有跟着走的两件写动作是 set_group_ban / set_group_kick：
 *       禁言和踢人是对人下手，改头衔 / 发公告是对群的标识下手 —— 授权了两个不等于
 *       授权了四个。Qzone 评论由本片单独授权迁移，点赞当时仍留在旧路由。
 *       （这三件在第八片被单独授权迁走了，见下一条；这段留作沿革，别当成当前状态读。）
 * ★ 第八片（2026-11-24）一次加了三个：set_group_ban / set_group_kick / like_qzone。
 *     ★ 它们同样**不满足**前面任何一条判据，理由仍然只有一个：**用户明确授权**
 *       （爀曦点名「两类都迁」：Qzone 点赞 + 群的禁言 / 踢人）。
 *     ★ 但这一片有一条前几片没有的注记，别漏读：授权的是**迁移代码路径**，
 *       不是「现在就去真点赞 / 真禁言 / 真踢人」。测试里全是假网关、假 client，
 *       没有一个真请求离开本机；迁移让这些动作**受同一道闸管**，不是让它们更容易发生。
 *     ★ 到这里白名单里**没有剩下的已知写动作**了。★ 但这句话只覆盖**已知**：
 *       白名单从来不等于「所有 OneBot 写动作」。未知的 / 自定义的 / 第三方 facade 上的
 *       名字仍然在名单外 —— 而这道闸之所以还成立，正因为**没写进去的一律不存在**
 *       （见下一条：白名单的反面不是一个更短的黑名单，是「不存在」）。
 * ★ 顺序是接口的一部分（面板与本层都在读它）：新增名字**追加在末尾**，不重排已有的。
 */
export const ACT_ACTIONS = Object.freeze([
  'set_input_status',
  'modify_custom_face',
  'delete_custom_face',
  'set_self_longnick',
  'set_qq_profile',
  'set_qq_avatar',
  'add_custom_face',
  'set_friend_add_request',
  'set_doubt_friends_add_request',
  'delete_qzone_msg',
  'upload_group_file',
  'upload_private_file',
  'set_group_special_title',
  '_send_group_notice',
  'send_qzone_msg',
  'comment_qzone',
  'set_group_ban',
  'set_group_kick',
  'like_qzone',
])

/**
 * 这口只读视图的自述 —— 验收脚本可以断言 writes===0、actions 正好是这 22 个名字
 * （3 个发送/戳 + 19 个 act 白名单动作）。
 * ★ 第四片之后这里的分组说法改了：前七个别再叫「资料动作」——
 *   好友申请不是资料，是**审批**。叫错名字的代价是下一个人以为这条通道只管资料，
 *   于是把「加人 / 拒绝人」当成资料动作顺手塞进来。
 * ★ 第五片之后连「自身动作」这个词也不够用了：delete_qzone_msg 动的是一条**公开**的说说。
 *   所以自述里改叫「act 白名单动作」，并对删除那一件单独说明它是**撤回**。
 * ★ 第六片之后这个分组词只能叫「act 白名单动作」—— 不能再加形容词。
 *   上传那一对动的既不是自己、也不是撤销：落点是别人的群 / 别人的私聊。
 *   任何「它们是……类动作」的概括都会替下一个人做一个错的推论，
 *   所以自述里只写**确切的名字**和**它们不在哪一类里**。
 */
export const OUTBOX_PORT = Object.freeze({
  id: 'outbox-core',
  v: 1,
  routes: ['GET /api/outbox'],
  writes: 0,
  actions: Object.freeze(['send_group_msg', 'send_private_msg', 'send_poke', ...ACT_ACTIONS]),
  // ★ note 逐字列出全部名字，而不是只报个数：面板和验收脚本读的就是它，
  //   一个「12 个动作」的模糊说法，读不出**哪十二个** —— 而「哪些动作改道了」正是这段要交代的事。
  //   ★ 第六片起 note 还多担一件事：把剩下那几个写动作**逐个点名**留在这里，
  //     因为「还剩几个」和「还剩哪几个」是两条信息，而后者才是下一片要接的活。
  //   ★ 第八片把 like_qzone 与群禁言 / 踢人也追加进名单；未知 / 自定义写动作仍不在白名单。
  note: '出站只用 OneBot 标准 HTTP：3 个发送/戳动作（send_group_msg / send_private_msg / send_poke）+ 19 个 act 白名单动作（set_input_status / modify_custom_face / delete_custom_face / set_self_longnick / set_qq_profile / set_qq_avatar / add_custom_face / set_friend_add_request / set_doubt_friends_add_request / delete_qzone_msg / upload_group_file / upload_private_file / set_group_special_title / _send_group_notice / send_qzone_msg / comment_qzone / set_group_ban / set_group_kick / like_qzone）；delete_qzone_msg 是**撤回**（删掉自己发过的一条说说，把公开面收窄回自己这一侧），send_qzone_msg / comment_qzone / like_qzone 都已经在名单里走 act；上传那一对（upload_group_file / upload_private_file）与群头衔 / 群公告（set_group_special_title / _send_group_notice）都是**用户明确授权**才进来的，它们既不是「只动自己这一侧」也不是撤回 —— 落点都是别人的群 / 别人的私聊；第八片（2026-11-24）把最后三个**已知**写动作（set_group_ban / set_group_kick / like_qzone）也迁完了 —— 至此**没有剩下的已知写动作**；但白名单 ≠ 所有 OneBot 写动作：未知的 / 自定义的 / 第三方 facade 上的名字仍在名单外（逐字相等，前缀像、大小写像都不算数）；没有通用 call(action, params) 通道 —— 白名单外一律拒。',
})

/**
 * 唯一认的「真出站」模式。别的写法（off / 空 / 拼错 / 大小写 / 多一个后缀）一律**不认**。
 *
 * ★ 为什么判据必须在这里、而不是散在调用方：出站口自己就是「能不能发」的那只手。
 *   只要这只手还认 baseUrl 就能发，那么**谁把它传出去**（events 的回复投递器、
 *   aurabot 的适配层）就各自要记得先看一眼 mode —— 那是三份判据，迟早分叉。
 *
 * ★ 2026-11-24 修的真缺口：createOutbox 原来只判 baseUrl，而 managed 配置
 *   **强制 mode=off 却可能留着 httpUrl**。于是「开关关着」和「能发」同时成立，
 *   而这两种状态在日志里长得一模一样。
 */
export const EGRESS_MODE_ON = 'onebot-http'

/**
 * 归一：只 trim，不宽容。不认的一律 'off'。
 * ★ 不做大小写 / 别名 / 前缀匹配 —— 宽容一个拼错的模式，就是把这道闸变成装饰。
 */
export function normalizeEgressMode (mode) {
  return String(mode == null ? '' : mode).trim() === EGRESS_MODE_ON ? EGRESS_MODE_ON : 'off'
}

/**
 * 「这个 mode 配不配拿到出站口」的**唯一**判据（core 用它决定交给谁）。
 *
 * ★ 失败方向只有一个：不认的模式 = 不交出站口 = 调用方一律拒绝。
 *   没有第二只手、没有回落 —— 有回落就等于「关着也能发」。
 *
 * @param {unknown} mode      config.events.egress.mode
 * @param {object|null} outbox 已经建好的出站口（**非 null 不代表能交**）
 * @returns {object|null}     只有 mode === 'onebot-http' 且 outbox 可用时才返回它
 */
export function selectOutbox (mode, outbox = null) {
  if (normalizeEgressMode(mode) !== EGRESS_MODE_ON) return null
  return outbox || null
}

const DEFAULT_TTL_MS = 10 * 60 * 1000
const DEFAULT_TIMEOUT_MS = 8000

/**
 * act() 的默认超时：30000ms —— 与 Aurabot 的 OneBot client
 * （src/aurabot/src/onebot/client.js 的 `call(action, params, { timeoutMs = 30000 })`）逐字同值。
 *
 * ★ 为什么**不跟** createOutbox 的 timeoutMs（8000）：8s 是「发一条消息」的默认，
 *   而这些动作的调用方默认 30s（hub 的 set_input_status 显式给 5s、模块改资料给 15s；
 *   换头像那两处 profile 显式给 30s、头像同步 handler 没传、stickers 收藏表情没传 ——
 *   没传的都落在 30s）。把它们塞进 8s，就是「同一个动作迁移后更容易被判超时」——
 *   一个不会报错、只会写进失败串的行为回归。
 * ★ 每次调用仍能用 opts.timeoutMs 覆盖（正数才认，坏值回到 30s）。
 */
export const ACT_DEFAULT_TIMEOUT_MS = 30000

/**
 * act() 每次调用的超时：正数才认，其余（0 / 负数 / NaN / Infinity / 'abc' / 缺失）一律 30000。
 * ★ 与 send / poke 的 resolveTimeout 同一条判据，只是回落值不同（30s）：坏值不许被当成「不超时」。
 */
export function resolveActTimeoutMs (value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : ACT_DEFAULT_TIMEOUT_MS
}
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
 *   mode = 'off',            // off | onebot-http —— **不传就是 off**（安全默认）
 *   baseUrl, token | tokenEnv, env,
 *   timeoutMs = 8000,        // 配置默认；每次调用可用 send(..., {timeoutMs}) / poke(..., {timeoutMs}) 覆盖
 *   dedupeTtlMs = 10min, recentMax = 20,
 *   fetchImpl, now, log, register = true,
 * }
 * ★ mode 与 baseUrl 是**两个独立条件**，两个都满足才发得出去：
 *   · mode 不是 onebot-http → send / poke 直接拒，**连网都不碰**（baseUrl 配了也不算数）；
 *   · baseUrl 空 → 仍然 fail-closed（没有地址发不出去）。
 *   「配了地址」不等于「允许发」—— 这正是 2026-11-24 那个缺口。
 * ★ register：创建即登记为「本进程的出站口」（/api/outbox 读的就是它）。
 *   一个进程只该有一个出站口 —— 后建的覆盖前一个，不是并存；要并存必须显式 register:false。
 */
export function createOutbox (opts = {}) {
  // ★ 默认 off：老调用点（没传 mode 的）不会因为「忘了写」而变成能发。
  //   要真发，必须显式写 mode: 'onebot-http' —— 那是一次有意的动作，不是默认值。
  const mode = normalizeEgressMode(opts.mode)
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

  /**
   * 每次调用的超时：正的有限数才认，否则回落配置默认。
   * ★ 0 / 负数 / NaN / Infinity / 'abc' 一律回落 —— 那些都不是「不超时」的意思，
   *   把一个坏值当成无限等待，比用默认值更糟（请求会一直挂着，close() 之前谁也收不了它）。
   */
  function resolveTimeout (value) {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? n : timeoutMs
  }

  /** 幂等表不能无限长：先按 TTL 清，再按最旧清（内存里只留窗口内的键）。 */
  function prune () {
    if (entries.size <= MAX_ENTRIES) return
    const t = now()
    for (const [k, v] of entries) if (t - v.at >= ttlMs) entries.delete(k)
    while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value)
  }

  /** 模式关着时的统一说法（不含任何地址 / token —— 错误串会进记录与日志）。 */
  const modeGateError = () => '出站模式是 ' + mode + '（只有 ' + EGRESS_MODE_ON + ' 才发）—— 没发，也没连网'

  async function send (chatId, segments, sendOpts = {}) {
    if (closed) return fail(chatId, null, '出站口已关闭（close() 之后不再发）')
    // ★★★ 2026-11-24：**模式闸在 baseUrl 之前**，且与 baseUrl 无关。
    //   顺序不是审美：放在后面，mode=off 又会走到「有地址 → 发」那条老路上。
    if (mode !== EGRESS_MODE_ON) return fail(chatId, null, modeGateError())
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

    // ★ 超时**按次可覆盖**：迁移过来的调用方（Aurabot 的 OneBot client）本来默认 30s，
    //   落进这里的 8s 默认就是「同一句话迁移后更容易被判超时」—— 一个不会报错的行为回归。
    //   ★ 超时与 close() 共用同一个 abort —— 两套取消机制会让「关掉了还在发」成为可能
    const ctrl = new AbortController()
    inflight.add(ctrl)
    const timer = setTimeout(() => { try { ctrl.abort() } catch { /* 已结束 */ } }, resolveTimeout(sendOpts.timeoutMs))
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
    const status = body && typeof body.status === 'string' ? body.status.trim().toLowerCase() : ''
    const wording = body && (body.wording || body.msg || body.message) ? String(body.wording || body.msg || body.message) : ''

    if (!res.ok) return fail(target.chatId, target.action, 'HTTP ' + res.status + (wording ? '：' + wording : ''), { retcode, preview: previewOf(segs) })
    if (!body || typeof body !== 'object') return fail(target.chatId, target.action, '网关回的不是 JSON', { retcode, preview: previewOf(segs) })
    // ★★ OneBot 的成功语义：status === 'ok' **或** retcode === 0（与 aurabot 的 OneBot client 逐字同源）。
    //   有的网关只回 { status:'ok', data:{ message_id } }，**不带 retcode**。
    //   旧代码把「缺 retcode」当失败 —— 于是消息真的到群里了，记账却写「没发出去」，
    //   调用方还会把它当失败去重试。这一条是迁移后最不该保留的差异，比 8s/30s 更隐蔽。
    //   ★ 反过来也不许放宽：什么都不给（status 缺失、retcode 缺失）= 失败，不默认成功。
    if (status !== 'ok' && retcode !== 0) {
      return fail(target.chatId, target.action, 'retcode=' + String(retcode) + (status ? ' status=' + status : '') + (wording ? '：' + wording : ''), { retcode, preview: previewOf(segs) })
    }

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
   * ★ 超时按次可覆盖：poke(chatId, userId, { timeoutMs })（hub 戳一戳给的是 10s）。
   */
  async function poke (chatId, userId, pokeOpts = {}) {
    if (closed) return fail(chatId, 'send_poke', '出站口已关闭')
    // ★ 与 send 同一道闸、同一句理由：戳一戳也是**真发出去**的动作。
    if (mode !== EGRESS_MODE_ON) return fail(chatId, 'send_poke', modeGateError())
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
    // ★★ 在途请求必须登记：close() 靠 inflight 才能掐断它。
    //   以前 poke 没登记 —— close() 之后这条戳会一直挂到自己的定时器才结束，
    //   而「关掉了还在发」正是这口要保证不出现的事（send 早就守住了，poke 漏了）。
    inflight.add(ctrl)
    const timer = setTimeout(() => { try { ctrl.abort() } catch { /* 已结束 */ } }, resolveTimeout(pokeOpts.timeoutMs))
    init.signal = ctrl.signal
    let res
    let body2 = null
    try {
      res = await fetchImpl(baseUrl + '/send_poke', init)
      try { body2 = await res.json() } catch { body2 = null }
    } catch (e) {
      // ★ 失败只走 fail()：它自己 += 1。以前这里先手动 += 1 再调 fail()，
      //   一次失败记成两次 —— 面板上的 failed 会翻倍，而两个数都「看着有理由」。
      const cause = e && e.cause && (e.cause.code || e.cause.message)
      return fail(target.chatId, 'send_poke', '网络错误：' + String((e && e.message) || e) + (cause ? '（' + String(cause) + '）' : ''))
    } finally {
      // ★ 清理只在这里做一次（close() 已经 abort 过时，delete 是幂等的空操作）。
      clearTimeout(timer)
      inflight.delete(ctrl)
    }
    const retcode = body2 && body2.retcode != null && Number.isFinite(Number(body2.retcode)) ? Number(body2.retcode) : null
    const status = body2 && typeof body2.status === 'string' ? body2.status.trim().toLowerCase() : ''
    const wording = body2 && (body2.wording || body2.msg || body2.message) ? String(body2.wording || body2.msg || body2.message) : ''
    if (!res.ok) return fail(target.chatId, 'send_poke', 'HTTP ' + res.status + (wording ? '：' + wording : ''), { retcode })
    // ★ 与 send 同一条成功判据（OneBot client 的 status==='ok' || retcode===0）。
    //   缺 retcode 时**只有** status==='ok' 才算成功 —— 什么都不给 = 失败，不默认成功。
    //   旧代码 `retcode 缺失 → 0`，等于把「没回执」当「戳成功了」。
    if (status !== 'ok' && retcode !== 0) {
      return fail(target.chatId, 'send_poke', 'retcode=' + String(retcode) + (status ? ' status=' + status : '') + (wording ? '：' + wording : ''), { retcode })
    }
    counters.sent += 1
    counters.lastAt = iso(now())
    return { ok: true, retcode: 0, poked: uid }
  }

  /**
   * 白名单动作（资料 / 状态类）。**不是消息**：没有 chatId、没有消息段、没有幂等。
   *
   * ★ 三条与 send 故意不同的地方，每一条都是「不这么做就会出事」：
   *   ① **不进幂等表**：同一句签名连改两次、同一张表情备注写两次，是调用方的意图。
   *      用内容摘要去重 = 第二次被静默吞掉，而调用方以为改成了。
   *   ② **不自动重试**：这些动作不是「重发一条消息」那么无害（改昵称 / 改签名 /
   *      删收藏表情），重试的语义由调用方判断，不藏在传输层里。
   *   ③ **params 不进记录、不进日志**：里面有昵称、签名、表情备注 —— 那是用户内容。
   *      记录只留动作名、成败、retcode；正文一个字都不留。
   *      ★ 第四片的**审批类**参数同样一个字都不留：`flag` 是网关签发给某一条申请的
   *        凭据（等同于那条申请的门牌），`approve` 是「同意还是拒绝」这个决定本身。
   *        两者都不进 recent / view / stats / 日志 —— 记录里只有动作名 set_friend_add_request，
   *        读不出去**批了哪一条**。要查具体那一条，回网关日志看（投影不该比权威更方便）。
   *      ★ 第五片的 `tid`（delete_qzone_msg）同理，但理由**不是**「它是秘密」：
   *        tid 是已经公开发布过的那条动态的 id，本来就在人眼前。留白的理由是另一条：
   *        记录里出现 tid，等于给出「这条什么时候被删了」的索引 —— 而删除是一件
   *        「谁都不知道发生过」才更安全的事。这一层把 tid 和 flag 一样当**门牌**对待，
   *        不按「是不是秘密」分级。
   *      ★ 第六片的 `file`（upload_group_file / upload_private_file）是这一条现在
   *        最重的一例，而且它把两种东西同时挡在外面：
   *          · 本机绝对路径 —— 里面有用户名、有目录结构、有「她平时把文件写在哪」；
   *          · base64://… —— 那是一整个文件的全部字节，进了记录就是记录里躺着文件本身。
   *        记录里只许有**动作名**：读不出去「往哪个群 / 哪个人发过什么」。
   *        要追具体那一次，回网关日志看 —— 投影不该比权威更方便。
   *        ★ 而且这一层**不改写**那个 file 字符串（不 trim、不 resolve、不换形态）：
   *          它是上游 hub 判完之后交给这里的原件，改一个字符就是另一个文件。
   *
   * ★ 成功返回 { ok:true, retcode:0, data }：data 是网关的**原件**
   *   （Aurabot 的 OneBot client 成功时 return 的也是 `j.data`，
   *    调用方靠 emoji_id 之类继续干活，裁剪它等于改契约）。
   *   ★ add_custom_face 正是靠这条活着的：stickers.js 收完表情后要拿 data.emoji_id
   *     去写备注（modify_custom_face）并记进本地库 —— 这里少给一层，那边就静默丢一张。
   * ★ set_qq_avatar 的 params.file 三种形态（base64://… / 本机路径 / http(s) 网址）
   *   **原样进请求体**：归一化会把「同一张图」变成「另一张图」，而失败还长得像网关的问题。
   * ★ 失败一律**返回** { ok:false, retcode, error }，绝不抛。
   */
  async function act (action, params = {}, actOpts = {}) {
    const name = String(action == null ? '' : action).trim()
    if (closed) return fail('', name || null, '出站口已关闭（close() 之后不再发）')
    // ★ 与 send / poke 同一道闸、同一句理由，且**在网络之前**：动作也是真出站。
    if (mode !== EGRESS_MODE_ON) return fail('', name || null, modeGateError())
    if (!baseUrl) return fail('', name || null, '未配置 baseUrl —— 出站口没有接线，一个动作都没发')
    // ★★ 白名单判在联网之前：不在名单里的名字（名字拼错的 / 大小写像的 / 带后缀的 /
    //    未知的 / 自定义的）连请求体都不会被生成。这里没有通用 call 通道，也不加。
    //    ★ 第八片之后这一句**不能再点任何具体写动作的名字当反例**：
    //      set_group_ban / set_group_kick / like_qzone 都已经进白名单。拿它们当反例，
    //      下一个人会以为「写动作要么全在、要么全不在」—— 而真相是这份名单只覆盖
    //      **已知**写动作，未知 / 自定义 / 第三方 facade 上的名字仍然在外面，且必须一直在外面。
    //    ★ 第七片之后 set_group_special_title / _send_group_notice **已经在名单里**，
    //      所以这里不能再把它们当「不在名单」的例子 —— 那句会误导下一个人以为
    //      迁了两个名字就等于整块群管都进来了。（当时 ban / kick 确实还在外面；
    //      第八片把它们也迁了，但「名字逐字相等」这条判据一个字都没松。）
    //    ★ 第四片之后 set_friend_add_request 本身**已经在名单里**，所以原来那句写的
    //      「set_*_add_request」改掉了；第五片之后 delete_qzone_msg 也**已经在名单里**，
    //      所以这里不能再写成「*_qzone 一律拒」—— 那句会误导下一个人以为整块 Qzone 都在外面。
    //      ★ 第六片之后 upload_* 也**已经在名单里**了（就是那两个确切的名字）——
    //        所以这里不能再写成「upload_* 一律拒」。★ 但反向的一半要留着：
    //        upload_group_file_extra / Upload_Group_File / upload_file 这类近似串**仍然在名单外**，
    //        名字是逐字相等的，前缀像、大小写像都不算数。
    if (!ACT_ACTIONS.includes(name)) {
      // ★ 判语放在**前面**：这条错误串会被 ERROR_MAX(200) 截断，而白名单现在有 19 个名字 ——
      //   把「不在白名单」写在名单后面，截断后剩下的是一串动作名，读不出到底为什么被拒。
      //   （2026-11-24 第四片实测：加两个名字后，原来的写法被截成「act 只认 … set_gr」。）
      return fail('', name || null, 'act：' + (name || '(空)') + ' 不在白名单，没发，也没连网；只认 ' + ACT_ACTIONS.join(' / '))
    }
    const payload = params && typeof params === 'object' && !Array.isArray(params) ? params : null
    if (!payload) return fail('', name, 'params 必须是对象（act 不做归一，也不猜字段）')

    let bodyText = ''
    try {
      bodyText = JSON.stringify(payload)
    } catch (e) {
      // 循环引用 / BigInt 之类：序列化失败也是「没发出去」，不抛给调用方
      return fail('', name, '参数无法序列化：' + String((e && e.message) || e))
    }

    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: bodyText }
    if (token) init.headers.authorization = 'Bearer ' + token

    // ★ 超时与 close() 共用同一个 abort，且在途请求必须登记 —— 否则 close() 掐不断它。
    const ctrl = new AbortController()
    inflight.add(ctrl)
    const timer = setTimeout(() => { try { ctrl.abort() } catch { /* 已结束 */ } }, resolveActTimeoutMs(actOpts.timeoutMs))
    init.signal = ctrl.signal

    let res
    try {
      res = await fetchImpl(baseUrl + '/' + name, init)
    } catch (e) {
      const cause = e && e.cause && (e.cause.code || e.cause.message)
      return fail('', name, '网络错误：' + String((e && e.message) || e) + (cause ? '（' + String(cause) + '）' : ''))
    } finally {
      clearTimeout(timer)
      inflight.delete(ctrl)
    }

    let text = ''
    try { text = await res.text() } catch { text = '' }
    let body = null
    try { body = text ? JSON.parse(text) : null } catch { body = null }

    const retcode = body && body.retcode != null && Number.isFinite(Number(body.retcode)) ? Number(body.retcode) : null
    const status = body && typeof body.status === 'string' ? body.status.trim().toLowerCase() : ''
    const wording = body && (body.wording || body.msg || body.message) ? String(body.wording || body.msg || body.message) : ''

    if (!res.ok) return fail('', name, 'HTTP ' + res.status + (wording ? '：' + wording : ''), { retcode })
    if (!body || typeof body !== 'object') return fail('', name, '网关回的不是 JSON', { retcode })
    // ★ 成功语义与 OneBot client 逐字一致：status === 'ok' **或** retcode === 0。
    //   什么都不给 = 失败（不默认成功）；缺 retcode 但有 status:'ok' = 成功。
    if (status !== 'ok' && retcode !== 0) {
      return fail('', name, 'retcode=' + String(retcode) + (status ? ' status=' + status : '') + (wording ? '：' + wording : ''), { retcode })
    }

    counters.sent += 1
    counters.lastAt = iso(now())
    // ★ 记录里**没有** preview / len / params：动作的正文是用户内容（昵称、签名、备注）。
    record({ at: counters.lastAt, chatId: '', action: name, ok: true, retcode: 0, messageId: null, deduped: false, preview: '' })
    log('[outbox] 动作 ' + name + ' 完成（retcode=0）')
    return { ok: true, retcode: 0, data: body.data === undefined ? null : body.data }
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
      // ★ 2026-11-24：视图的 mode 现在要求**两个条件都满足**。
      //   以前只看 baseUrl —— 于是 mode=off 却配了 httpUrl 的进程，
      //   /api/outbox 会写「on / configured: true」，而它一条都发不出去。
      //   「看起来接线了」和「真的能发」是两件事，面板必须说后者。
      mode: closed ? 'closed' : ((mode === EGRESS_MODE_ON && baseUrl) ? 'on' : 'off'),
      egressMode: mode,                 // 配置说了什么（与 baseUrl 无关）
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

  const api = { send, poke, act, stats, close, view, config: Object.freeze({ host: (() => { try { return new URL(baseUrl).host } catch { return '' } })(), mode, timeoutMs, ttlMs, recentMax }) }
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