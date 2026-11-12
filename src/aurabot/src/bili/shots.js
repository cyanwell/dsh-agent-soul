// 截图库：抽帧时顺手把画面存下来，之后她自己发、或主人让她挑一张发出来。
//
// 存 ~/.dsh/plugins-data/aurabot/bili-shots/：每张一个 jpg + 一个 index.json。
// 按 MD5 去重（同一个视频重看一遍不会又存一遍），只留最近 max 张，超了删最旧的。

import { createHash } from 'node:crypto'
import { unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir, ensureDir, existsSync, readJson, writeJson } from '../core/store.js'

const dir = () => dataDir('bili-shots')
const indexFile = () => join(dir(), 'index.json')
const validFile = (file) => typeof file === 'string' && /^[a-f0-9]{12}\.jpg$/.test(file)

export function loadShots() {
  const s = readJson(indexFile(), () => ({ items: [] }))
  return { items: s && Array.isArray(s.items) ? s.items.filter((i) => i && validFile(i.file)) : [] }
}

function saveShots(s) {
  writeJson(indexFile(), s)
}

/** 截图文件在本机的绝对路径。 */
export function shotPath(item) {
  return validFile(item?.file) ? join(dir(), item.file) : ''
}

/** 秒数 → mm:ss，给「看哪一张」和回话用。 */
export function clockOf(sec) {
  const n = Number.isFinite(Number(sec)) ? Math.max(0, Math.round(Number(sec))) : 0
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`
}

/**
 * 挑一张：给了条件就按视频标题 / 备注匹配，匹配不到返回 null（让她知道没有这张，
 * 可以不带条件再挑一张最近的）；不给条件就返回最近的一张。
 */
export function pickShot(items, query = '') {
  const list = Array.isArray(items) ? items : []
  if (!list.length) return null
  const q = String(query || '').trim()
  if (!q) return list[0]
  let best = null
  let bestScore = 0
  for (const it of list) {
    const hay = [it.title || '', it.note || '']
    let s = 0
    for (const h of hay) {
      if (!h) continue
      if (h.includes(q)) s = Math.max(s, 10)
      else {
        // 按字的命中比例给个分：至少命中两个字才算
        const hit = [...q].filter((ch) => h.includes(ch)).length
        if (hit >= 2) s = Math.max(s, (hit / q.length) * 5)
      }
    }
    if (s > bestScore) { best = it; bestScore = s }
  }
  return bestScore >= 2 ? best : null
}

export function createShotStore({ max = 300 } = {}) {
  // max 可以是数字，也可以是个函数（面板里改上限后立刻生效）
  const cap = () => {
    const v = typeof max === 'function' ? max() : max
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 300
  }

  /** 收一张帧。meta 里的 bvid / title / sec / note 会一起记下来。 */
  function put(buf, meta = {}) {
    try {
      const md5 = createHash('md5').update(buf).digest('hex').slice(0, 12)
      const s = loadShots()
      const exist = s.items.find((i) => i.md5 === md5)
      if (exist) {
        // 同一个视频重看一遍：补一下标题 / 备注就好，不重复存
        if (meta.title && !exist.title) exist.title = String(meta.title)
        if (meta.note && !exist.note) exist.note = String(meta.note)
        saveShots(s)
        return exist
      }
      ensureDir(dir())
      const file = md5 + '.jpg'
      writeFileSync(join(dir(), file), buf)
      const item = {
        md5,
        file,
        at: Date.now(),
        bytes: buf.length,
        bvid: String(meta.bvid || ''),
        title: String(meta.title || ''),
        sec: Number(meta.sec) || 0,
        note: String(meta.note || '').slice(0, 200),
      }
      s.items.unshift(item)
      // 超过上限就删最旧的（列表尾 = 最旧）
      while (s.items.length > cap()) {
        const out = s.items.pop()
        try { unlinkSync(join(dir(), out.file)) } catch (error) {}
      }
      saveShots(s)
      return item
    } catch (error) {
      return null
    }
  }

  function list(query = '') {
    const items = loadShots().items
    const q = String(query || '').trim()
    if (!q) return items
    return items.filter((i) => (i.title || '').includes(q) || (i.note || '').includes(q))
  }

  /** 按当前上限裁掉最旧的几张，返回删了几张。 */
  function trim() {
    const s = loadShots()
    let n = 0
    while (s.items.length > cap()) {
      const out = s.items.pop()
      try { unlinkSync(join(dir(), out.file)) } catch (error) {}
      n++
    }
    if (n) saveShots(s)
    return n
  }

  /** 删掉库里指定的一张（面板手动删）。 */
  function remove(file) {
    const name = String(file || '').trim()
    if (!name) return { ok: false, message: '没说要删哪张' }
    const s = loadShots()
    const it = s.items.find((i) => i.file === name)
    if (!it) return { ok: false, message: '库里没有这张' }
    try { unlinkSync(shotPath(it)) } catch (error) {
      if (error.code !== 'ENOENT') return { ok: false, message: '截图没删掉：' + error.message }
    }
    s.items = s.items.filter((i) => i.file !== name)
    saveShots(s)
    return { ok: true, message: `删掉了《${it.title || '截图'}》${clockOf(it.sec)} 那一张` }
  }

  /** 面板用：先按上限裁一遍，再给出带 mm:ss 的完整列表。 */
  function panel() {
    trim()
    return loadShots().items.map((i) => ({ ...i, clock: clockOf(i.sec), limit: cap() }))
  }

  return {
    put,
    list,
    trim,
    remove,
    panel,
    pick: (query) => pickShot(list(), query),
    count: () => loadShots().items.length,
    exists: (item) => Boolean(item && existsSync(shotPath(item))),
    path: shotPath,
  }
}
