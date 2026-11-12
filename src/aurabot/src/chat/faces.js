// QQ 系统表情（小黄脸）：名字 ↔ 编号。她在回复里写 <face:捂脸>，发的时候换成 QQ 自带的表情，和文字在同一条消息里。
// 目录从网关现取（SnowLuma 的 fetch_sys_faces，缓存一天）；接的是别的 OneBot、取不到时用下面这份常用的兜底。

/** 常用的系统表情（名字 → 编号），取不到网关目录时用。 */
export const COMMON_FACES = {
  惊讶: 0, 撇嘴: 1, 色: 2, 发呆: 3, 得意: 4, 害羞: 6, 闭嘴: 7, 睡: 8, 大哭: 9, 尴尬: 10, 发怒: 11, 调皮: 12, 呲牙: 13, 微笑: 14,
  难过: 15, 酷: 16, 抓狂: 18, 吐: 19, 偷笑: 20, 可爱: 21, 白眼: 22, 傲慢: 23, 困: 25, 惊恐: 26, 流汗: 27, 憨笑: 28, 奋斗: 30,
  疑问: 32, 嘘: 33, 晕: 34, 再见: 39, 玫瑰: 63, 爱心: 66, 心碎: 67, 赞: 76, 擦汗: 97, 抠鼻: 98, 鼓掌: 99, 坏笑: 101, 哈欠: 104,
  鄙视: 105, 委屈: 106, 快哭了: 107, 阴险: 108, 可怜: 111, 抱拳: 118, OK: 124, 无奈: 174, 斜眼笑: 178, 笑哭: 182, 点赞: 201,
  托腮: 212, 捂脸: 264, 哦哟: 266, 头秃: 267, 暗中观察: 269, emm: 270, 吃瓜: 271, 我酸了: 273, 汪汪: 277, 敬礼: 282, 摸鱼: 285,
  睁眼: 289, 拜托: 353, 裂开: 357,
}

/** 给她看的几个例子（提示词里用，别太长）。 */
export const FACE_EXAMPLES = ['微笑', '呲牙', '偷笑', '捂脸', '斜眼笑', '笑哭', '吃瓜', '白眼', '委屈', '裂开', '摸鱼', '抱拳', '赞', 'OK']

const FACE_TAG = /<face:\s*([^>]{1,12}?)\s*>(?:\s*<\/face>)?/g

/**
 * 网关目录（{ packs: [{ pack_name, emojis: [{ q_sid, q_des, emoji_name_alias, is_super }] }] }）→ 名字 / 编号对照。
 * 只要数字编号的（emoji 分组的编号是字符，不是系统表情）；同名的优先普通表情，没有再用超级表情。
 */
export function buildFaceIndex(catalog) {
  const byName = new Map()
  const byId = new Map()
  const entries = []
  for (const p of catalog?.packs || []) for (const e of p.emojis || []) entries.push(e)
  entries.sort((a, c) => Number(Boolean(a.is_super)) - Number(Boolean(c.is_super)))
  for (const e of entries) {
    const id = String(e.q_sid ?? '')
    if (!/^\d+$/.test(id)) continue
    const name = String(e.q_des || '').replace(/^\//, '').trim()
    if (!name) continue
    if (!byId.has(id)) byId.set(id, name)
    for (const n of [name, ...(e.emoji_name_alias || [])].map((x) => String(x).replace(/^\//, '').trim()).filter(Boolean)) {
      if (!byName.has(n)) byName.set(n, Number(id))
    }
  }
  return { byName, byId }
}

const COMMON_INDEX = (() => {
  const byName = new Map(Object.entries(COMMON_FACES))
  const byId = new Map(Object.entries(COMMON_FACES).map(([n, id]) => [String(id), n]))
  return { byName, byId }
})()

/**
 * 把文字里的 <face:名字> 换成 QQ 消息段（文字段和表情段交替）；认不出的名字直接去掉，不把标签原样发出去。
 * idOf(name) → 编号或 undefined。
 */
export function textToSegments(text, idOf) {
  const out = []
  const s = String(text ?? '')
  let last = 0
  for (const m of s.matchAll(FACE_TAG)) {
    if (m.index > last) out.push({ type: 'text', data: { text: s.slice(last, m.index) } })
    const id = idOf(m[1])
    if (id !== undefined && id !== null) out.push({ type: 'face', data: { id: String(id) } })
    last = m.index + m[0].length
  }
  if (last < s.length) out.push({ type: 'text', data: { text: s.slice(last) } })
  // 相邻的文字段合并；整条只剩空白的文字段去掉
  const merged = []
  for (const seg of out) {
    const prev = merged[merged.length - 1]
    if (seg.type === 'text' && prev?.type === 'text') prev.data.text += seg.data.text
    else merged.push(seg)
  }
  return merged.filter((seg) => seg.type !== 'text' || seg.data.text.trim())
}

/** 去掉文字里的 <face:…> 标签（系统表情关着时用）。 */
export const stripFaceTags = (text) => String(text ?? '').replace(FACE_TAG, '').replace(/[ \t]{2,}/g, ' ').trim()

/**
 * 语音条要念的文字：去掉 QQ 小黄脸标签、表情包/戳一戳等格式标签、以及 emoji 图形符号，
 * 不然 TTS 会把「呲牙」这类表情名字甚至 emoji 直接念出来（用户反馈：发语音时表情被读出来）。
 * 去掉后没字可念时返回空串，由调用方决定改发文字。
 */
export function speakableText (text) {
  return String(text ?? '')
    .replace(FACE_TAG, '')
    .replace(/<sticker:[^>]*>(?:\s*<\/sticker>)?/g, '')
    .replace(/<poke\s*\/?>/g, '')
    .replace(/<\/?voice>/g, '')
    .replace(/[\p{Extended_Pictographic}\u200D\uFE0F\u20E3]/gu, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/** 系统表情对照：先用常用的，第一次用到时再去网关拉完整目录（一天刷新一次）。 */
export function createFaces({ onebot, log } = {}) {
  let index = COMMON_INDEX
  let at = 0
  let loading = null
  function refresh() {
    if (loading || (at && Date.now() - at < 24 * 3600_000)) return loading
    loading = Promise.resolve(onebot?.call?.('fetch_sys_faces', {}, { timeoutMs: 15000 }))
      .then((r) => {
        const built = buildFaceIndex(r?.packs ? r : r?.data)
        if (built.byName.size) index = { byName: new Map([...COMMON_INDEX.byName, ...built.byName]), byId: new Map([...COMMON_INDEX.byId, ...built.byId]) }
      })
      .catch((error) => log?.debug?.('取 QQ 系统表情目录失败，用内置的常用表情：', error.message))
      .finally(() => { at = Date.now(); loading = null })
    return loading
  }
  return {
    refresh,
    idOf: (name) => { refresh(); return index.byName.get(String(name || '').replace(/^\//, '').trim()) },
    nameOf: (id) => { refresh(); return index.byId.get(String(id)) },
  }
}
