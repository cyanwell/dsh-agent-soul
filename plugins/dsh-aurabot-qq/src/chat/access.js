// 谁能跟她说话、她在每个会话里有多大权限。纯函数。

/** 权限档位：full = DSH 完整工具；social = 只有 QQ 社交工具；chat = 纯聊天，没有工具。 */
export const LEVELS = ['full', 'social', 'chat']

/**
 * @param {object} cfg 插件配置
 * @param {{kind:'private'|'group', userId:string, groupId:string}} msg
 * @returns {{allowed: boolean, reason: string}}
 */
export function checkAllowed(cfg, msg) {
  const owner = String(cfg.ownerQQ || '')
  if (msg.kind === 'private') {
    if (msg.userId === owner) return { allowed: true, reason: '主人' }
    const list = (cfg.allow?.private || []).map(String)
    return list.includes(msg.userId)
      ? { allowed: true, reason: '私聊白名单' }
      : { allowed: false, reason: '不在私聊白名单' }
  }
  const groups = (cfg.allow?.groups || []).map(String)
  return groups.includes(msg.groupId)
    ? { allowed: true, reason: '群白名单' }
    : { allowed: false, reason: '不在群白名单' }
}

/** 这个会话用哪一档权限。群聊永远不超过 social。 */
export function levelFor(cfg, chat) {
  const owner = String(cfg.ownerQQ || '')
  if (chat.kind === 'private' && chat.userId === owner) {
    return LEVELS.includes(cfg.ownerLevel) ? cfg.ownerLevel : 'full'
  }
  return 'social'
}

/**
 * 档位 → agent preset id。
 *
 * 砚青改造（2026-11-05）：默认指向砚青的两个 preset（同一个我，按档位收放本地能力）。
 * ★ 这两个 preset 不在本插件里，需要由 agent-soul 那一侧提供；没有的话会在转进 DSH 时报
 *   `Unknown agent preset: yanqing-qq`。所以 preset 名一律可从 config.presets 覆盖：
 *     "presets": { "private": "aurabot-private", "social": "aurabot-social" }
 *   后两个是插件自带的（见 cordis.patch.yml），装完即用。
 */
export function presetFor(level, cfg) {
  const p = (cfg && cfg.presets) || {}
  // 群聊/陌生人私聊：不给本地能力
  if (level !== 'full') return p.social || 'yanqing-qq-social'
  // 主人私聊：本体（同源人格 / 工具 / 带门牌压缩）
  return p.private || 'yanqing-qq'
}

/** 只有主人能做的事（群管、点歌、写文件……）。 */
export function isOwner(cfg, userId) {
  return String(userId || '') !== '' && String(userId) === String(cfg.ownerQQ || '')
}

/** 改资料类操作（改昵称 / 签名 / 头像、改 B 站签名），以及处理好友申请、改白名单的三档权限。 */
export const PROFILE_PERM_LEVELS = ['off', 'owner', 'all']
export const DOUYIN_PERM_KEYS = ['douyinBrowse', 'douyinLike', 'douyinComment', 'douyinShareOwner', 'douyinDm']
export const PROFILE_PERM_KEYS = ['qqNickname', 'qqSignature', 'qqAvatar', 'biliSign', 'biliAvatar', 'qqFriendRequest', 'whitelist', ...DOUYIN_PERM_KEYS]
/** 没设过的档位：一律默认仅主人（含抖音浏览/互动/改资料项；用户要放开自己在面板开）。 */
export const profilePermDefault = (key) => 'owner'
export const permOf = (cfg, key) => {
  const p = cfg?.profilePerms?.[key]
  return PROFILE_PERM_LEVELS.includes(p) ? p : profilePermDefault(key)
}

/** 这一档在这个会话里要不要挂工具。owner = 只在主人私聊里挂；all = 哪都挂；off = 不挂。 */
export function profileToolVisible(cfg, key, chat) {
  const p = permOf(cfg, key)
  if (p === 'all') return chat.kind === 'private' || chat.kind === 'group'
  if (p === 'owner') return chat.kind === 'private' && String(chat.userId) === String(cfg.ownerQQ || '')
  return false
}

/** 执行时再查一遍（面板可能刚改过）。allOwner = 这一轮说话的人全是主人。 */
export function profilePermits(cfg, key, chat, allOwner) {
  const p = permOf(cfg, key)
  if (p === 'off') return { ok: false, message: '这个操作在面板里关掉了' }
  if (!profileToolVisible(cfg, key, chat)) return { ok: false, message: '这里不能做这个操作' }
  if (p === 'owner' && !allOwner) return { ok: false, message: '只有主人私聊让我改才行' }
  return { ok: true }
}
