// 内置模块：好友申请与白名单。
//  · qq_handle_friend_request：通过 / 拒绝别人加她为好友的申请（SnowLuma：set_friend_add_request；被 QQ 过滤的「可能认识的人」走 set_doubt_friends_add_request）。
//  · qq_whitelist：听主人的话把 QQ 号 / 群号加进、移出白名单（allow.private / allow.groups），写进配置并保存。
// 「她主动加别人为好友」没做：SnowLuma（v2.2.0）没有这个接口，维护者明确说公开版不会加（SnowLuma#480）。
// 两个工具各一档权限（面板「权限」页）：off 关 / owner 仅主人私聊（默认）/ all 所有人。

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { defineTool, str, bool } from '../../tools/tools.js'
import { profileToolVisible, profilePermits } from '../../chat/access.js'

const PENDING_MAX = 50
const ID_RE = /^\d{5,12}$/

/** 取纯数字号码；不像 QQ 号 / 群号的返回空串。 */
export function cleanId(v) {
  const s = String(v ?? '').replace(/\D/g, '')
  return ID_RE.test(s) ? s : ''
}

/** 白名单增删的纯逻辑：返回 { ok, message, next? }。next = 改完后的这张表（没变化时不给）。 */
export function planWhitelist(cfg, { action, kind, id }) {
  const act = String(action || '').trim().toLowerCase()
  if (!['add', 'remove'].includes(act)) return { ok: false, message: 'action 只能是 add 或 remove' }
  const k = String(kind || '').trim().toLowerCase()
  if (!['private', 'group'].includes(k)) return { ok: false, message: 'kind 只能是 private（私聊的人）或 group（群）' }
  const n = cleanId(id)
  if (!n) return { ok: false, message: '号码不对：要 5~12 位数字的 QQ 号 / 群号' }
  const label = k === 'private' ? 'QQ' : '群'
  const listName = k === 'private' ? '私聊白名单' : '群白名单'
  if (k === 'private' && n === String(cfg.ownerQQ || '')) {
    return act === 'remove'
      ? { ok: false, message: '主人不能被移出私聊白名单' }
      : { ok: true, message: '主人本来就能私聊，不用加白名单' }
  }
  if (k === 'private' && act === 'add' && n === String(cfg.botQQ || '')) return { ok: false, message: '这是我自己的号，不用加' }
  const list = (k === 'private' ? cfg.allow?.private : cfg.allow?.groups) || []
  const has = list.map(String).includes(n)
  if (act === 'add') {
    if (has) return { ok: true, message: `${label} ${n} 已经在${listName}里了` }
    return { ok: true, changed: true, message: `${label} ${n} 加进${listName}了`, next: [...list.map(String), n] }
  }
  if (!has) return { ok: true, message: `${label} ${n} 本来就不在${listName}里` }
  return { ok: true, changed: true, message: `${label} ${n} 从${listName}移出了`, next: list.map(String).filter((x) => x !== n) }
}

export default {
  id: 'contacts',
  name: '好友申请与白名单',
  version: '1.0.0',
  description: '听话通过 / 拒绝别人加她为好友的申请（qq_handle_friend_request）、改私聊 / 群白名单（qq_whitelist）；权限在「权限」页',
  setup(api) {
    const { hub, onebot } = api.core
    const pendingFile = () => api.dataDir('friend-requests.json')

    const loadPending = () => {
      try {
        const f = pendingFile()
        if (!existsSync(f)) return []
        const j = JSON.parse(readFileSync(f, 'utf8'))
        return Array.isArray(j) ? j.filter((x) => x && x.flag && x.userId) : []
      } catch (error) { return [] }
    }
    const savePending = (list) => {
      try { writeFileSync(pendingFile(), JSON.stringify(list.slice(-PENDING_MAX))) } catch (error) { api.log.warn('存好友申请出错：', error.message) }
    }

    // 好友申请事件：只记下来（flag 必须原样用，不能自己拼），再给主人提一句
    api.on('onebot', (ev) => {
      if (!ev || ev.post_type !== 'request' || ev.request_type !== 'friend' || !ev.flag) return
      const userId = String(ev.user_id || '')
      if (!userId) return
      const list = loadPending()
      const isNew = !list.some((x) => x.flag === String(ev.flag))
      if (isNew) {
        list.push({ flag: String(ev.flag), userId, comment: String(ev.comment || '').slice(0, 80), at: Date.now() })
        savePending(list)
      }
      const cfg = api.config()
      if (isNew && cfg.ownerQQ && (cfg.profilePerms?.qqFriendRequest || 'owner') !== 'off') {
        const note = ev.comment ? `，验证消息：「${String(ev.comment).slice(0, 80)}」` : ''
        api.sendText(`private:${cfg.ownerQQ}`, `有人想加我好友：QQ ${userId}${note}。要通过就跟我说「通过 ${userId}」，不想加说「拒绝 ${userId}」。`).catch(() => {})
      }
    })

    const guarded = (key, chat, sessionId, run) => async (args) => {
      const cfg = api.config()
      const p = profilePermits(cfg, key, chat, hub.turnSendersAllOwner(sessionId))
      if (!p.ok) return p
      return run(args, cfg)
    }

    /** 找要处理的那条申请：先看收到过的事件，再看 QQ 过滤掉的「可能认识的人」。 */
    async function findRequest(qq) {
      const pending = loadPending()
      const hit = qq ? pending.find((x) => x.userId === qq) : (pending.length === 1 ? pending[0] : null)
      if (hit) return { ok: true, via: 'event', flag: hit.flag, userId: hit.userId }
      if (!qq && pending.length > 1) {
        return { ok: false, message: `有 ${pending.length} 个待处理的申请：${pending.map((x) => x.userId).join('、')}。说清楚是哪个 QQ 号` }
      }
      let doubt = []
      try { doubt = (await onebot.call('get_doubt_friends_add_request', { count: 50 }, { timeoutMs: 15000 })) || [] } catch (error) { doubt = [] }
      if (!Array.isArray(doubt)) doubt = []
      const d = qq ? doubt.find((x) => String(x.user_id) === qq) : (doubt.length === 1 ? doubt[0] : null)
      if (d && d.uid) return { ok: true, via: 'doubt', flag: String(d.uid), userId: String(d.user_id || qq || '') }
      if (!qq && doubt.length > 1) return { ok: false, message: `有 ${doubt.length} 个被 QQ 过滤的申请：${doubt.map((x) => x.user_id).join('、')}。说清楚是哪个 QQ 号` }
      return { ok: false, message: qq ? `没找到 QQ ${qq} 的好友申请（没收到过，QQ 过滤的列表里也没有）` : '现在没有待处理的好友申请' }
    }

    api.tool(({ chat, sessionId }) => {
      if (chat.kind !== 'private' && chat.kind !== 'group') return []
      const cfg = api.config()
      const tools = []
      if (profileToolVisible(cfg, 'qqFriendRequest', chat)) tools.push(defineTool({
        name: 'qq_handle_friend_request',
        description: '通过或拒绝别人加你为好友的申请。qq 填申请人的 QQ 号（只有一个待处理申请时可不填）；approve 填 true 通过、false 拒绝。你不能主动加别人为好友。',
        properties: { qq: str('申请人的 QQ 号，可不填'), approve: bool('true 通过，false 拒绝') },
        required: ['approve'],
        execute: guarded('qqFriendRequest', chat, sessionId, async ({ qq, approve }, c) => {
          if (typeof approve !== 'boolean') return { ok: false, message: 'approve 要写 true（通过）或 false（拒绝）' }
          const want = String(qq ?? '').trim() ? cleanId(qq) : ''
          if (String(qq ?? '').trim() && !want) return { ok: false, message: 'QQ 号不对：要 5~12 位数字' }
          const req = await findRequest(want)
          if (!req.ok) return req
          const verb = approve ? '通过' : '拒绝'
          if (c.dryRun) return { ok: true, message: `试运行：本来要${verb} QQ ${req.userId} 的好友申请` }
          try {
            if (req.via === 'event') await onebot.call('set_friend_add_request', { flag: req.flag, approve }, { timeoutMs: 15000 })
            else await onebot.call('set_doubt_friends_add_request', { flag: req.flag, approve }, { timeoutMs: 15000 })
          } catch (error) {
            return { ok: false, message: `${verb} QQ ${req.userId} 的好友申请没成功：${error.message}` }
          }
          savePending(loadPending().filter((x) => x.flag !== req.flag && x.userId !== req.userId))
          return { ok: true, message: `已${verb} QQ ${req.userId} 的好友申请` }
        }),
      }))
      if (profileToolVisible(cfg, 'whitelist', chat)) tools.push(defineTool({
        name: 'qq_whitelist',
        description: '改白名单：action 填 add（加进）或 remove（移出），kind 填 private（某个 QQ 号可以私聊你）或 group（某个群你会理），id 填 QQ 号或群号。主人不能被移出。',
        properties: { action: str('add 加进 / remove 移出'), kind: str('private 私聊的人 / group 群'), id: str('QQ 号或群号（数字）') },
        required: ['action', 'kind', 'id'],
        execute: guarded('whitelist', chat, sessionId, async (args, c) => {
          const plan = planWhitelist(c, args)
          if (!plan.ok || !plan.changed) return plan
          if (c.dryRun) return { ok: true, message: `试运行：本来要${plan.message}` }
          const key = String(args.kind).trim().toLowerCase() === 'private' ? 'private' : 'groups'
          // 用保存那一刻最新的配置再算一遍，免得盖掉面板刚改的
          let result = plan
          api.setConfig((cur) => {
            result = planWhitelist(cur, args)
            if (!result.ok || !result.changed) return cur
            return { ...cur, allow: { ...cur.allow, [key]: result.next } }
          })
          return { ok: result.ok, message: result.message }
        }),
      }))
      return tools
    })
    return {}
  },
}
