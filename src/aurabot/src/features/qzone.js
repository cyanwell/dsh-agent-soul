// QQ 空间：发说说 + 空间日记（每天 N 次，时间窗里随机，结合当天聊天）。

import { dataDir, readJson, writeJson } from '../core/store.js'
import { fetchImage } from '../core/net.js'
import { resolveAudience } from './qzone-audience.js'

const toMin = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number)
  return h * 60 + m
}
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** 给某一天排日记时间：窗口内随机 n 个时刻，两两间隔 ≥ gap 分钟。纯函数（rand 可注入）。 */
export function planDiaryTimes({ timesPerDay, windowStart, windowEnd, minGapMinutes }, rand = Math.random) {
  const a = toMin(windowStart)
  const b = toMin(windowEnd)
  const n = Math.max(0, Math.round(timesPerDay))
  if (n === 0 || b <= a) return []
  const span = b - a
  const gap = Math.min(minGapMinutes, Math.floor(span / Math.max(n, 1)))
  for (let attempt = 0; attempt < 200; attempt++) {
    const pts = Array.from({ length: n }, () => a + Math.floor(rand() * span)).sort((x, y) => x - y)
    if (pts.every((p, i) => i === 0 || p - pts[i - 1] >= gap)) return pts
  }
  // 实在排不开就均分
  return Array.from({ length: n }, (_, i) => a + Math.floor((span / n) * (i + 0.5)))
}

export function createQzone({ getConfig, onebot, hub, log, onDiary, pickImage }) {
  const file = () => dataDir('diary.json')
  const state = () => readJson(file(), () => ({ plan: { day: '', times: [], done: [] }, history: [] }))
  const save = (s) => writeJson(file(), s)
  let busy = false

  async function post(content, { images = [], visibility } = {}) {
    const cfg = getConfig()
    const text = String(content || '').trim()
    if (!text) return { ok: false, message: '说说是空的' }
    // 面板定的范围说了算；单次请求只能收窄成「仅自己」，不能扩大。
    let audience
    try { audience = resolveAudience(cfg, visibility) } catch (error) { return { ok: false, message: error.message } }
    if (!cfg.enabled) return { ok: false, message: '总开关关着' }
    if (cfg.dryRun) {
      log.info(`试运行：本来要发说说（${audience.label}）：${text.slice(0, 60)}`)
      return { ok: true, tid: '', dryRun: true, visibility: audience.visibility, label: audience.label, target_uins: audience.target_uins || [] }
    }
    const imgs = []
    for (const src of images) {
      try {
        imgs.push('base64://' + (await fetchImage(src, { maxBytes: 8 * 1024 * 1024 })).toString('base64'))
      } catch (error) {
        log.warn('说说配图读不到，跳过：', error.message)
      }
    }
    try {
      // 下载图片可能花几秒，发布前用最新配置再算一次，免得中途改了范围还按旧的发出去。
      const latest = getConfig()
      audience = resolveAudience(latest, visibility)
      if (!latest.enabled || latest.dryRun) return { ok: false, message: '发布前开关已变化，本次未发布。' }
      const r = await onebot.call('send_qzone_msg', { content: text, ugc_right: audience.ugc_right, ...(audience.target_uins ? { target_uins: audience.target_uins } : {}), ...(imgs.length ? { images: imgs } : {}) }, { timeoutMs: 60000 })
      const tid = String(r?.tid ?? r?.id ?? r ?? '')
      log.info(`发了一条说说（${audience.label}，tid ${tid || '?'}）`)
      return { ok: true, tid, visibility: audience.visibility, label: audience.label, target_uins: audience.target_uins || [] }
    } catch (error) {
      log.warn('发说说失败：', error.message)
      return { ok: false, message: error.message }
    }
  }

  async function remove(tid) {
    tid = String(tid || '').trim()
    if (!tid) throw new Error('缺少说说 ID')
    const result = await onebot.call('delete_qzone_msg', { tid })
    const s = state()
    let changed = false
    for (const entry of s.history) {
      if (String(entry.tid) === tid) {
        entry.deletedAt = Date.now()
        changed = true
      }
    }
    if (changed) save(s)
    return result
  }

  // 空间里的删除不一定经过本插件（手机上删、被系统删），所以定期拿空间列表和本地记录对账。
  // 只有完整读完列表才敢把缺失的记录判成“已删除”，读不全就只返回提示，绝不动数据。
  let syncingHistory = null
  function syncHistory() {
    if (syncingHistory) return syncingHistory
    syncingHistory = (async () => {
      if (!state().history.some((d) => d.tid && d.ok && !d.dryRun && !d.deletedAt)) return { ok: true }
      try {
        const startedAt = Date.now()
        const ids = new Set()
        let total = null
        let complete = false
        let pos = 0
        // #70：SnowLuma 单页上限约 30，请求 num=100 会被网关截断成 10 条（num=200 直接 0 条），
        // 再按 100 步进 pos 会错位、读不全。现在按 30 一页、按实际返回条数推进，
        // 并以「没有新 id / 没有新页」作为停止条件，不假设网关一定按请求页大小给。
        const PAGE = 30
        for (let pages = 0; pages < 200; pages++) {
          const page = await onebot.call('get_qzone_msg_list', { pos, num: PAGE }, { timeoutMs: 12000 })
          if (!Array.isArray(page?.msglist) || !Number.isInteger(page.total) || page.total < 0) throw new Error('空间列表格式不完整')
          if (total !== null && total !== page.total) throw new Error('空间列表正在变化，请稍后刷新')
          total = page.total
          let added = 0
          for (const item of page.msglist) {
            if (!item?.tid) throw new Error('空间列表缺少说说 ID')
            const tid = String(item.tid)
            if (!ids.has(tid)) { ids.add(tid); added++ }
          }
          if (ids.size >= total) { complete = true; break }
          // 空页 / 网关反复返回同一页：没有新内容就停，读不完整也不判删除
          if (!page.msglist.length || added === 0) break
          pos += page.msglist.length
        }
        const s = state()
        const checkedAt = Date.now()
        for (const entry of s.history) {
          if (!entry.tid || !entry.ok || entry.dryRun || entry.deletedAt || entry.at > startedAt) continue
          if (ids.has(String(entry.tid))) entry.remoteCheckedAt = checkedAt
          else if (complete) { entry.deletedAt = checkedAt; entry.deletedSource = 'space-list' }
        }
        save(s)
        return { ok: true, ...(complete ? {} : { warning: '空间列表未完整读取，未将缺失记录判定为已删除。' }) }
      } catch (error) {
        return { ok: false, warning: '未能核对空间状态：' + error.message + '；保留原有记录。' }
      }
    })().finally(() => { syncingHistory = null })
    return syncingHistory
  }

  function todayExcerpt(maxLines = 60) {
    const lines = hub.chatLogOf(dayKey())
      .filter((l) => !String(l.chatId).startsWith('system:'))
      .slice(-maxLines)
      .map((l) => `${new Date(l.t).toTimeString().slice(0, 5)} ${l.who === 'bot' ? '我' : l.who}：${l.text}`)
    return lines.join('\n')
  }

  /** 写一篇并发出去。 */
  async function writeDiary({ visibility } = {}) {
    if (busy) return { ok: false, message: '上一篇还在写' }
    busy = true
    try {
      const cfg = getConfig().diary
      // 名单/范围不合法就别让模型白写一篇再失败
      try { resolveAudience(getConfig(), visibility) } catch (error) { return { ok: false, message: error.message } }
      const now = new Date()
      const excerpt = todayExcerpt()
      const prompt = [
        `【写空间日记】现在是 ${now.getMonth() + 1} 月 ${now.getDate()} 日 ${now.toTimeString().slice(0, 5)}。`,
        excerpt ? `今天你在 QQ 上的聊天片段（「我」是你自己）：\n${excerpt}` : '今天还没怎么聊天。',
        `请用你自己的口吻写一条 QQ 空间说说，第一人称，${cfg.minChars}~${cfg.maxChars} 个字，像真人随手发的动态：可以写今天发生的小事、心情、想吃的白米饭。`,
        '不要分条、不要 |||、不要 <voice>/<sticker> 标记、不要 Markdown、不要加引号，只输出说说正文本身。',
      ].join('\n\n')
      let text = await hub.runSystemTurn('diary', '空间日记', prompt)
      text = String(text || '').replace(/\|\|\|/g, ' ').replace(/<[^>]+>/g, '').replace(/^["「“]|["」”]$/g, '').trim()
      if (text.length > cfg.maxChars + 20) text = text.slice(0, cfg.maxChars + 20)
      if (!text || text === '[沉默]') return { ok: false, message: '她这次没写出来' }
      // 配图：面板「日记配图」开着时，从今天画的图 / 今天收的表情包里挑一张；挑不到就只发文字
      const images = []
      if (cfg.attachImage !== false) {
        try {
          const img = await pickImage?.()
          if (img) images.push(img)
        } catch (error) { log.warn('日记配图没挑成：', error.message) }
      }
      if (images.length) log.info(`日记配图：${images[0]}`)
      let r = await post(text, { visibility, images })
      // 配图发不出去（比如空间不认这张图）不能把整篇日记憋回去：退回只发文字，日记照发
      if (!r.ok && images.length) {
        log.warn('日记配图没发成，改成只发文字：', r.message)
        images.length = 0
        r = await post(text, { visibility })
      }
      const s = state()
      s.history.unshift({ at: Date.now(), text, ok: r.ok, tid: r.tid || '', dryRun: Boolean(r.dryRun), visibility: r.visibility || visibility || cfg.visibility, target_uins: r.target_uins || [], error: r.ok ? '' : r.message })
      s.history = s.history.slice(0, 100)
      save(s)
      if (r.ok && !r.dryRun) {
        try { onDiary?.(text) } catch (error) {}
      }
      return { ...r, text, images: images.length }
    } catch (error) {
      log.warn('写日记失败：', error.message)
      return { ok: false, message: error.message }
    } finally {
      busy = false
    }
  }

  /** 每分钟调一次。 */
  async function tick() {
    const cfg = getConfig()
    if (!cfg.enabled || !cfg.diary.enabled) return
    const s = state()
    const today = dayKey()
    if (s.plan.day !== today) {
      s.plan = { day: today, times: planDiaryTimes(cfg.diary), done: [] }
      save(s)
      log.info(`今天的日记时间：${s.plan.times.map((m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`).join('、') || '（不写）'}`)
    }
    const now = new Date()
    const nowMin = now.getHours() * 60 + now.getMinutes()
    const due = s.plan.times.find((m) => m <= nowMin && !s.plan.done.includes(m))
    if (due === undefined) return
    s.plan.done.push(due)
    save(s)
    log.info('到点了，写一篇空间日记')
    await writeDiary()
  }

  function nextTime() {
    const s = state()
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes()
    const m = s.plan.day === dayKey() ? s.plan.times.find((x) => !s.plan.done.includes(x) && x >= nowMin) : undefined
    return m === undefined ? '' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  }

  return { post, remove, writeDiary, tick, syncHistory, history: () => state().history, nextTime }
}
