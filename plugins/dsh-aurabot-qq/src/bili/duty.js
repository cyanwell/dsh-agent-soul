// 刷 B 站：定时挑她和你感兴趣的方向去搜视频，读简介、字幕、热评，再按她的人格决定评不评论、分不分享给你、记住什么；
// 定时看别人回她的评论并接着回；你在 QQ 里发链接，她也能点进去看完再聊。看过的、评过的都记成她的经历。

import { dataDir, readJson, writeJson } from '../core/store.js'
import { createBiliApi, findVideoId, parseCookie } from './api.js'
import { lookWithVision, visionState } from './vision.js'
import { createShotStore, shotPath, clockOf } from './shots.js'

// 这些错误说明今天别再发了：没登录 / Cookie 过期、csrf 不对、风控、要验证码、太频繁
const PAUSE_CODES = { '-101': 'B 站没登录或 Cookie 过期了', '-111': 'Cookie 里的 bili_jct 不对', '-352': '被 B 站风控了', '-509': '发得太频繁', '12015': 'B 站要求验证码' }
import { isSilence } from '../chat/reply.js'

const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const link = (bvid) => `https://www.bilibili.com/video/${bvid}`

/** 从模型输出里取 JSON（对象或数组），取不到返回 fallback。 */
export function pickJson(out, fallback) {
  const s = String(out || '')
  const m = s.match(/\[[\s\S]*\]/) || s.match(/\{[\s\S]*\}/)
  if (!m) return fallback
  try { return JSON.parse(m[0]) } catch (error) { return fallback }
}

/** 搜到的视频按门槛过滤：播放量够、不太老、没看过。 */
export function filterVideos(list, { minViews = 0, maxAgeDays = 0, seen = new Set(), now = Date.now() } = {}) {
  return (list || []).filter((v) => v.bvid && !seen.has(v.bvid) && (v.play || 0) >= minViews && (!maxAgeDays || !v.pubdate || now - v.pubdate <= maxAgeDays * 86400_000))
}

/** 一个视频交给她看的样子（标题、UP 主、简介、字幕节选、画面描述、热评）。 */
export function digestOf(v, { subtitle = '', comments = [], vision = '' } = {}) {
  return [
    `《${v.title}》 UP主：${v.author || '?'}  播放 ${v.play || 0}${v.tname ? '  分区：' + v.tname : ''}  ${v.bvid}`,
    v.desc ? `简介：${v.desc.slice(0, 300)}` : '',
    subtitle
      ? `字幕（节选）：${subtitle.slice(0, 2500)}`
      : `（没有字幕${vision ? '，只看了画面' : '，只能看标题、简介和评论'}）`,
    vision ? `画面（抽帧）：${vision.slice(0, 900)}` : '',
    comments.length ? '热评：\n' + comments.slice(0, 8).map((c) => `  ${c.name}：${c.text}`).join('\n') : '',
  ].filter(Boolean).join('\n')
}

export function createBili({ getConfig, hub, memory, log, dsh, api: injected, vision: see = lookWithVision }) {
  const cfg = () => getConfig().bili
  const api = injected || createBiliApi({ getCookie: () => cfg().cookie, log })
  const shots = createShotStore({ max: () => getConfig().bili.shotLibrary })
  const file = () => dataDir('bili.json')
  const load = () => readJson(file(), () => ({ day: '', runs: 0, comments: 0, replies: 0, lastRun: 0, lastReplyCheck: 0, seen: [], repliedFeed: [], history: [] }))
  const save = (s) => writeJson(file(), s)
  const today = (s) => { if (s.day !== dayKey()) Object.assign(s, { day: dayKey(), runs: 0, comments: 0, replies: 0 }) ; return s }
  let busy = false
  let login = { at: 0, value: { isLogin: false, uname: '' } }

  const owner = () => getConfig().ownerName || '主人'
  // 能不能发评论 / 回复：Cookie 里要有 bili_jct，今天也没因为风控之类暂停
  const canPost = (s) => Boolean(parseCookie(cfg().cookie).bili_jct) && s.pauseDay !== dayKey()
  const pauseIf = (s, error) => {
    const why = PAUSE_CODES[String(error.code)]
    if (!why) return
    s.pauseDay = dayKey()
    s.pauseReason = why
    log.warn(`今天先不在 B 站发评论了：${why}`)
  }
  const record = (s, item) => { s.history.unshift({ at: Date.now(), ...item }); s.history = s.history.slice(0, 40) }

  async function account(force = false) {
    if (!force && Date.now() - login.at < 10 * 60_000) return login.value
    try {
      login = { at: Date.now(), value: await api.nav() }
    } catch (error) {
      login = { at: Date.now(), value: { isLogin: false, uname: '', error: error.message } }
    }
    return login.value
  }

  async function think(prompt) {
    return hub.runSystemTurn('bili', 'QQ · 刷B站', `【刷 B 站，不是聊天，这一轮不会发到聊天里】\n${prompt}`, { timeoutMs: 180000 })
  }

  /** 这一轮搜什么：她自己的兴趣 + 记忆里你喜欢的东西 + 面板里填的关键词，让她挑 3 个。 */
  async function chooseKeywords() {
    const c = cfg()
    const interests = [...(c.keywords || []), ...(getConfig().group.interests || [])]
    const about = (memory?.list?.('') || []).filter((m) => String(m.about) === String(getConfig().ownerQQ) || /喜欢|爱|想|在玩|在看|追/.test(m.text)).slice(0, 12).map((m) => m.text)
    const recent = (memory?.recentEvents?.(72, 6) || []).filter((m) => (m.tags || []).includes('B站')).map((m) => m.text)
    try {
      const out = await think(`你想去 B 站刷点视频。你感兴趣的：${interests.join('、') || '随便看看'}。\n你记得的关于${owner()}和大家的事：\n${about.map((t) => '- ' + t).join('\n') || '（暂无）'}\n最近刷过的：\n${recent.map((t) => '- ' + t).join('\n') || '（暂无）'}\n\n挑 3 个这次想搜的关键词（可以是你自己想看的，也可以是${owner()}可能喜欢、你想分享给${owner()}的），别和最近刷过的重复。只输出 JSON 数组，例如 ["白米饭 做法","猫咪 搞笑"]。`)
      const arr = pickJson(out, []).map((k) => String(k).trim()).filter(Boolean)
      if (arr.length) return arr.slice(0, 3)
    } catch (error) {
      log.debug('挑关键词失败：', error.message)
    }
    return interests.sort(() => Math.random() - 0.5).slice(0, 3)
  }

  async function lookAt(v) {
    const info = await api.view({ bvid: v.bvid })
    const [subtitle, comments] = await Promise.all([api.subtitle(info).catch(() => ''), api.comments(info.aid).catch(() => [])])
    // 开着「看画面」才抽帧：失败一律只记 debug，退回纯文本，不影响这一轮
    let vision = ''
    let shotIds = []
    const c = cfg()
    if (c.vision) {
      try {
        const r = await see({ dsh, api, info, getConfig, log })
        vision = r.text || ''
        if (vision) log.debug(`看了《${info.title}》的画面：${vision.slice(0, 40)}…`)
        // 抽到的帧顺手存进截图库：之后她自己发、或主人让她挑一张发
        for (const f of r.frames || []) {
          const it = shots.put(f.buf, { bvid: info.bvid, title: info.title, sec: f.sec, note: vision.slice(0, 120) })
          if (it) shotIds.push(it.file)
        }
      } catch (error) {
        log.debug(`看画面失败（${info.bvid}）：`, error.message)
      }
    }
    return { info, subtitle, comments, vision, shotIds, digest: digestOf(info, { subtitle, comments, vision }) }
  }

  /** 挑一张存下来的截图发到指定会话（主人让她发 / 她刷完顺手发）。 */
  async function sendShot({ chatId, query = '' } = {}) {
    const g = getConfig()
    if (!g.enabled || !g.bili.enabled) return { ok: false, sent: false, message: '插件或 B 站没打开' }
    if (!/^(private|group):\d+$/.test(String(chatId || ''))) return { ok: false, sent: false, message: '没有可发送的 QQ 会话' }
    const it = shots.pick(query)
    if (!it) {
      return {
        ok: false,
        message: query ? `没有和「${query}」对得上的截图（不带条件再挑就是最近的一张）` : '我还没截过图（刷 B 站看画面的时候才会截）',
      }
    }
    if (!shots.exists(it)) return { ok: false, message: '那张截图的文件已经没有了' }
    if (g.dryRun) return { ok: true, sent: false, simulated: true, message: `试运行：准备发送《${it.title}》${clockOf(it.sec)} 的截图，未实际发送` }
    let r
    try { r = await hub.sendImage(chatId, shotPath(it)) } catch (error) {
      return { ok: false, sent: false, message: '图没发出去：' + error.message }
    }
    if (String(r?.message_id || '').startsWith('sim-')) return { ok: true, sent: false, simulated: true, message: '模拟发送：未实际发到 QQ' }
    if (r?.message_id === undefined) return { ok: false, sent: false, message: '图没发出去或未收到消息回执，看日志' }
    const st = load()
    record(st, { kind: 'shot', title: it.title, bvid: it.bvid, text: `第 ${clockOf(it.sec)} 的截图` })
    save(st)
    log.info(`发了一张截图《${it.title}》${clockOf(it.sec)} → ${chatId}`)
    return { ok: true, sent: true, message: `发了《${it.title}》${clockOf(it.sec)} 那一帧`, shot: { title: it.title, bvid: it.bvid, sec: it.sec } }
  }

  /** 让她自己看看手上有哪些截图（挑之前先看）。 */
  function listShots(query = '') {
    const list = shots.list(query).slice(0, 20).map((i) => ({ title: i.title, bvid: i.bvid, sec: i.sec, clock: clockOf(i.sec), note: i.note }))
    return list.length
      ? { ok: true, list, message: `手上有 ${shots.count()} 张截图，这是${query ? `和「${query}」有关的 ` : '最近的 '}${list.length} 张` }
      : { ok: false, list: [], message: query ? `没有和「${query}」对得上的截图` : '还没有截图' }
  }

  /** 面板用：截图库全量列表（按当前上限先裁一遍）。 */
  function libraryShots() {
    return { ok: true, items: shots.panel() }
  }

  /** 面板用：某张截图在本机的绝对路径；文件不在就返回 ''。 */
  function shotFileOf(name) {
    const it = shots.list('').find((i) => i.file === String(name || ''))
    if (!it || !shots.exists(it)) return ''
    return shotPath(it)
  }

  /** 面板用：手动删掉库里的一张。 */
  function deleteShot(name) {
    const r = shots.remove(name)
    if (r.ok) log.info(r.message)
    return r
  }

  /** 刷一轮。force = 面板里手动点的（不占每天的次数）。 */
  async function run({ force = false } = {}) {
    const c = cfg()
    if (busy) return { ok: false, message: '正在刷' }
    if (!c.enabled && !force) return { ok: false, message: 'B 站没打开' }
    busy = true
    const s = today(load())
    try {
      const seen = new Set(s.seen)
      const kws = await chooseKeywords()
      let pool = []
      for (const kw of kws) {
        try { pool.push(...filterVideos(await api.search(kw), { minViews: c.minViews, maxAgeDays: c.maxAgeDays, seen }).slice(0, 4).map((v) => ({ ...v, kw }))) } catch (error) { log.debug(`搜「${kw}」失败：`, error.message) }
      }
      if (pool.length < c.perRun) {
        try { pool.push(...filterVideos(await api.popular({ ps: 20 }), { seen }).slice(0, c.perRun).map((v) => ({ ...v, kw: '热门' }))) } catch (error) {}
      }
      // 每个关键词轮着取，避免一轮全是同一类
      const picked = []
      const byKw = new Map()
      for (const v of pool) { if (!byKw.has(v.kw)) byKw.set(v.kw, []); byKw.get(v.kw).push(v) }
      while (picked.length < c.perRun && [...byKw.values()].some((l) => l.length)) for (const l of byKw.values()) if (l.length && picked.length < c.perRun) { const v = l.shift(); if (!picked.some((p) => p.bvid === v.bvid)) picked.push(v) }
      if (!picked.length) return { ok: false, message: '这次没搜到合适的视频' }
      const looked = []
      for (const v of picked) {
        try { looked.push(await lookAt(v)) } catch (error) { log.debug(`看 ${v.bvid} 失败：`, error.message) }
        seen.add(v.bvid)
      }
      s.seen = [...seen].slice(-500)
      if (!looked.length) return { ok: false, message: '视频都打不开' }
      const commentLeft = c.comment && canPost(s) ? Math.max(0, c.maxCommentsPerDay - s.comments) : 0
      const out = await think(`你在 B 站刷到了这几个视频：\n\n${looked.map((x, i) => `【${i + 1}】${x.digest}`).join('\n\n')}\n\n` +
        `看完说说你的想法。对每个视频给一个对象：{"i":序号, "feeling":"一句你的真实感受", "comment":"想在视频下发的评论（像普通观众，一两句、别打广告，不想评就空字符串）", "share":"想私聊分享给${owner()}的话（觉得${owner()}会喜欢才写，不然空字符串）", "remember":"值得记住的一件事（没有就空字符串）"}。` +
        `这次最多评论 ${commentLeft} 个。只输出 JSON 数组。`)
      const decisions = pickJson(out, [])
      let commented = 0
      let shared = 0
      const felt = new Map() // bvid → 她自己的一句感受，发截图时配着用
      for (const d of Array.isArray(decisions) ? decisions : []) {
        const x = looked[(Number(d.i) || 0) - 1]
        if (!x) continue
        const v = x.info
        const feeling = String(d.feeling || '').trim()
        if (feeling) felt.set(v.bvid, feeling)
        memory?.addEvent?.({ text: `在B站看了《${v.title}》（UP主 ${v.author}）${feeling ? '：' + feeling.slice(0, 60) : ''}`, tags: ['B站'], importance: 0.4 })
        if (d.remember && !isSilence(d.remember)) memory?.add?.({ text: String(d.remember).slice(0, 200), tags: ['B站'], importance: 0.5, source: 'event' })
        const comment = String(d.comment || '').trim()
        if (comment && !isSilence(comment) && commented < commentLeft && canPost(s)) {
          try {
            if (getConfig().dryRun) log.info(`试运行：本来要在 B 站《${v.title}》下评论：${comment}`)
            else await api.postComment(v.aid, comment.slice(0, 200))
            commented++
            s.comments++
            memory?.addEvent?.({ text: `在B站《${v.title}》下评论：${comment.slice(0, 60)}`, tags: ['B站'], importance: 0.4 })
            record(s, { kind: 'comment', title: v.title, bvid: v.bvid, text: comment })
          } catch (error) {
            log.warn('B 站评论失败：', error.message)
            pauseIf(s, error)
            record(s, { kind: 'error', title: v.title, bvid: v.bvid, text: '评论没发出去：' + error.message })
          }
        }
        if (c.like && !getConfig().dryRun) api.likeVideo(v.aid).catch(() => {})
        const share = String(d.share || '').trim()
        if (share && !isSilence(share) && c.shareToOwner && getConfig().ownerQQ) {
          await hub.sendText(`private:${getConfig().ownerQQ}`, `${share}\n${link(v.bvid)}`)
          shared++
          record(s, { kind: 'share', title: v.title, bvid: v.bvid, text: share })
        }
        record(s, { kind: 'watch', title: v.title, bvid: v.bvid, text: feeling })
      }
      // 刷完按概率顺手甩一张截图给主人：默认概率和发一张表情包一样，0 = 从不
      let shotSent = 0
      const shotTo = getConfig().ownerQQ ? `private:${getConfig().ownerQQ}` : ''
      if (shotTo && c.enabled && getConfig().enabled && !getConfig().dryRun && Number(c.shotChance) > 0) {
        const pool = looked.filter((x) => x.shotIds && x.shotIds.length)
        if (pool.length && Math.random() < Number(c.shotChance)) {
          const x = pool[Math.floor(Math.random() * pool.length)]
          const file = x.shotIds[Math.floor(Math.random() * x.shotIds.length)]
          try {
            const line = felt.get(x.info.bvid) || ''
            const r = await hub.sendImage(shotTo, shotPath({ file }))
            if (r?.message_id !== undefined && !String(r.message_id).startsWith('sim-')) {
              shotSent = 1
              record(s, { kind: 'shot', title: x.info.title, bvid: x.info.bvid, text: line })
              log.info(`刷完顺手发了张截图《${x.info.title}》`)
              if (line) await hub.sendText(shotTo, line)
            }
          } catch (error) {
            log.warn('顺手发截图失败：', error.message)
          }
        }
      }
      if (!force) s.runs++
      s.lastRun = Date.now()
      log.info(`刷了一轮 B 站：看了 ${looked.length} 个，评论 ${commented} 条，分享 ${shared} 个，截图 ${shotSent} 张`)
      return { ok: true, message: `看了 ${looked.length} 个视频，评论 ${commented} 条，分享给你 ${shared} 个${shotSent ? '，还发了张截图' : ''}`, watched: looked.length, commented, shared, shots: shotSent }
    } catch (error) {
      log.warn('刷 B 站出错：', error.message)
      return { ok: false, message: error.message }
    } finally {
      save(s)
      busy = false
    }
  }

  /** 看别人回她的评论，接着回。 */
  async function checkReplies() {
    const c = cfg()
    if (!c.reply) return { ok: false, message: '回复没打开' }
    const s = today(load())
    s.lastReplyCheck = Date.now()
    let n = 0
    try {
      const done = new Set(s.repliedFeed)
      const fresh = (await api.replyFeed()).filter((x) => !done.has(x.id) && Number(x.type || 1) === 1 && x.oid).slice(0, 5)
      for (const x of fresh) {
        done.add(x.id)
        // 记下来：整理记忆时能知道 B 站上谁跟她聊过什么
        hub.logChat?.('bili', x.name, `在 B 站《${x.title}》下回复你：${x.text}`, '')
        if (s.replies >= c.maxRepliesPerDay || !canPost(s)) continue
        const out = await think(`你在 B 站视频《${x.title}》下发过评论：「${x.myText}」\n${x.name} 回复你：「${x.text}」\n想回就用你的口气回一句（像普通网友聊天，别太长），不想回就只输出 [沉默]。只输出回复正文。`)
        const reply = String(out || '').trim().split(/\n+/)[0]
        if (!reply || isSilence(reply)) continue
        try {
          if (getConfig().dryRun) log.info(`试运行：本来要在 B 站回复 ${x.name}：${reply}`)
          else await api.postComment(x.oid, `回复 @${x.name} :${reply}`.slice(0, 200), { root: x.root, parent: x.parent })
          s.replies++
          n++
          memory?.addEvent?.({ text: `在B站回复了 ${x.name}：${reply.slice(0, 50)}`, tags: ['B站'], importance: 0.35 })
          record(s, { kind: 'reply', title: x.title, text: `${x.name}：${x.text} → ${reply}` })
        } catch (error) {
          log.warn('B 站回复失败：', error.message)
          pauseIf(s, error)
        }
      }
      s.repliedFeed = [...done].slice(-300)
      return { ok: true, message: `回了 ${n} 条`, replied: n }
    } catch (error) {
      return { ok: false, message: error.message }
    } finally {
      save(s)
    }
  }

  /** 她看一个视频（你发的链接 / BV 号），返回给她看的内容。 */
  async function watch(text) {
    let id = findVideoId(text)
    if (!id) return { ok: false, message: '没认出视频链接或 BV 号' }
    if (id.short) {
      const real = await api.resolveShort(id.short).catch(() => '')
      id = findVideoId(real)
      if (!id || id.short) return { ok: false, message: '短链打不开' }
    }
    const x = await lookAt(id)
    memory?.addEvent?.({ text: `看了别人发来的 B 站视频《${x.info.title}》`, tags: ['B站'], importance: 0.4 })
    return { ok: true, message: x.digest, bvid: x.info.bvid, aid: x.info.aid, title: x.info.title }
  }

  /** 在某个视频下发评论（主人让她发的）。 */
  async function comment(text, message) {
    const w = await watch(text)
    if (!w.ok) return w
    if (getConfig().dryRun) return { ok: true, message: `试运行：本来要在《${w.title}》下评论：${message}` }
    await api.postComment(w.aid, String(message).slice(0, 200))
    memory?.addEvent?.({ text: `在B站《${w.title}》下评论：${String(message).slice(0, 60)}`, tags: ['B站'], importance: 0.45 })
    const s = load(); record(s, { kind: 'comment', title: w.title, bvid: w.bvid, text: message }); save(s)
    return { ok: true, message: `评论发出去了（《${w.title}》）` }
  }

  /** 改自己的 B 站签名（权限在模块里查）。 */
  async function setSign(text) {
    const sign = String(text || '').trim()
    if (!sign) return { ok: false, message: '签名不能是空的' }
    if ([...sign].length > 70) return { ok: false, message: 'B 站签名最多 70 个字' }
    if (getConfig().dryRun) return { ok: true, message: `试运行：本来要把 B 站签名改成：${sign}` }
    if (!parseCookie(cfg().cookie).bili_jct) return { ok: false, message: '没登录 B 站，改不了签名' }
    await api.setSign(sign)
    memory?.addEvent?.({ text: `把B站签名改成了：${sign.slice(0, 70)}`, tags: ['B站'], importance: 0.35 })
    return { ok: true, message: `B 站签名改好了：${sign}` }
  }

  /** 换 B 站头像。file 是已经过 avatarSource 校验的 http(s) 网址。 */
  async function setAvatar(file) {
    if (!/^https?:\/\//i.test(String(file || ''))) return { ok: false, message: '头像只能用网址图片，或者刚才发的那张图' }
    if (getConfig().dryRun) return { ok: true, message: `试运行：本来要把 B 站头像换成：${file}` }
    if (!parseCookie(cfg().cookie).bili_jct) return { ok: false, message: '没登录 B 站，换不了头像' }
    try {
      await api.setFace(file)
    } catch (error) {
      return { ok: false, message: `B 站头像没换成：${error.message}` }
    }
    memory?.addEvent?.({ text: '换了B站头像', tags: ['B站'], importance: 0.35 })
    return { ok: true, message: 'B 站头像换好了（B 站可能要审核一会儿才显示）' }
  }

  /** 每分钟调一次：醒着的时候按间隔刷、看回复。 */
  async function tick() {
    const g = getConfig()
    const c = g.bili
    if (!g.enabled || !c.enabled) return
    const h = new Date().getHours()
    if (h < g.speakUp.awakeFrom || h >= g.speakUp.awakeTo) return
    const s = today(load())
    if (c.reply && Date.now() - (s.lastReplyCheck || 0) > 20 * 60_000 && (await account()).isLogin) await checkReplies()
    if (c.autoBrowse && s.runs < c.maxRunsPerDay && Date.now() - (s.lastRun || 0) > c.intervalHours * 3600_000) await run()
  }

  return {
    run, checkReplies, watch, comment, setSign, setAvatar, tick, account, sendShot, listShots,
    libraryShots, shotFileOf, deleteShot,
    state: () => {
      const s = today(load())
      return { runs: s.runs, comments: s.comments, replies: s.replies, lastRun: s.lastRun, history: s.history.slice(0, 20), canPost: canPost(s), pauseReason: s.pauseDay === dayKey() ? s.pauseReason : '', vision: visionState(cfg()), shots: { count: shots.count() } }
    },
  }
}
