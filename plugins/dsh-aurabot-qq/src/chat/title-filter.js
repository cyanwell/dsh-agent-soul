// 按群头衔不回：在勾选的群里，专属头衔正好是某个词（默认「大肥鱼」）的成员说话、戳她，她都不理。
// 用途：同一个群里有好几个 Aurabot 时，给其他机器人挂上这个头衔，免得机器人之间互相接话、刷屏停不下来。
// 思路来自社区贡献的「群头衔回复过滤」扩展，这里做进聊天中枢。
//
// 头衔优先用消息事件里带的 sender.title；没带就查一次群成员信息（缓存 60 秒）。
// 查询出错时这条先不回（缓存 5 秒）：宁可漏回一条，也别让两个机器人对上。接口压根不返回头衔字段，就当没有头衔。

const OK_TTL = 60_000
const ERR_TTL = 5_000

export const normTitle = (v) => String(v ?? '').replace(/[​-‍﻿]/g, '').trim().normalize('NFC')

export function createTitleFilter({ getConfig, onebot, log, now = Date.now }) {
  const cache = new Map() // `${gid}:${uid}` → { title, at, error }
  const pending = new Map()
  let blocked = 0

  const rule = () => getConfig().titleFilter || {}
  const applies = (gid) => {
    const r = rule()
    return Boolean(r.enabled && normTitle(r.title) && (r.groups || []).map(String).includes(String(gid)))
  }

  async function titleOf(gid, uid, sender) {
    const key = gid + ':' + uid
    const own = normTitle(sender?.title)
    if (own) { cache.set(key, { title: own, at: now() }); return own }
    const hit = cache.get(key)
    if (hit && now() - hit.at < (hit.error ? ERR_TTL : OK_TTL)) {
      if (hit.error) throw new Error('头衔暂时查不到')
      return hit.title
    }
    if (pending.has(key)) return pending.get(key)
    const task = Promise.resolve(onebot.call('get_group_member_info', { group_id: Number(gid), user_id: Number(uid), no_cache: true }, { timeoutMs: 5000, retries: 0 }))
      .then((row) => {
        const title = normTitle(row?.title)
        if (cache.size > 3000) cache.clear()
        cache.set(key, { title, at: now() })
        return title
      })
      .catch((error) => { cache.set(key, { at: now(), error: true }); throw error })
      .finally(() => pending.delete(key))
    pending.set(key, task)
    return task
  }

  /** 这条群消息 / 戳一戳要不要直接忽略。event 是 OneBot 原始事件。 */
  async function shouldIgnore(event) {
    const gid = String(event?.group_id || '')
    const uid = String(event?.user_id ?? event?.sender?.user_id ?? '')
    if (!gid || !/^\d+$/.test(uid) || !applies(gid)) return false
    try {
      const title = await titleOf(gid, uid, event.sender)
      if (!title || title !== normTitle(rule().title)) return false
      blocked++
      log?.debug?.(`群 ${gid}：${uid} 的头衔是「${title}」，按头衔过滤不回`)
      return true
    } catch (error) {
      blocked++
      log?.warn?.(`群 ${gid}：查不到 ${uid} 的头衔（${error.message}），这条先不回`)
      return true
    }
  }

  /** 白名单群里现有的头衔：[{ title, count, members: [{ id, name }] }]，按人数从多到少。面板「拉取头衔」用。 */
  async function titlesIn(groupIds) {
    const byTitle = new Map()
    const failed = []
    for (const gid of groupIds) {
      let rows
      try { rows = await onebot.call('get_group_member_list', { group_id: Number(gid), no_cache: true }, { timeoutMs: 15000 }) } catch (error) { failed.push(String(gid)); continue }
      for (const m of Array.isArray(rows) ? rows : []) {
        const title = normTitle(m.title)
        if (!title) continue
        const row = byTitle.get(title) || { title, count: 0, members: [] }
        row.count++
        if (row.members.length < 20) row.members.push({ id: String(m.user_id), name: String(m.card || m.nickname || m.user_id), groupId: String(gid) })
        byTitle.set(title, row)
      }
    }
    return { titles: [...byTitle.values()].sort((a, b) => b.count - a.count), failed }
  }

  return { shouldIgnore, titlesIn, clear: () => cache.clear(), stats: () => ({ blocked }) }
}
