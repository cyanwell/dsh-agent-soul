// 内置模块：群管。主人开口时禁言、解禁、踢人、改头衔、发公告；她知道自己在每个群是什么身份。

import { defineTool, str, int } from '../../tools/tools.js'

export default {
  id: 'group-admin',
  name: '群管',
  version: '1.0.0',
  description: '主人要求时禁言 / 解禁 / 踢人 / 改头衔 / 发公告（qq_group_admin）；告诉她自己在群里有没有管理权限',
  setup(api) {
    const { hub, onebot, groupRoles } = api.core

    // 她在这个群的身份：没管理权限就别答应禁言踢人
    api.context(({ chat }) => {
      if (chat.kind !== 'group') return ''
      const role = groupRoles.peek(chat.groupId)
      if (!role) return ''
      return groupRoles.canManage(role) ? `你在这个群是${groupRoles.label(role)}，主人要求时可以用群管工具。` : '你在这个群只是普通成员，没有管理权限：禁言、踢人这些做不了，主人要求时直接说明。'
    })

    // 工具层校验：这一轮说话的人里要有主人
    api.tool(({ chat, level, sessionId }) => {
      if (!(chat.kind === 'group' || level === 'full')) return []
      return defineTool({
        name: 'qq_group_admin',
        description: '群管理：禁言 / 解禁 / 踢人 / 改头衔 / 发群公告。只有主人要求时才能用；别人要求会被系统拒绝。',
        properties: {
          action: { type: 'string', enum: ['ban', 'unban', 'kick', 'title', 'notice'], description: 'ban 禁言，unban 解禁，kick 踢出，title 改专属头衔，notice 发公告' },
          group_id: str('群号；在群里用时可省略，默认当前群'),
          user_id: str('对象 QQ 号（notice 不需要）'),
          minutes: int('禁言分钟数，默认 10'),
          text: str('头衔内容或公告内容'),
        },
        required: ['action'],
        execute: async ({ action, group_id, user_id, minutes, text }) => {
          // 这一轮里主人说过话才行；群里别人顺带插话不影响，但谁都不能拿群管对付主人
          if (!hub.turnHasOwner(sessionId)) return { ok: false, message: '只有主人能让我做群管操作' }
          const cfg = api.config()
          const gid = Number(group_id || (chat.kind === 'group' ? chat.groupId : 0))
          if (!gid) return { ok: false, message: '不知道是哪个群' }
          if (!cfg.allow.groups.includes(String(gid))) return { ok: false, message: '这个群不在白名单里' }
          const uid = Number(user_id || 0)
          if (action !== 'notice' && !uid) return { ok: false, message: '要说清楚对谁（QQ 号）' }
          if (uid && String(uid) === String(cfg.ownerQQ) && action !== 'unban' && action !== 'title') return { ok: false, message: '不能对主人做这个' }
          const role = await groupRoles.get(gid, { fresh: true })
          if (role && !groupRoles.canManage(role)) return { ok: false, message: '我在这个群只是普通成员，没有管理权限' }
          if (role === 'admin' && action === 'title') return { ok: false, message: '改专属头衔要群主才行，我只是管理员' }
          if (cfg.dryRun) return { ok: true, message: `试运行：本来要对群 ${gid} 做 ${action}` }
          switch (action) {
            case 'ban': await onebot.call('set_group_ban', { group_id: gid, user_id: uid, duration: Math.max(1, Number(minutes) || 10) * 60 }); break
            case 'unban': await onebot.call('set_group_ban', { group_id: gid, user_id: uid, duration: 0 }); break
            case 'kick': await onebot.call('set_group_kick', { group_id: gid, user_id: uid, reject_add_request: false }); break
            case 'title': await onebot.call('set_group_special_title', { group_id: gid, user_id: uid, special_title: String(text || '') }); break
            case 'notice': await onebot.call('_send_group_notice', { group_id: gid, content: String(text || '') }); break
            default: return { ok: false, message: '不认识的操作' }
          }
          return { ok: true, message: '做好了' }
        },
      })
    })

    api.route('/groups/roles', async () => {
      const cfg = api.config()
      const list = await Promise.all(cfg.allow.groups.map(async (gid) => {
        const role = await groupRoles.get(gid, { fresh: true })
        return { groupId: gid, name: await hub.groupName(String(gid)), role, label: role ? groupRoles.label(role) : '查不到（她在群里吗？）', canManage: groupRoles.canManage(role) }
      }))
      return { ok: true, list }
    })
    return {}
  },
}
