// 模块侧 OneBot facade 的闸（唯一实现）
// ============================================================================
// ★ 这张表有三类名字，判法各不相同，别混着读：
//   · **写**（22 个）= 必须过 enabled / dryRun 闸；
//   · **读**（19 个）= 只读，闸不开也放行 —— 否则试运行里连 get_msg 都读不回来，
//     而「读不到」和「发不出去」是两件事，不该用同一道闸；
//   · **未分类** = 关闭 / 试运行下拒绝（reason 'unclassified'），live 下原样透传。
// ★ 为什么 live 还要透传未知动作：模块是别人写的，第三方网关 / 自建 facade 上的动作名
//   我们盘不全。live 下照旧交给 client，是为了不把「没盘到」变成「突然不能用」；
//   但这**不是授权** —— 名单里没有的名字，没有任何一层替它背书。
//   也没用前缀 / 大小写 / 别名去猜：'get_xxx' 长得像读，也照样是未分类。
// ============================================================================

// ★ 写名单的唯一来源：出站口的 OUTBOX_PORT.actions（3 send/poke + 19 act）。
//   这里**不抄第二份 22 个名字** —— 两份名单只会在某个下午于一个拼错的名字上分叉，
//   而分叉的表现是「闸放行了、出站口拒绝」，或反过来（一个看起来像故障的正确拒绝）。
//   路径解析：本文件在 src/aurabot/src/core/，出站口在 src/adapters/outbox.mjs
//   → ../../../adapters/outbox.mjs。aurabot 的 adapter 层早就在走同一条路
//   （src/aurabot/adapter/outbox-gateway.mjs → ../../adapters/outbox.mjs），
//   所以这不是新开的一条跨层通道，是把已有的那份名单**引用**过来。
//   ★ 无环：outbox 只 import ../events/envelope.mjs，而它只 import node:crypto。
//   ★ 判据：出站口把「要真发出去的东西」都收在 actions 里（它没有读通道）——
//     所以这张表就是写集合。读动作**不许**加进 ACT_ACTIONS，加了就变成「要过闸的写」。
import { OUTBOX_PORT } from '../../../adapters/outbox.mjs'

export const MODULE_ONEBOT_WRITE_ACTIONS = OUTBOX_PORT.actions

/**
 * 读名单：**逐字相等**登记的只读动作，冻结。
 *
 * ★ 每一条都在本仓有字面调用点（精确到文件:行，2026-11-24 盘点）：
 *   · 模块 facade 今天真的会走到的 11 个 ——
 *     get_login_info / get_stranger_info（features/qq-profile.js:72 / :58，profile 模块）、
 *     get_friend_list（modules/diary/index.js:54）、
 *     get_image（core/net.js:44，profile 与 stickers 的 segmentBytes 都落到这里）、
 *     get_group_msg_history / get_friend_msg_history（modules/qq-tools/index.js:22 / :23，
 *     后者还被 modules/voice/index.js:58 用）、
 *     get_doubt_friends_add_request（modules/contacts/index.js:101）、
 *     get_qzone_msg_list（features/qzone.js:110、features/qzone-social.js:94）、
 *     get_qzone_msg_detail（features/qzone-social.js:98 / :147）、
 *     get_qzone_feeds（features/qzone-social.js:132）、
 *     fetch_custom_face（features/stickers.js:258）。
 *   · 另外 8 个今天只在 host / hub 侧被调用（不经这道闸）：get_group_info /
 *     get_group_member_info / get_group_member_list / get_msg / get_record /
 *     get_forward_msg / fetch_ptt_text / fetch_sys_faces。
 *     ★ 为什么还是登记：名单是按**动作名**登记的，不是按 callsite。API.md 直接教模块
 *       作者用 api.onebot('get_msg', ...) 拿被引用那条消息；自己写的模块做常规读取
 *       （群资料 / 成员 / 聊天记录 / 语音转文字）也会用到这些名字。少登记一个，
 *       试运行里那条读就会被当成「未分类」拒掉 —— 那是把一个本来只读的失败，
 *       记到「写操作被拦」这个错误码上（同一个 code，reason 不同）。
 *     ★ 这**不是**能力授权：登记只说明「它是只读的」，不说明「谁可以调它」。
 *       真正的授权判据仍然在各模块 / Hub 里（主人、白名单、配置开关）。
 * ★ 顺序是接口的一部分（测试钉住）：新增名字**追加在末尾**，不重排已有的。
 * ★ 不做前缀猜：'get_group_ban_status' 这种长得像读的，仍然是未分类。
 */
export const MODULE_ONEBOT_READ_ACTIONS = Object.freeze([
  'get_login_info',
  'get_stranger_info',
  'get_group_info',
  'get_group_member_info',
  'get_group_member_list',
  'get_friend_list',
  'get_msg',
  'get_record',
  'get_forward_msg',
  'get_image',
  'get_group_msg_history',
  'get_friend_msg_history',
  'get_doubt_friends_add_request',
  'get_qzone_msg_list',
  'get_qzone_msg_detail',
  'get_qzone_feeds',
  'fetch_custom_face',
  'fetch_ptt_text',
  'fetch_sys_faces',
])

const WRITE_ACTIONS = new Set(MODULE_ONEBOT_WRITE_ACTIONS)
const READ_ACTIONS = new Set(MODULE_ONEBOT_READ_ACTIONS)

export function oneBotWriteBlockCode(config) {
  if (!config || !config.enabled) return 'disabled'
  if (config.dryRun) return 'dry-run'
  return null
}

export function createAvatarSyncHandler({ getConfig, readAvatar, onebot }) {
  if (typeof getConfig !== 'function') throw new TypeError('getConfig must be a function')
  if (typeof readAvatar !== 'function') throw new TypeError('readAvatar must be a function')
  if (!onebot || typeof onebot.call !== 'function') throw new TypeError('onebot.call must be a function')
  return async () => {
    const blocked = oneBotWriteBlockCode(getConfig())
    if (blocked) return { ok: false, code: blocked, message: blocked === 'dry-run' ? '试运行：未同步QQ头像' : '总开关关着，未同步QQ头像' }
    const buf = await readAvatar()
    try {
      await onebot.call('set_qq_avatar', { file: 'base64://' + buf.toString('base64') })
      return { ok: true, message: '已经设成机器人号的 QQ 头像' }
    } catch (error) {
      return { ok: false, message: 'QQ 头像没换成：' + error.message }
    }
  }
}

export function createModuleCoreFacade(core, getConfig) {
  if (!core || typeof core !== 'object') throw new TypeError('core must be an object')
  if (typeof getConfig !== 'function') throw new TypeError('getConfig must be a function')
  const client = core.onebot && typeof core.onebot === 'object' ? core.onebot : null
  const call = typeof client?.call === 'function' ? client.call.bind(client) : null
  const moduleOneBotCall = (action, params, opts) => Promise.resolve().then(() => {
    // ★ 只把「查表用的名字」规范化，action 本身原样往下一层传（出站口那一层是
    //   const name = text(action) —— text = String(...).trim()，见 adapter/outbox-gateway.mjs）。
    //   两边用同一把尺子：否则 ' upload_private_file ' 在这里查不到写动作、
    //   过了 enabled/dryRun 闸门，到了出站口却被 trim 成迁移后的白名单动作真发出去。
    const name = String(action == null ? '' : action).trim()
    // ★ 空动作名**所有模式**都拒：它不是「未分类」，是「压根没给名字」——
    //   往下传只会变成一个对根路径 / 空路径的请求，而错误会落在网关那边，
    //   看起来像网关的问题。
    if (!name) {
      const error = new Error('OneBot 动作名不能为空（空串 / 纯空白都不行）')
      error.code = 'onebot-action-invalid'
      error.stage = 'policy'
      throw error
    }
    const isWrite = WRITE_ACTIONS.has(name)
    // ★ 未分类 = 既不在写名单、也不在读名单。不猜前缀、不看大小写、不做别名。
    const isUnclassified = !isWrite && !READ_ACTIONS.has(name)
    if (isWrite || isUnclassified) {
      let blocked
      try { blocked = oneBotWriteBlockCode(getConfig()) }
      catch {
        // ★ 读不到总开关 = 判不了「现在能不能动」→ fail-closed。
        //   未分类的尤其不能往「大概是个读」上猜：那正是这道闸要挡的那一类。
        const error = new Error(isWrite ? '读取总开关失败，OneBot写操作已拒绝' : '读取总开关失败，未分类的OneBot动作已拒绝（判不了就不放行）')
        error.code = 'onebot-policy-config-failed'
        error.stage = 'policy'
        throw error
      }
      if (blocked) {
        if (isWrite) {
          const error = new Error('总开关已关闭或处于试运行，未执行OneBot写操作')
          error.code = 'onebot-write-blocked'
          error.reason = blocked
          error.stage = 'policy'
          throw error
        }
        // ★ 未分类走同一个 code（它确实「没执行」），但 reason 是 'unclassified' ——
        //   把「已知写被开关挡住」和「不知道它是什么所以挡住」分开记。
        //   message 里给出**下一步**：确认它是只读，就逐字登记，别猜前缀。
        const error = new Error('未分类的OneBot动作「' + name + '」在总开关关闭或试运行下不执行；确认它是只读动作，请把动作名逐字登记到 module-onebot-policy 的 MODULE_ONEBOT_READ_ACTIONS')
        error.code = 'onebot-write-blocked'
        error.reason = 'unclassified'
        error.stage = 'policy'
        throw error
      }
    }
    // ★ 读动作直接落到这里：不看总开关、不看 dryRun（它们不产生任何出站写），
    //   但 client 不在时报的仍然是 onebot-unavailable —— 读也需要一条路。
    if (!call) {
      const error = new Error('OneBot 客户端不可用')
      error.code = 'onebot-unavailable'
      error.stage = 'adapter'
      throw error
    }
    return call(action, params, opts)
  })
  const onebot = Object.freeze(Object.defineProperties({}, {
    call: { value: moduleOneBotCall, enumerable: true },
    state: { get: () => client?.state ?? 'disconnected', enumerable: true },
  }))
  const moduleCore = { ...core }
  Object.defineProperty(moduleCore, 'onebot', { value: onebot, enumerable: true, writable: false, configurable: false })
  return { core: moduleCore, onebot, call: moduleOneBotCall }
}
