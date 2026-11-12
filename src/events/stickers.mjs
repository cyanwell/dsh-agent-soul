// events · stickers —— 表情库的**发送半边**
// ============================================================================
// aurabot 的表情有两个半边，依赖差得很远：
//   偷表情：收图 → 严格判定 → 去重 → **视觉模型起备注**   （依赖 core/llm.js，重）
//   发表情：按备注/标签匹配本地库 → 取文件 → 发          （只读 index.json，轻）
// 这里只搬**发**的那半。偷留在插件里 —— 偷不到表情不影响她说话，
// 而且那需要 vision 模型，和这次「闭环归 v4」是两件事。
//
// 库位置：<DSH_HOME>/plugins-data/aurabot/stickers/
//   ★ 那是 **plugins-data**，不是插件安装目录 —— 禁用插件不会删数据。
//   ★ 所以 v4 可以直接读它，不需要复制一份（复制了会两边不同步）。
//
// ★ 匹配逻辑照抄 aurabot 的 matchSticker，一个字没改语义：
//   完全相同 10 分 / 包含 6 分 / 共同字 ≥2 个字按比例给分 / 门槛 1.5。
//   改它会让「她挑表情的品味」变，那不是搬，那是重新设计。
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_TAGS = ['开心', '卖萌', '生气', '委屈', '无语', '嘲讽', '疑惑', '早晚安']

/** 模糊匹配：备注 / 标签里包含关键词得分高；完全找不到返回 null。 */
export function matchSticker (items, query) {
  const q = String(query || '').trim()
  if (!q || !Array.isArray(items) || !items.length) return null
  let best = null
  let bestScore = 0
  for (const it of items) {
    const hay = [it.name || '', ...(it.tags || [])]
    let s = 0
    for (const h of hay) {
      if (!h) continue
      if (h === q) s = Math.max(s, 10)
      else if (h.includes(q) || q.includes(h)) s = Math.max(s, 6)
      else {
        const common = [...q].filter((c) => h.includes(c)).length
        if (common >= 2) s = Math.max(s, common / Math.max(q.length, 1) * 4)
      }
    }
    if (s > bestScore) { best = it; bestScore = s }
  }
  return bestScore >= 1.5 ? best : null
}

/** 自动配表情：先按回复里的词匹配，匹配不到就随机挑一张。 */
export function pickForReply (items, replyText, rand = Math.random) {
  if (!Array.isArray(items) || !items.length) return null
  const words = DEFAULT_TAGS.concat(items.flatMap((i) => i.tags || []))
  for (const w of words) {
    if (w && String(replyText).includes(w)) {
      const m = matchSticker(items, w)
      if (m) return m
    }
  }
  return items[Math.floor(rand() * items.length)]
}

function mimeOf2 (file) {
  const e = path.extname(String(file || '')).toLowerCase()
  if (e === '.png') return 'image/png'
  if (e === '.gif') return 'image/gif'
  if (e === '.webp') return 'image/webp'
  return 'image/jpeg'
}

/**
 * createStickerLib({ root, ttlMs, log }) → { pick(tag), view(), dir }
 *
 * ★ 库在磁盘上会被插件改（偷到新表情），所以**带 TTL 缓存**而不是一次读死。
 *   ttl 默认 60 秒：表情是锦上添花，晚一分钟看到新的没关系。
 */
export function createStickerLib (opts = {}) {
  const root = String(opts.root || '').trim()
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const ttlMs = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : 60 * 1000
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
  const rand = typeof opts.rand === 'function' ? opts.rand : Math.random
  const cache = { at: 0, items: null }
  const counters = { picks: 0, misses: 0, reloads: 0, lastError: null }

  function load () {
    if (!root) return []
    if (cache.items && now() - cache.at < ttlMs) return cache.items
    const idx = path.join(root, 'index.json')
    try {
      const j = JSON.parse(fs.readFileSync(idx, 'utf8'))
      const items = Array.isArray(j && j.items) ? j.items.filter((it) => it && it.file) : []
      cache.items = items
      cache.at = now()
      counters.reloads += 1
      return items
    } catch (e) {
      counters.lastError = String((e && e.message) || e).slice(0, 200)
      // ★ 读不到就返回上一次的缓存（而不是空数组）——
      //   库文件被插件同时写坏一次，不该让她整晚都不发表情。
      return cache.items || []
    }
  }

  /**
   * 按标签挑一张，返回 OneBot 消息段 { type:'image', data:{ file } }。
   * ★ 返回的是**段的 data**，由调用方拼成段 —— 这个模块不认识 outbox。
   */
  function pick (tag) {
    const items = load()
    if (!items.length) { counters.misses += 1; return null }
    const it = tag ? (matchSticker(items, tag) || pickForReply(items, '', rand)) : pickForReply(items, '', rand)
    if (!it || !it.file) { counters.misses += 1; return null }
    const abs = path.join(root, String(it.file))
    try {
      if (!fs.existsSync(abs)) { counters.misses += 1; counters.lastError = '文件不存在: ' + it.file; return null }
    } catch { counters.misses += 1; return null }
    counters.picks += 1
    return { file: abs, mime: mimeOf2(abs), name: String(it.name || ''), tags: it.tags || [] }
  }

  return {
    pick,
    load,
    dir: root,
    view () {
      const items = load()
      return {
        root,
        configured: Boolean(root),
        items: items.length,
        picks: counters.picks,
        misses: counters.misses,
        reloads: counters.reloads,
        lastError: counters.lastError,
        ttlMs,
      }
    },
  }
}
