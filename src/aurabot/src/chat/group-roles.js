// 她在每个群里的身份（群主 / 管理员 / 普通成员）：决定能不能做群管。查一次缓存 10 分钟。

const TTL = 10 * 60_000
export const ROLE_LABEL = { owner: '群主', admin: '管理员', member: '普通成员' }

export function createGroupRoles({ onebot, getConfig, log }) {
  const cache = new Map() // groupId → { role, at }
  const inflight = new Map()

  async function fetchRole(gid, fresh) {
    try {
      const r = await onebot.call('get_group_member_info', { group_id: Number(gid), user_id: Number(getConfig().botQQ), no_cache: true }, { timeoutMs: 8000 })
      const role = ['owner', 'admin', 'member'].includes(r && r.role) ? r.role : 'member'
      cache.set(String(gid), { role, at: Date.now() })
      return role
    } catch (error) {
      log?.debug(`查群 ${gid} 里的身份失败：`, error.message)
      // ★ 真查失败 = 这一轮**不知道**她是什么身份。
      //   fresh（群管动作前的那一次确认）**绝不**拿旧缓存兜底：缓存里的 admin
      //   可能几分钟前就被撤了，而「查失败」被当成「查到了 admin」会让她真的去
      //   改头衔、发公告。宁可拒，不可猜 —— 所以 fresh 失败一律返回 ''（不知道）。
      //   非 fresh（上下文 / 面板的后台刷新）才允许退回上一次的值：那时它只是描述，
      //   不拿来做「能不能动手」的判断。
      if (fresh) return ''
      const c = cache.get(String(gid))
      return c ? c.role : ''
    }
  }

  /** 查身份（会等结果）。查不到返回 ''。★ fresh 时查失败也返回 ''，不回落缓存。 */
  async function get(gid, { fresh = false } = {}) {
    const c = cache.get(String(gid))
    if (!fresh && c && Date.now() - c.at < TTL) return c.role
    // ★ fresh 与非 fresh 分开排队：共用在途请求会让 fresh 调用等来一个「更早发出、
    //   失败时可能回落到缓存」的答案 —— 那就等于没有 fresh。
    const key = String(gid) + (fresh ? '#fresh' : '')
    if (!inflight.has(key)) {
      inflight.set(key, fetchRole(gid, fresh).finally(() => inflight.delete(key)))
    }
    return inflight.get(key)
  }

  /** 同步拿缓存（给每轮上下文用），过期就顺手在后台刷新。 */
  function peek(gid) {
    const c = cache.get(String(gid))
    if (!c || Date.now() - c.at >= TTL) get(gid).catch(() => {})
    return c ? c.role : ''
  }

  const canManage = (role) => role === 'owner' || role === 'admin'

  return { get, peek, canManage, label: (role) => ROLE_LABEL[role] || '不清楚' }
}
