// 索引记忆库：本地 JSON 存储 + 倒排索引（中文按二元字组切词，英文数字按词）+ BM25 打分，
// 再叠加「关于当前说话人」「重要程度」「新近程度」的加权。不依赖外部向量库，几千条也是毫秒级。
//
// 记忆来源：她自己调 remember 工具记的、后台从聊天里自动提炼的、主人在面板里手动加的。
// 召回时机：每一轮回复前，用「这一轮对方说的话」（太短就连上一句）检索最相关的几条，作为上下文悄悄告诉她。
//
// 借鉴的做法：
// - 遗忘曲线（MemoryBank）：记得多牢按「多久没想起 + 被想起过几天 + 重要程度」算，常聊到的忘得慢。
// - 整理时先比对旧记忆（Mem0）：新事实是新增、补充旧的，还是说明旧的过时了。
// - 过时不删（Graphiti）：旧记忆标成「已过时」，不再被想起，但留着历史、面板里能恢复。
// - 常驻的人物小档案（Letta 的 memory block）：每个人一小段印象，聊天时一直带着，不靠关键词碰运气。

import { randomUUID } from 'node:crypto'
import { dataDir, readJson, writeJson } from '../core/store.js'
import { askModel } from '../core/llm.js'

// ---------------- 纯函数：切词与打分 ----------------

const STOP = new Set('的了是我你他她它们在有和就不也都很吗吧呢啊呀哦嗯这那个一上下来去说要会能着过'.split(''))

/** 切词：英文/数字整词；中文连续段拆成二元字组（单字段保留单字，去掉停用字）。 */
export function tokenize(text) {
  const out = []
  const s = String(text || '').toLowerCase()
  for (const m of s.matchAll(/[a-z0-9_]{2,}|[一-鿿]+/g)) {
    const w = m[0]
    if (/^[a-z0-9_]+$/.test(w)) { out.push(w); continue }
    if (w.length === 1) { if (!STOP.has(w)) out.push(w); continue }
    for (let i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2))
  }
  return out
}

/** 两段文字有多像（字组 Jaccard），用于去重。 */
export function similarity(a, b) {
  const A = new Set(tokenize(a))
  const B = new Set(tokenize(b))
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  return inter / (A.size + B.size - inter)
}

/** 建索引：返回 { docs, df, avgLen }。 */
export function buildIndex(items) {
  const df = new Map()
  const docs = items.map((it) => {
    const toks = tokenize(`${it.text} ${(it.tags || []).join(' ')} ${it.aboutName || ''}`)
    const tf = new Map()
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1)
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1)
    return { it, tf, len: toks.length || 1 }
  })
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / (docs.length || 1)
  return { docs, df, avgLen, N: docs.length }
}

/**
 * 检索。
 * @param idx buildIndex() 的结果
 * @param {string} query
 * @param {{about?:string|string[], now?:number, limit?:number, minScore?:number, includeInvalid?:boolean}} [o]
 *   about：关于这些人（QQ 号）的记忆加分；群里可以传这一段里所有说话的人
 */
export function search(idx, query, o = {}) {
  const q = [...new Set(tokenize(query))]
  const now = o.now ?? Date.now()
  const aboutSet = new Set((Array.isArray(o.about) ? o.about : o.about ? [o.about] : []).map(String))
  const k1 = 1.4
  const b = 0.7
  const scored = []
  for (const d of idx.docs) {
    let s = 0
    const why = []
    for (const t of q) {
      const f = d.tf.get(t)
      if (!f) continue
      const n = idx.df.get(t) || 0
      const idf = Math.log(1 + (idx.N - n + 0.5) / (n + 0.5))
      const part = idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / idx.avgLen))
      s += part
      why.push([t, part])
    }
    const it = d.it
    if (it.invalidAt && !o.includeInvalid) continue
    const aboutHit = Boolean(it.about) && aboutSet.has(String(it.about))
    if (s <= 0 && !aboutHit) continue
    const importance = 0.6 + 0.8 * (Number(it.importance) || 0.5)
    const score = (s + (aboutHit ? 0.8 : 0)) * importance * (0.55 + 0.45 * retention(it, now))
    scored.push({ it, score, why: why.sort((x, y) => y[1] - x[1]).slice(0, 3).map((w) => w[0]).concat(aboutHit ? ['（关于这个人）'] : []) })
  }
  scored.sort((x, y) => y.score - x.score)
  return scored.filter((x) => x.score >= (o.minScore ?? 0.35)).slice(0, o.limit ?? 6)
}

/** 「刚才」「3 小时前」「昨天」这样的说法。 */
export function agoText(at, now = Date.now()) {
  const m = Math.max(0, Math.round((now - at) / 60000))
  if (m < 30) return '刚才'
  if (m < 60 * 20) return `${Math.max(1, Math.round(m / 60))} 小时前`
  return '昨天'
}

/** 一条记忆是什么时候的：今天 / 昨天 / 3 天前 / 09-17 / 去年 03-02 / 2024-05-01。 */
export function whenText(at, now = Date.now()) {
  if (!at) return ''
  const d = new Date(at)
  const n = new Date(now)
  const day0 = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((day0(n) - day0(d)) / 86400_000)
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  if (d.getFullYear() === n.getFullYear()) return md
  if (d.getFullYear() === n.getFullYear() - 1) return '去年 ' + md
  return `${d.getFullYear()}-${md}`
}

/** 想起来的一条记忆怎么写给她：[什么时候] [关于谁] 内容。 */
export function memoryLine(it, now = Date.now()) {
  return `[${whenText(it.at, now)}] ` + (it.aboutName ? `[${it.aboutName}] ` : '') + it.text
}

/**
 * 该不该忘掉：每日整理自动提炼出来的、不太重要、已经淡了的（见 retention），忘掉。
 * 她自己记的、你加的、经历和日记不自动忘。
 */
export function shouldForget(m, now = Date.now()) {
  // 过时的留半年（面板里能看到、能恢复），之后清掉
  if (m.invalidAt) return now - m.invalidAt > 180 * 86400_000
  if (m.source !== 'auto') return false
  if ((Number(m.importance) || 0) >= 0.6) return false
  return retention(m, now) < 0.05
}

/**
 * 记得多牢（0~1）：R = e^(-Δt/τ)。Δt 是离上次被想起（或记下）过了多久；
 * τ 随「被想起过几天」和重要程度变长——一条普通记忆两个月没碰就淡了，隔几天就聊到一次的能记很久。
 */
export function retention(m, now = Date.now()) {
  const last = Math.max(m.at || 0, m.lastHit || 0)
  const days = Math.max(0, (now - last) / 86400_000)
  const strength = 1 + Math.min(10, Number(m.hitDays) || 0)
  const tau = 20 * strength * (0.5 + (Number(m.importance) || 0.5))
  return Math.exp(-days / tau)
}

// ---------------- 记忆库 ----------------

/** 解析「回顾」的模型输出：{insights:[], style:[]}；老格式的纯数组当作 insights。 */
export function parseReflection(out) {
  const str = (t) => String(typeof t === 'string' ? t : t?.text || '').trim()
  const obj = String(out || '').match(/\{[\s\S]*\}/)
  if (obj) {
    try {
      const j = JSON.parse(obj[0])
      if (Array.isArray(j.insights) || Array.isArray(j.style)) {
        return { insights: (j.insights || []).map(str).filter(Boolean), style: (j.style || []).map(str).filter(Boolean) }
      }
    } catch (error) {}
  }
  const arr = String(out || '').match(/\[[\s\S]*\]/)
  try {
    return { insights: arr ? JSON.parse(arr[0]).map(str).filter(Boolean) : [], style: [] }
  } catch (error) {
    return { insights: [], style: [] }
  }
}

export function createMemoryStore({ dsh, getConfig, hub, log }) {
  const file = () => dataDir('memories.json')
  const load = () => readJson(file(), () => ({ items: [] }))
  const save = (s) => {
    writeJson(file(), s)
    cache = null
  }
  let cache = null // { stamp, idx }
  const index = () => {
    const s = load()
    const stamp = s.items.length + ':' + (s.items.at(-1)?.id || '') + ':' + (s.rev || 0)
    if (!cache || cache.stamp !== stamp) cache = { stamp, idx: buildIndex(s.items) }
    return cache.idx
  }

  function add({ text, about = '', aboutName = '', tags = [], importance = 0.5, source = 'tool', chatId = '' }) {
    const t = String(text || '').trim().slice(0, 200)
    if (!t) return { ok: false, message: '内容是空的' }
    const s = load()
    // 去重：很像的就更新旧的（时间、重要程度取新），不重复存
    const dup = s.items.find((m) => !m.invalidAt && similarity(m.text, t) >= 0.6 && (!about || !m.about || m.about === String(about)))
    if (dup) {
      dup.text = t.length >= dup.text.length ? t : dup.text
      dup.at = Date.now()
      dup.importance = Math.max(Number(dup.importance) || 0, Number(importance) || 0)
      s.rev = (s.rev || 0) + 1
      save(s)
      return { ok: true, message: '✓', updated: dup.id }
    }
    const item = { id: randomUUID().slice(0, 8), text: t, about: String(about || ''), aboutName: String(aboutName || ''), tags: (tags || []).slice(0, 5), importance: Math.max(0, Math.min(1, Number(importance) || 0.5)), source, chatId, at: Date.now(), hits: 0 }
    s.items.push(item)
    if (s.items.length > 3000) s.items = s.items.sort((a, b) => (b.importance - a.importance) || (b.at - a.at)).slice(0, 3000)
    save(s)
    return { ok: true, message: '✓', id: item.id }
  }

  /** 导入旧档案第一步：让模型从一大段文字里挑出值得记的，返回候选（不直接存）。 */
  async function importCandidates(text) {
    const src = String(text || '').trim()
    if (!src) return []
    const chunks = []
    for (let i = 0; i < src.length && chunks.length < 6; i += 5000) chunks.push(src.slice(i, i + 5000))
    const out = []
    for (const part of chunks) {
      const r = await askModel(dsh, {
        cfg: getConfig(),
        system: '你帮一个叫「大肥鱼」的聊天角色从旧档案（设定、聊天笔记、以前的记忆文件）里挑出值得长期记住的事：别人的名字/称呼、喜好、身份、约定、重要经历、和她的关系。不要记她自己的人设和外貌（那些在人格里），不要记无关的说明文字。每条一句话、主语写清楚。只输出 JSON 数组，例如 [{"text":"小明喜欢吃辣","about":"小明","importance":0.6}]。',
        text: part,
        maxTokens: 2500,
        temperature: 0.2,
      })
      const m = String(r).match(/\[[\s\S]*\]/)
      try { for (const x of m ? JSON.parse(m[0]) : []) if (x && x.text) out.push({ text: String(x.text).slice(0, 200), aboutName: String(x.about || ''), importance: Math.max(0, Math.min(1, Number(x.importance) || 0.5)) }) } catch (error) {}
    }
    // 和已有记忆、彼此之间去重
    const have = load().items
    const uniq = []
    for (const c of out) if (!have.some((m) => similarity(m.text, c.text) >= 0.6) && !uniq.some((u) => similarity(u.text, c.text) >= 0.6)) uniq.push(c)
    return uniq.slice(0, 80)
  }

  /** 导入旧档案第二步：把勾选的候选存进记忆库。 */
  function importCommit(items) {
    let n = 0
    for (const c of items || []) if (add({ text: c.text, aboutName: c.aboutName || '', importance: c.importance ?? 0.5, source: 'import' }).id) n++
    return n
  }

  /** 她自己做过的事（唱了歌、在空间评论了谁……）：记成「经历」，最近一天的会常驻在上下文里。 */
  function addEvent({ text, about = '', aboutName = '', tags = [], importance = 0.45 }) {
    return add({ text, about, aboutName, tags: ['经历', ...tags], importance, source: 'event' })
  }

  /** 最近 hours 小时里她做过的事（经历 + 空间日记），新的在前。 */
  function recentEvents(hours = 24, limit = 4) {
    const since = Date.now() - hours * 3600_000
    return load().items.filter((m) => (m.source === 'event' || m.source === 'diary') && m.at >= since).sort((a, b) => b.at - a.at).slice(0, limit)
  }

  function update(id, patch) {
    const s = load()
    const m = s.items.find((x) => x.id === id)
    if (!m) return { ok: false, message: '没有这条' }
    for (const k of ['text', 'about', 'aboutName', 'tags', 'importance']) if (patch[k] !== undefined) m[k] = patch[k]
    s.rev = (s.rev || 0) + 1
    save(s)
    return { ok: true, item: m }
  }

  /** 补充或改正一条旧记忆：换成新说法，旧说法留进 history。 */
  function revise(id, text, importance) {
    const s = load()
    const m = s.items.find((x) => x.id === id)
    const t = String(text || '').trim().slice(0, 200)
    if (!m || !t) return false
    m.history = [...(m.history || []), { text: m.text, at: m.at }].slice(-3)
    m.text = t
    m.at = Date.now()
    m.importance = Math.max(Number(m.importance) || 0, Number(importance) || 0)
    s.rev = (s.rev || 0) + 1
    save(s)
    return true
  }

  /** 标成过时：不再被想起，但不删（面板里能看到被哪条取代、能恢复）。 */
  function invalidate(id, byId = '') {
    const s = load()
    const m = s.items.find((x) => x.id === id)
    if (!m) return false
    m.invalidAt = Date.now()
    if (byId) m.supersededBy = byId
    s.rev = (s.rev || 0) + 1
    save(s)
    return true
  }

  function restore(id) {
    const s = load()
    const m = s.items.find((x) => x.id === id)
    if (!m) return { ok: false, message: '没有这条' }
    delete m.invalidAt
    delete m.supersededBy
    s.rev = (s.rev || 0) + 1
    save(s)
    return { ok: true }
  }

  function remove(id) {
    const s = load()
    s.items = s.items.filter((m) => m.id !== id)
    s.rev = (s.rev || 0) + 1
    save(s)
    return { ok: true }
  }

  const recallLog = [] // 最近几次想起了什么（给面板看）
  function recall(query, { about, limit, where = '', context = '' } = {}) {
    const max = limit ?? getConfig().memory.recallCount
    const hits = search(index(), query, { about, limit: max })
    // 这一句没想起几条（「嗯嗯」「然后呢」）：用上一句再找找，分数打折
    if (context && hits.length < max) {
      const have = new Set(hits.map((h) => h.it.id))
      for (const h of search(index(), context, { about, limit: max, minScore: 0.5 })) {
        if (hits.length >= max) break
        if (!have.has(h.it.id)) hits.push({ ...h, score: h.score * 0.6, why: [...(h.why || []), '（上一句）'] })
      }
    }
    recallLog.unshift({ at: Date.now(), where, query: String(query).slice(0, 120), hits: hits.map((h) => ({ id: h.it.id, text: h.it.text, score: Number(h.score.toFixed(2)), why: h.why || [] })) })
    recallLog.length = Math.min(recallLog.length, 20)
    if (hits.length) {
      const s = load()
      for (const h of hits) {
        const m = s.items.find((x) => x.id === h.it.id)
        if (!m) continue
        // 强度按「被想起过几天」算，同一天想起多次只算一次
        if (!m.lastHit || new Date(m.lastHit).toDateString() !== new Date().toDateString()) m.hitDays = (m.hitDays || 0) + 1
        m.hits = (m.hits || 0) + 1
        m.lastHit = Date.now()
      }
      writeJson(file(), s) // 只改命中计数，不动索引
    }
    return hits
  }

  // ---------- 相处经验：按人（私聊按 QQ 号，群按群）归类的、概括性的「怎么和 TA 相处」，越聊越懂 ----------
  const personKey = (chat) => (chat.kind === 'group' ? `group:${chat.groupId}` : chat.userId ? `qq:${chat.userId}` : '')
  function insightsOf(key) {
    return (load().insights || {})[key] || []
  }
  function setInsights(key, list, name) {
    const s = load()
    s.insights = s.insights || {}
    s.insightNames = s.insightNames || {}
    s.insights[key] = list.slice(0, 8)
    if (name) s.insightNames[key] = name
    s.rev = (s.rev || 0) + 1
    save(s)
  }

  // ---------- 说话方式：聊久了潜移默化学到的（对方的说话习惯 + 她自己慢慢养成的说法） ----------
  function styleOf(key) {
    return (load().styles || {})[key] || []
  }
  function setStyle(key, list) {
    const s = load()
    s.styles = s.styles || {}
    s.styles[key] = list.map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, key === 'self' ? 6 : 5)
    s.rev = (s.rev || 0) + 1
    save(s)
  }

  // ---------- 人物小档案：每个人一小段印象（是谁、什么关系、喜好、近况），聊天时常驻 ----------
  function profileOf(qq) {
    return (load().profiles || {})[String(qq)] || null
  }
  function setProfile(qq, text, name = '') {
    const s = load()
    s.profiles = s.profiles || {}
    const t = String(text || '').trim().slice(0, 200)
    if (t) s.profiles[String(qq)] = { text: t, name: name || s.profiles[String(qq)]?.name || '', at: Date.now() }
    else delete s.profiles[String(qq)]
    s.rev = (s.rev || 0) + 1
    save(s)
  }

  /** 按这个人的记忆重写小档案（记忆少于 3 条的不写）。 */
  async function buildProfile(qq) {
    const cfg = getConfig()
    const mine = load().items.filter((m) => !m.invalidAt && String(m.about) === String(qq)).sort((a, b) => a.at - b.at)
    if (mine.length < 3) return false
    const name = mine.filter((m) => m.aboutName).at(-1)?.aboutName || ''
    const old = profileOf(qq)?.text || ''
    const out = await askModel(dsh, {
      cfg,
      system: '你是「大肥鱼」。根据你记得的关于一个人的事，写一张给自己看的人物小档案：TA 是谁、怎么称呼、和你什么关系、性格和喜好、最近在忙什么。只写记忆里明确有的，不要推测性格、不要编，也不要写「应该」「可能」这种猜的话；旧档案和新记忆矛盾时以新记忆为准。用第三人称，一段话，100 字以内，不要标题和列表。',
      text: `${String(qq) === String(cfg.ownerQQ) ? `这是你的${cfg.ownerName || '主人'}。\n` : ''}旧档案：${old || '（还没有）'}\n\n记得的事（越往下越新）：\n${mine.slice(-40).map((m) => `- [${whenText(m.at)}] ${m.text}`).join('\n')}`,
      maxTokens: 1500,
      temperature: 0.3,
    })
    const text = String(out || '').trim().replace(/^[「"]|[」"]$/g, '')
    if (!text) throw new Error('模型没写出东西，等会儿再试')
    setProfile(qq, text, name)
    return true
  }

  /** 给系统提示词上下文用：人物小档案 + 相处经验（常驻）+ 按这一轮对方说的话检索到的记忆。 */
  function contextFor(chat, sessionId) {
    const cfg = getConfig().memory
    if (!cfg.enabled) return ''
    const parts = []
    // 对这个人（群里是正在说话的几个人）的印象，不用等关键词碰上
    const people = chat.kind === 'group' ? (hub?.speakersOf?.(sessionId) || []).slice(0, 3) : chat.userId ? [chat.userId] : []
    const profs = people.map((qq) => profileOf(qq)).filter(Boolean)
    if (profs.length) parts.push('（你对' + (chat.kind === 'group' ? '正在说话的人' : '对方') + '的印象：' + profs.map((p) => (chat.kind === 'group' && p.name ? p.name + '——' : '') + p.text).join('；') + '）')
    const ins = insightsOf(personKey(chat))
    if (ins.length) parts.push('（和' + (chat.kind === 'group' ? '这个群' : '对方') + '相处的经验，照着做就好，不用说出来：' + ins.map((x) => x.text).join('；') + '）')
    const sty = styleOf(personKey(chat))
    const self = styleOf('self')
    if (sty.length || self.length) {
      parts.push('（说话方式：' + [sty.length ? '和' + (chat.kind === 'group' ? '这个群' : '对方') + '聊久了，' + sty.join('；') : '', self.length ? '你平时不知不觉会用的说法：' + self.join('、') : ''].filter(Boolean).join('。') + '。自然带一点就好，别刻意模仿，也别变成另一个人。）')
    }
    // 最近做过的事：不用等别人提，她自己记得（比如刚给你唱过歌）
    const recent = recentEvents()
    if (recent.length) parts.push('（你最近做过的事：' + recent.map((m) => `${agoText(m.at)}${m.text}`).join('；') + '。聊到了可以自然提起。）')
    // 注意：随每条消息变化的「相关记忆」不放在这里（#79）——运行时上下文快照每轮都会追加到历史，
    // 内容一变就多一份快照；放在用户消息里（recallHint）只占当轮，不会越滚越大。
    return parts.join('\n')
  }

  /**
   * 这一轮聊到的事相关的记忆（#79）：内容随每条消息变化，所以由模块在「交给她的内容」里附上，
   * 不放进每轮都会追加的运行时上下文快照。最多 4 条、总长 ≤ 300 字。
   */
  function recallHint(chat, queryText, prevText = '') {
    const cfg = getConfig().memory
    if (!cfg.enabled) return ''
    const q = String(queryText || '').trim()
    if (!q) return ''
    const recent = recentEvents()
    const shown = new Set(recent.map((m) => m.id))
    const about = chat && chat.kind === 'private' ? chat.userId : undefined
    // 「嗯嗯」「然后呢」这种短句单看检索不到东西，把上一句也带上
    const ctxText = q.length < 12 ? String(prevText || '').slice(-300) : ''
    const hits = recall(q, { about, where: (chat && chat.chatId) || '', context: ctxText }).filter((h) => !shown.has(h.it.id)).slice(0, 4)
    if (!hits.length) return ''
    let body = hits.map((h) => memoryLine(h.it)).join('；')
    if (body.length > 300) body = body.slice(0, 300) + '…'
    return '（你记得这些事，方括号里是什么时候的事，聊到相关的就自然用上，别把老事当新事说，也别说「根据记忆」：' + body + '）'
  }

  /** 回顾：结合最近聊天和已有经验，更新这个人的相处经验（合并、提炼、最多 8 条，概括不琐碎）。 */
  async function reflect(chat, transcript) {
    const key = personKey(chat)
    if (!key) return 0
    const old = insightsOf(key)
    const oldStyle = styleOf(key)
    const who = chat.kind === 'group' ? '这个群' : '对方'
    const out = await askModel(dsh, {
      cfg: getConfig(),
      system: '你是「大肥鱼」，在回顾自己和' + who + '的相处。输出一个 JSON 对象 {"insights":[...],"style":[...]}。\n'
        + 'insights：「怎么相处更好」的经验。概括性的、可复用的相处之道（比如「他累的时候不想多聊，简单安慰就好」「喜欢被吐槽，不喜欢太正经」），不要记具体事件和事实细节；和已有经验重复的合并，过时或被证伪的删掉，不超过 8 条，每条不超过 30 字。\n'
        + 'style：' + who + '的说话方式，以及你和' + who + '聊天时可以自然贴近的地方（比如「消息很短，常一句话分几条发」「爱用“hhh”和“草”」「不爱用标点」「喜欢叠字」），只写说话的形式和习惯，不写内容；不超过 5 条，每条不超过 30 字。\n'
        + '只输出这个 JSON 对象。',
      text: `已有经验：\n${old.map((x) => '- ' + x.text).join('\n') || '（还没有）'}\n\n已记下的说话方式：\n${oldStyle.map((x) => '- ' + x).join('\n') || '（还没有）'}\n\n最近的聊天：\n${transcript}`,
      maxTokens: 1500,
      temperature: 0.3,
    })
    const { insights: rawIns, style: rawStyle } = parseReflection(out)
    if (rawStyle.length) setStyle(key, rawStyle)
    const arr = rawIns.map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 8)
    if (!arr.length) return 0
    const now = Date.now()
    setInsights(key, arr.map((text) => old.find((x) => x.text === text) || { id: randomUUID().slice(0, 8), text, at: now }), chat.nickname || chat.groupId || '')
    log.info(`更新了和 ${key} 相处的经验（${arr.length} 条）`)
    return arr.length
  }

  // ---------- 每日整理：临时记忆（各会话的聊天流水）→ 长期记忆 + 相处经验，整理完清空 ----------
  // 各个 DSH 会话自己的对话上下文不动；这里只处理插件记下的聊天流水。

  /** 从一段聊天里提炼长期记忆，并回顾相处经验。lines：[{who, text}] */
  async function extractLines(chatId, lines) {
    const talk = lines.filter((l) => l.text && !String(l.text).startsWith('【系统'))
    const isQzone = chatId === 'qzone'
    // 空间动态一条就可能有料；聊天至少要几句
    if (talk.filter((l) => l.who !== 'bot').length < (isQzone ? 1 : 3)) return { ok: false, message: '内容太少', added: 0, insights: 0 }
    // 带上 QQ 号，模型才能把事记到人头上（群聊、空间里说话的人很多）
    const line = (l) => (l.who === 'bot' ? '我' : l.uid ? `${l.who}(${l.uid})` : l.who) + '：' + l.text
    try {
      // 太长就分段，每段最多 80 行
      const chunks = []
      for (let i = 0; i < talk.length; i += 80) chunks.push(talk.slice(i, i + 80))
      let n = 0
      for (const part of chunks.slice(-3)) n += await extractFacts(chatId, part.map(line).join('\n'))
      log.info(`从 ${chatId} 的${isQzone ? '空间动态' : '聊天'}里提炼了 ${n} 条新记忆`)
      if (isQzone) return { ok: true, added: n, insights: 0 }
      // 顺便回顾一次相处经验（用全天的聊天，最多最近 120 行）
      let ins = 0
      try {
        const [kind, id] = chatId.split(':')
        const chat = kind === 'group' ? { kind, groupId: id, nickname: '' } : { kind: 'private', userId: id, nickname: talk.filter((l) => l.who !== 'bot').at(-1)?.who || '' }
        ins = await reflect(chat, talk.slice(-120).map((l) => `${l.who === 'bot' ? '我' : l.who}：${l.text}`).join('\n'))
      } catch (error) {
        log.warn('回顾相处经验失败：', error.message)
      }
      return { ok: true, added: n, insights: ins }
    } catch (error) {
      log.warn('提炼记忆失败：', error.message)
      return { ok: false, message: error.message, added: 0, insights: 0 }
    }
  }

  /** 这段聊天相关的旧记忆：关于在场的人的 + 和内容相关的，最多 15 条，给模型比对用。 */
  function relatedTo(chatId, transcript) {
    const ppl = new Set([...String(transcript).matchAll(/\((\d{5,})\)/g)].map((m) => m[1]))
    if (chatId.startsWith('private:')) ppl.add(chatId.slice(8))
    const items = load().items.filter((m) => !m.invalidAt && m.source !== 'event' && m.source !== 'diary')
    const out = items.filter((m) => m.about && ppl.has(String(m.about))).sort((a, b) => b.at - a.at).slice(0, 10)
    for (const h of search(index(), String(transcript).slice(-1500), { limit: 8, minScore: 0.5 })) {
      if (out.length >= 15) break
      if (!out.some((m) => m.id === h.it.id) && h.it.source !== 'event' && h.it.source !== 'diary') out.push(h.it)
    }
    return out
  }

  async function extractFacts(chatId, transcript) {
    const cfg = getConfig()
    const source = chatId === 'qzone' ? '下面是 QQ 空间里的动态（好友发的说说、别人给你的评论、你的回复）' : '下面是一段聊天'
    const related = relatedTo(chatId, transcript)
    const known = new Map(related.map((m) => [m.id, m]))
    const out = await askModel(dsh, {
      cfg,
      system: `你帮一个叫「大肥鱼」的聊天角色整理长期记忆。${source}，说话人后面括号里是 QQ 号。挑出以后值得记住的事实：别人的名字/称呼、喜好、讨厌的东西、身份、近况和重要经历、约定、你们之间的关系变化。不要记寒暄、日常琐事、一次性的问答；不要记大肥鱼自己的人设和喜好（她本来就知道），只记关于别人、以及你们之间的事。每条一句话，主语写清楚是谁。QQ 号是 ${cfg.ownerQQ} 的人是她的${cfg.ownerName || '主人'}。` +
        (related.length ? '\n每条新事实先和「已经记得的事」比一比：全新的写 "op":"add"；是对某条旧记忆的补充或更准确的说法，写 "op":"update"、"id" 填那条的编号、"text" 写合并后的完整说法；和某条旧记忆矛盾、说明那条已经过时（比如以前喜欢现在不喜欢了、换了工作、搬家了、分手了），写 "op":"outdated"、"id" 填旧的编号、"text" 写现在的新事实。拿不准是不是矛盾就当 add；已经记得、没有新信息的不要输出。' : '') +
        `只输出 JSON 数组，例如 [{"op":"add","text":"小明喜欢吃辣","about":"小明","about_qq":"12345","importance":0.6}]（about_qq 写这件事是关于谁的 QQ 号，不知道就不写），没有值得记的就输出 []。`,
      text: (related.length ? `已经记得的事：\n${related.map((m) => `#${m.id} [${whenText(m.at)}] ${m.aboutName ? '[' + m.aboutName + '] ' : ''}${m.text}`).join('\n')}\n\n` : '') + transcript,
      maxTokens: 1500,
      temperature: 0.2,
    })
    const m = out.match(/\[[\s\S]*\]/)
    const arr = m ? JSON.parse(m[0]) : []
    let n = 0
    for (const x of arr.slice(0, 12)) {
      if (!x || !x.text) continue
      if (/^(我|大肥鱼)/.test(String(x.about || '')) || String(x.about || '') === '大肥鱼') continue
      // 关于谁：模型给了 QQ 号就用（群聊、空间里也能记到人头上），私聊默认是对方
      const qq = String(x.about_qq ?? '').replace(/\D/g, '')
      const about = qq.length >= 5 && qq !== String(cfg.botQQ) ? qq : chatId.startsWith('private:') ? chatId.slice(8) : ''
      const op = String(x.op || 'add')
      const target = known.get(String(x.id || '').replace(/^#/, ''))
      // 补充旧的（你在面板里亲手写的不改写）
      if (op === 'update' && target && target.source !== 'panel') {
        if (revise(target.id, x.text, x.importance)) n++
        continue
      }
      // 旧的过时了：先标过时（这样新的不会被当成重复合并进去），再记新的
      if (op === 'outdated' && target) {
        invalidate(target.id)
        const r = add({ text: x.text, aboutName: x.about || target.aboutName || '', about: about || target.about || '', importance: x.importance ?? target.importance ?? 0.5, source: 'auto', chatId })
        if (r.id || r.updated) {
          invalidate(target.id, r.id || r.updated)
          log.info(`记忆更新：「${target.text}」过时了 → 「${String(x.text).slice(0, 60)}」`)
          n++
        }
        continue
      }
      const r = add({ text: x.text, aboutName: x.about || '', about, importance: x.importance ?? 0.5, source: 'auto', chatId })
      if (r.ok && r.id) n++
    }
    return n
  }

  const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  let busy = false

  /**
   * 整理临时记忆。
   * @param {{includeToday?:boolean}} o includeToday：连今天的也提炼（手动整理时），但今天的流水不删（写日记还要用）
   */
  async function consolidate(o = {}) {
    if (busy) return { ok: false, message: '正在整理中' }
    busy = true
    const today = dayKey()
    const startedAt = Date.now()
    let added = 0
    let insights = 0
    let days = 0
    let profiles = 0
    try {
      for (const day of hub.chatLogDays()) {
        if (day > today || (day === today && !o.includeToday)) continue
        // 同一天整理过一部分的（比如下午那次），只处理之后新增的聊天
        const done = (load().processed || {})[day] || 0
        const all = hub.chatLogOf(day)
        const byChat = new Map()
        for (const l of all.slice(done)) {
          if (String(l.chatId).startsWith('system:')) continue
          if (!byChat.has(l.chatId)) byChat.set(l.chatId, [])
          byChat.get(l.chatId).push(l)
        }
        for (const [chatId, lines] of byChat) {
          const r = await extractLines(chatId, lines)
          added += r.added || 0
          insights += r.insights ? 1 : 0
        }
        const s = load()
        s.processed = s.processed || {}
        if (day < today) {
          hub.deleteChatLog(day) // 整理完清空（今天的留着，写日记还要用）
          delete s.processed[day]
        } else {
          s.processed[day] = all.length
        }
        save(s)
        days++
      }
      if (days) await learnSelfStyle()
      // 这次记忆有变化的人，重写人物小档案（每次最多 8 个人）
      const live = load()
      const touched = [...new Set(live.items.filter((m) => m.about && (m.at >= startedAt || (m.invalidAt || 0) >= startedAt)).map((m) => String(m.about)))]
      // 还没有小档案、但已经记了不少事的人也补上（刚升级时一次补几个，按记得的多少排）
      const count = new Map()
      for (const m of live.items) if (m.about && !m.invalidAt) count.set(String(m.about), (count.get(String(m.about)) || 0) + 1)
      const missing = [...count].filter(([qq, n]) => n >= 3 && !(live.profiles || {})[qq] && !touched.includes(qq)).sort((x, y) => y[1] - x[1]).map(([qq]) => qq)
      for (const qq of [...touched, ...missing].slice(0, 8)) {
        try { if (await buildProfile(qq)) profiles++ } catch (error) { log.warn('写人物小档案失败：', error.message) }
      }
      const s = load()
      // 遗忘：不重要、很久没被想起的自动记忆清掉，记忆库不会越堆越乱
      const before = s.items.length
      s.items = s.items.filter((m) => !shouldForget(m))
      const forgot = before - s.items.length
      s.lastConsolidate = { day: today, at: Date.now(), added, insights, days, forgot, profiles }
      save(s)
      log.info(`整理临时记忆：处理了 ${days} 天，新增或更新 ${added} 条长期记忆，更新了 ${insights} 份相处经验、${profiles} 份人物小档案${forgot ? `，忘掉 ${forgot} 条不重要的旧记忆` : ''}`)
      return { ok: true, added, insights, days, forgot, profiles, message: `整理好了：新增或更新 ${added} 条记忆，更新 ${insights} 份相处经验、${profiles} 份人物小档案${forgot ? `，忘掉 ${forgot} 条旧的` : ''}` }
    } catch (error) {
      log.warn('整理临时记忆失败：', error.message)
      return { ok: false, message: error.message }
    } finally {
      busy = false
    }
  }

  /** 从各人的说话方式里，沉淀出几条她自己不知不觉学会的说法（很少、很淡）。 */
  async function learnSelfStyle() {
    const s = load()
    const pool = Object.entries(s.styles || {}).filter(([k]) => k !== 'self').flatMap(([, v]) => v)
    if (pool.length < 3) return
    try {
      const out = await askModel(dsh, {
        cfg: getConfig(),
        system: '你是「大肥鱼」。下面是你和不同的人聊天时注意到的说话习惯，以及你自己已经养成的说法。挑出你和大家聊久了、自然会被带上的说话方式（口头禅、语气词、发消息的节奏），保持你原本的性格，不超过 6 条，每条不超过 20 字。只输出 JSON 数组。',
        text: `已经养成的：\n${styleOf('self').map((x) => '- ' + x).join('\n') || '（还没有）'}\n\n大家的说话习惯：\n${pool.map((x) => '- ' + x).join('\n')}`,
        maxTokens: 800,
        temperature: 0.3,
      })
      const m = out.match(/\[[\s\S]*\]/)
      const arr = m ? JSON.parse(m[0]).map((t) => String(typeof t === 'string' ? t : t?.text || '')) : []
      if (arr.length) setStyle('self', arr)
    } catch (error) {
      log.warn('沉淀说话方式失败：', error.message)
    }
  }

  /** 每分钟调一次：一天几个整理时间点（默认 04:00 / 16:00），到点且这个点今天还没跑过就整理。 */
  async function tick() {
    const cfg = getConfig().memory
    if (!cfg.enabled || !cfg.dailyConsolidate) {
      const cutoff = dayKey(new Date(Date.now() - 14 * 86400_000))
      for (const day of hub.chatLogDays?.() || []) if (day < cutoff) hub.deleteChatLog(day)
      return
    }
    const s = load()
    const today = dayKey()
    const now = new Date()
    const mins = now.getHours() * 60 + now.getMinutes()
    const runs = s.runs || {}
    const due = (cfg.consolidateTimes || []).filter((t) => {
      const [hh, mm] = String(t).split(':').map(Number)
      return mins >= hh * 60 + mm && runs[t] !== today
    })
    if (!due.length) return
    // 连今天到目前为止的聊天一起提炼；记着整理到第几行，下一次只处理新的
    const r = await consolidate({ includeToday: true })
    if (r.ok) {
      const s2 = load()
      s2.runs = { ...(s2.runs || {}) }
      for (const t of due) s2.runs[t] = today
      save(s2)
    }
  }

  /** 群聊话题和记忆库有多相关（0~1），给插话判断用。 */
  function topicScore(text) {
    const hits = search(index(), text, { limit: 1, minScore: 0.01 })
    return hits.length ? Math.min(1, hits[0].score / 3) : 0
  }

  return {
    recallHint,
    add, addEvent, recentEvents, update, remove, restore, recall, contextFor, consolidate, tick, topicScore, importCandidates, importCommit,
    profiles: () => { const s = load(); return Object.entries(s.profiles || {}).map(([qq, p]) => ({ qq, ...p })).sort((a, b) => b.at - a.at) },
    setProfile, buildProfile,
    recalls: () => recallLog.slice(),
    styles: () => load().styles || {},
    setStyle: (key, list) => setStyle(key, (list || []).map(String)),
    lastConsolidate: () => load().lastConsolidate || null,
    insights: () => {
      const s = load()
      return Object.entries(s.insights || {}).map(([key, list]) => ({ key, name: (s.insightNames || {})[key] || '', list }))
    },
    setInsights: (key, list) => setInsights(key, list.map((x) => (typeof x === 'string' ? { id: randomUUID().slice(0, 8), text: x, at: Date.now() } : x))),
    list: (q) => {
      const items = load().items
      // 面板里过时的也列出来（排在后面），能看到被哪条取代、能恢复
      const textOf = new Map(items.map((m) => [m.id, m.text]))
      const withBy = (m) => (m.supersededBy ? { ...m, supersededText: textOf.get(m.supersededBy) || '' } : m)
      if (!q) return items.slice().sort((a, b) => (Boolean(a.invalidAt) - Boolean(b.invalidAt)) || b.at - a.at).map(withBy)
      return search(index(), q, { limit: 100, minScore: 0.01, includeInvalid: true }).map((h) => withBy({ ...h.it, score: Number(h.score.toFixed(2)) }))
    },
    stats: () => {
      const items = load().items
      const live = items.filter((m) => !m.invalidAt)
      return { count: live.length, auto: live.filter((m) => m.source === 'auto').length, events: live.filter((m) => m.source === 'event').length, outdated: items.length - live.length }
    },
  }
}
