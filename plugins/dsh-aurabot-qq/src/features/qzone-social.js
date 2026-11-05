// QQ 空间互动：回复自己说说下的新评论；逛好友动态，偶尔点个赞、评一句。
// 评论在专用的后台会话里按她的人格写；试运行时只记日志不发。

import { dataDir, readJson, writeJson } from '../core/store.js'
import { isSilence, stripMarkdown } from '../chat/reply.js'

const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** 模型写的评论：去掉 Markdown、只要第一段、限长；不想评返回 ''。 */
export function cleanComment(text, max = 60) {
  const t = stripMarkdown(String(text || '')).replace(/\|\|\|/g, ' ').replace(/<[^>]+>/g, '').trim()
  if (!t || isSilence(t)) return ''
  const first = t.split(/\n+/).map((s) => s.trim()).filter(Boolean).slice(0, 2).join(' ')
  return first.length > max ? first.slice(0, max) : first
}

/**
 * 一串评论（一级评论 + 下面的回复）里，还没回的别人的新消息。
 * 只算她在这一串里最后一次开口之后的；她自己的评论下面别人接着回她，也算。
 * @returns {{thread: object[], pending: object[]}}  thread 按时间排好；pending 里每项带 id
 */
export function pendingInThread(comment, selfId, handled = new Set()) {
  const cid = String(comment.comment_id ?? `${comment.uin}-${comment.time}`)
  const thread = [{ ...comment, id: cid }, ...(comment.replies || []).map((r) => ({ ...r, id: `${cid}/${r.comment_id ?? `${r.uin}-${r.time}`}` }))]
    .sort((a, b) => Number(a.time || 0) - Number(b.time || 0))
  let lastMine = -1
  thread.forEach((x, i) => { if (String(x.uin) === String(selfId)) lastMine = i })
  const pending = thread.slice(lastMine + 1).filter((x) => String(x.uin) !== String(selfId) && !handled.has(x.id))
  return { thread, pending }
}

/**
 * 把说说下面的评论（含回复）整理成几行，给她当上下文。
 * @param {object[]} comments get_qzone_msg_detail 的 comments
 * @param {object} o selfId / ownerQQ / ownerName；exclude = 要跳过的一级评论 id；max = 最多几行
 */
export function summarizeComments(comments, { selfId, ownerQQ, ownerName = '主人', exclude = '', max = 8 } = {}) {
  const who = (u) => (String(u.uin) === String(selfId) ? '你' : `${u.name || u.uin}${String(u.uin) === String(ownerQQ) ? `（你的${ownerName}）` : ''}`)
  const lines = []
  for (const c of comments || []) {
    if (String(c.comment_id ?? '') === String(exclude)) continue
    lines.push(`${who(c)}：${String(c.content).slice(0, 80)}`)
    for (const r of c.replies || []) lines.push(`  └ ${who(r)}：${String(r.content).slice(0, 80)}`)
  }
  return lines.length > max ? [...lines.slice(0, max), `……还有 ${lines.length - max} 条`] : lines
}

/** 好友动态里值得看的：别人发的说说（appid 311），不是广告、不是她自己的，24 小时内。 */
export function pickFeeds(feeds, selfId, now = Date.now()) {
  return (feeds || []).filter((f) => f && f.appid === 311 && Number(f.uin) > 0 && String(f.uin) !== String(selfId) && f.key && now / 1000 - Number(f.time || 0) < 86400)
}

export function createQzoneSocial({ getConfig, onebot, hub, log, memory }) {
  // 空间里看到的东西记进流水（chatId = qzone），每次整理记忆时从里面提炼关于好友的事
  const remember = (who, uin, text) => { try { hub.logChat?.('qzone', who, text, uin) } catch (error) {} }
  const file = () => dataDir('qzone-social.json')
  const load = () => readJson(file(), () => ({ day: '', count: 0, lastRun: 0, replied: {}, seen: [], history: [] }))
  const save = (s) => writeJson(file(), s)
  let busy = false

  const self = () => String(hub.selfId || getConfig().botQQ)
  const owner = () => getConfig().ownerName || '主人'

  async function write(prompt) {
    const out = await hub.runSystemTurn('qzone-social', 'QQ · 空间互动', `【空间互动，不是聊天，这一轮不会发到聊天里】\n${prompt}\n\n只输出评论正文本身，一两句、口语、不超过 40 个字，别加引号和前缀；不想评就只回 [沉默]。`, { timeoutMs: 120000 })
    return cleanComment(out)
  }

  function record(s, item, counts = true) {
    s.history.unshift({ at: Date.now(), ...item })
    s.history = s.history.slice(0, 30)
    if (counts) s.count++ // 只有评论算进每天的上限，点赞不算
  }

  async function sendComment(tid, content, targetUin) {
    const cfg = getConfig()
    if (cfg.dryRun) {
      log.info(`试运行：本来要在空间评论（${targetUin || '自己'} / ${tid}）：${content}`)
      return true
    }
    await onebot.call('comment_qzone', { tid, content, ...(targetUin ? { target_uin: Number(targetUin) } : {}) }, { timeoutMs: 30000 })
    log.info(`空间评论（${targetUin || '自己的说说'}）：${content}`)
    return true
  }

  /** 回复自己说说下别人的新评论。 */
  async function replyOwn(s, budget) {
    let done = 0
    const list = await onebot.call('get_qzone_msg_list', { num: 5 }, { timeoutMs: 20000 })
    for (const m of list?.msglist || []) {
      if (done >= budget) break
      if (!(m.comment_num > 0) || Date.now() / 1000 - m.time > 3 * 86400) continue
      const d = await onebot.call('get_qzone_msg_detail', { tid: m.tid, num: 30 }, { timeoutMs: 20000 })
      const handled = new Set(s.replied[m.tid] || [])
      for (const c of d?.comments || []) {
        if (done >= budget) break
        const t = pendingInThread(c, self(), handled)
        if (!t.pending.length) continue
        for (const id of t.pending.map((x) => x.id)) handled.add(id) // 这一串新消息只回一次，回不回都不再看
        for (const x of t.pending) remember(x.name, x.uin, `在你的说说「${String(m.content).slice(0, 30)}」下面说：${String(x.content).slice(0, 200)}`)
        const last = t.pending[t.pending.length - 1]
        const name = (u) => (String(u.uin) === self() ? '你' : u.name + (String(u.uin) === String(getConfig().ownerQQ) ? `（你的${owner()}）` : ''))
        const thread = t.thread.map((x) => `${name(x)}：${String(x.content).slice(0, 150)}`).join('\n')
        // 同一条说说下别人在聊的，也让她知道（不重复说、能接上大家的话）
        const others = summarizeComments(d.comments, { selfId: self(), ownerQQ: getConfig().ownerQQ, ownerName: owner(), exclude: c.comment_id, max: 6 })
        const text = await write(`你在 QQ 空间发过一条说说：「${String(m.content).slice(0, 200)}」${m.images?.length ? `（配了 ${m.images.length} 张图）` : ''}\n` +
          (others.length ? `这条说说下面大家的评论：\n${others.join('\n')}\n\n` : '') +
          `你要回的是这一串：\n${thread}\n\n${last.name} 刚刚说了新的话，结合说说内容和上面的评论，用你的口气接着回 TA 一句。`)
        if (!text) continue
        await sendComment(m.tid, `回复 ${last.name}：${text}`)
        memory?.addEvent?.({ text: `在空间回复了${last.name}的评论：${text}`, about: String(last.uin), aboutName: last.name, tags: ['空间'], importance: 0.35 })
        record(s, { kind: 'reply', who: last.name, post: String(m.content).slice(0, 30), text })
        done++
      }
      s.replied[m.tid] = [...handled].slice(-200)
    }
    // 只留最近的说说的记录
    const keep = new Set((list?.msglist || []).map((m) => m.tid))
    for (const tid of Object.keys(s.replied)) if (!keep.has(tid)) delete s.replied[tid]
    return done
  }

  /** 逛好友动态：每条说说只判断一次，按概率点赞、评论。 */
  async function browseFriends(s, budget) {
    const c = getConfig().qzoneSocial
    let done = 0
    const res = await onebot.call('get_qzone_feeds', { count: 15 }, { timeoutMs: 20000 })
    const seen = new Set(s.seen)
    for (const f of pickFeeds(res?.feeds, self())) {
      if (done >= budget) break
      if (seen.has(f.key)) continue
      seen.add(f.key)
      const brief = String(f.html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
      remember(f.nickname, f.uin, '发了说说：' + brief.slice(0, 300))
      const isOwner = String(f.uin) === String(getConfig().ownerQQ)
      const chance = isOwner ? Math.max(c.friendChance, c.ownerChance) : c.friendChance
      if (Math.random() >= chance) continue
      let content = ''
      let images = 0
      let existing = []
      try {
        const d = await onebot.call('get_qzone_msg_detail', { tid: f.key, target_uin: Number(f.uin), num: 10 }, { timeoutMs: 20000 })
        content = String(d?.content || '')
        existing = summarizeComments(d?.comments, { selfId: self(), ownerQQ: getConfig().ownerQQ, ownerName: owner(), max: 8 })
      } catch (error) {
        content = String(f.html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
      }
      images = (String(f.html || '').match(/<img/g) || []).length
      if (c.like && !getConfig().dryRun) {
        try { await onebot.call('like_qzone', { tid: f.key, target_uin: Number(f.uin), abstime: Number(f.time) || 0 }, { timeoutMs: 20000 }) } catch (error) { log.debug('点赞失败：', error.message) }
      }
      const text = await write(`你在刷 QQ 空间，看到${isOwner ? `你的${owner()}` : `好友 ${f.nickname}`}发的说说：「${content.slice(0, 300) || '（只有图片）'}」${images ? `（配了图）` : ''}\n` +
        (existing.length ? `下面已经有这些评论：\n${existing.join('\n')}\n\n` : '') +
        `想评论的话，结合说说内容${existing.length ? '和下面大家在聊的（别重复别人说过的话，可以接大家的梗）' : ''}，用你的口气评一句（像朋友之间随手评论那样）。`)
      if (!text) {
        if (c.like) record(s, { kind: 'like', who: f.nickname, post: content.slice(0, 30), text: '' }, false)
        continue
      }
      await sendComment(f.key, text, f.uin)
      memory?.addEvent?.({ text: `在空间评论了${isOwner ? owner() : f.nickname}的说说「${content.slice(0, 24)}」：${text}`, about: String(f.uin), aboutName: f.nickname, tags: ['空间'] })
      record(s, { kind: 'comment', who: f.nickname, post: content.slice(0, 30), text })
      done++
    }
    s.seen = [...seen].slice(-300)
    return done
  }

  async function run({ force = false } = {}) {
    const cfg = getConfig()
    const c = cfg.qzoneSocial
    if (busy) return { ok: false, message: '正在逛空间' }
    if (!force && (!cfg.enabled || !c.enabled)) return { ok: false, message: '没打开' }
    busy = true
    const s = load()
    if (s.day !== dayKey()) Object.assign(s, { day: dayKey(), count: 0 })
    s.lastRun = Date.now()
    try {
      const left = Math.max(0, c.maxPerDay - s.count)
      if (!left) return { ok: true, message: '今天互动够多了', replies: 0, comments: 0 }
      const replies = c.replyOwn ? await replyOwn(s, Math.min(3, left)) : 0
      const comments = c.commentFriends ? await browseFriends(s, Math.min(2, Math.max(0, c.maxPerDay - s.count))) : 0
      return { ok: true, message: `回了 ${replies} 条评论，评了 ${comments} 条好友说说`, replies, comments }
    } catch (error) {
      log.warn('逛空间出错：', error.message)
      return { ok: false, message: error.message }
    } finally {
      save(s)
      busy = false
    }
  }

  /** 每分钟调一次：醒着的时候，每隔 intervalMin 分钟逛一次。 */
  async function tick() {
    const cfg = getConfig()
    const c = cfg.qzoneSocial
    if (!cfg.enabled || !c.enabled) return
    const h = new Date().getHours()
    if (h < cfg.speakUp.awakeFrom || h >= cfg.speakUp.awakeTo) return
    if (Date.now() - load().lastRun < c.intervalMin * 60_000) return
    await run()
  }

  return { run, tick, state: () => { const s = load(); return { count: s.day === dayKey() ? s.count : 0, lastRun: s.lastRun, history: s.history.slice(0, 15) } } }
}
