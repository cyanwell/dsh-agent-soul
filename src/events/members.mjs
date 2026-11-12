// events · members —— 群里「名字 → QQ 号」，给 <at:名字> 用
// ============================================================================
// 为什么需要：会话回复里会写 <at:某人>（agent 侧约定允许写名字），
//   而 OneBot 的 @ 段只认 QQ 号。v4 没有群成员表，只能现查。
//
// ★ 三条取舍：
//   ① **必须缓存**。一条消息里有几个名字就要查几次，而 get_group_member_list
//      一次拉几百人（300ms-2s）。不缓存的话每条消息都要付这个钱。
//      默认 10 分钟 —— 群成员变动没那么快，漏判的代价是「这次没 @ 成」，不是错 @。
//   ② **只做精确匹配 + 唯一前缀匹配**，绝不做模糊匹配。
//      张冠李戴地 @ 错人在群里是可见事故，比不 @ 糟得多。
//   ③ **查不到就说查不到**（返回 null），不返回「最像的那个」。
// ============================================================================

const DEFAULT_TTL_MS = 10 * 60 * 1000
const DEFAULT_TIMEOUT_MS = 8000

function fail (code, error, extra) {
  return { ok: false, code, error: String(error == null ? '' : error).slice(0, 300), ...(extra || {}) }
}

/**
 * createMemberResolver({ httpUrl, token, log, ttlMs, timeoutMs })
 *   → { resolve(groupId, name), view() }
 *
 * httpUrl 例：http://127.0.0.1:3002（砚青号的 OneBot HTTP）
 */
export function createMemberResolver (opts = {}) {
  const httpUrl = String(opts.httpUrl || '').trim().replace(/\/+$/, '')
  const token = String(opts.token || '').trim()
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const ttlMs = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : DEFAULT_TTL_MS
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : (url, init) => globalThis.fetch(url, init)

  const cache = new Map() // groupId → { at, members: [{ qq, card, nick }] }
  const counters = { fetches: 0, hits: 0, failures: 0, lastAt: null, lastError: null }

  async function loadMembers (groupId) {
    const key = String(groupId)
    const hit = cache.get(key)
    if (hit && now() - hit.at < ttlMs) { counters.hits += 1; return hit.members }
    if (!httpUrl) throw new Error('没有配置 OneBot httpUrl')

    const ctrl = new AbortController()
    const timer = setTimeout(() => { try { ctrl.abort() } catch { /* 已结束 */ } }, timeoutMs)
    counters.fetches += 1
    counters.lastAt = new Date(now()).toISOString()
    let res
    try {
      const init = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ group_id: Number(groupId) }),
        signal: ctrl.signal,
      }
      if (token) init.headers.authorization = 'Bearer ' + token
      res = await fetchImpl(httpUrl + '/get_group_member_list', init)
    } catch (e) {
      counters.failures += 1
      counters.lastError = String((e && e.message) || e)
      throw new Error('拉群成员失败：' + counters.lastError)
    } finally {
      clearTimeout(timer)
    }
    if (!res || !res.ok) {
      counters.failures += 1
      counters.lastError = 'HTTP ' + (res && res.status)
      throw new Error('拉群成员失败：' + counters.lastError)
    }
    let body = null
    try { body = await res.json() } catch { body = null }
    const list = body && Array.isArray(body.data) ? body.data : null
    if (!list) {
      counters.failures += 1
      counters.lastError = '返回里没有 data 数组'
      throw new Error(counters.lastError)
    }
    const members = list
      .map((m) => ({
        qq: String((m && m.user_id) == null ? '' : m.user_id),
        card: String((m && m.card) || '').trim(),
        nick: String((m && m.nickname) || '').trim(),
      }))
      .filter((m) => /^\d{5,12}$/.test(m.qq))
    cache.set(key, { at: now(), members })
    log('[members] ' + key + ' 拉了 ' + members.length + ' 人')
    return members
  }

  /**
   * 名字 → QQ 号。查不到返回 null（**绝不返回最像的那个**）。
   * ★ 精确匹配优先（群名片 / 昵称逐字相等），其次唯一前缀（「小绪」→「小绪绪」only if 唯一）。
   */
  async function resolve (groupId, name) {
    const want = String(name == null ? '' : name).trim().replace(/^@/, '')
    if (!want) return null
    const members = await loadMembers(groupId)
    const exact = members.filter((m) => m.card === want || m.nick === want)
    if (exact.length === 1) return exact[0].qq
    if (exact.length > 1) return null // 同名多人：不猜
    const prefix = members.filter((m) => (m.card && m.card.startsWith(want)) || (m.nick && m.nick.startsWith(want)))
    if (prefix.length === 1) return prefix[0].qq
    return null
  }

  return {
    resolve,
    /** 给 format.resolveMentions 直接用的形态：绑好 groupId。 */
    forGroup (groupId) { return (name) => resolve(groupId, name) },
    clear () { cache.clear() },
    view () {
      return {
        hasHttpUrl: Boolean(httpUrl),
        cachedGroups: cache.size,
        members: [...cache.entries()].map(([g, v]) => ({ groupId: g, count: v.members.length, ageMs: now() - v.at })),
        fetches: counters.fetches,
        hits: counters.hits,
        failures: counters.failures,
        lastAt: counters.lastAt,
        lastError: counters.lastError,
        ttlMs,
      }
    },
  }
}

/** 从 chatId 里取群号：group:661580035 → 661580035；私聊返回空。 */
export function groupIdOf (chatId) {
  const m = /^group:(\d+)$/.exec(String(chatId == null ? '' : chatId).trim())
  return m ? m[1] : ''
}
