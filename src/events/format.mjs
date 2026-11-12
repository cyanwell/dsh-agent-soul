// events · format —— 把会话回复的正文转成 OneBot 消息段
// ============================================================================
// 为什么需要它（2026-11-12 实测）：
//   会话回复里会带 agent 侧约定的标记 —— <at:1901372960>、<reply:1835071060>、
//   <poke/>、<voice>…</voice>、<sticker:标签>，还有 ||| 分条。
//   那是给 aurabot 的 reply.js 看的。v4 之前直接把正文当纯文本发，
//   群里就出现了字面量 <at:1901372960> —— 2026-11-12 03:51:04 真实发生过。
//
// ★ 语义照抄 aurabot 的两个文件，不自己发明：
//   chat/reply.js    —— ||| 分条、<reply:N> 引用、<voice>/<sticker>/<poke>、![alt](url) 图片
//   chat/mentions.js —— <at:QQ号> → {type:'at'}；名字形式要查群成员，v4 没有那个列表
//
// ★ 三条取舍（都是有意的）：
//   ① 只转 QQ 号形式的 @。<at:名字> 需要群成员表（aurabot 调 get_group_member_list），
//      v4 手上没有 —— 不猜、不降级成文字，原样保留并在 missedAt 里报出来。
//   ② 转不了的东西要说出来，不能静默丢掉。missedAt / dropped 就是那份名单。
//   ③ 语音/表情/戳一戳暂不支持：剥掉标记留文字，但不假装发出去了。
// ============================================================================

/** <at:123> / <at: 123 > / <at:某人的名字> */
const AT_TAG = /<at:\s*([^>]{1,30}?)\s*>/g
/** <reply:123> */
const REPLY_TAG = /<reply:\s*(\d+)\s*>/g
/** 整轮的沉默标记（与 reply.js 的 SILENCE 同一组） */
const SILENCE = '[沉默]'

export function isSilence (text) {
  const t = String(text == null ? '' : text).trim()
  return t === '' || t === SILENCE || t === '［沉默］' || t === '(沉默)' || t === '（沉默）'
}

/** 纯数字 → 当成 QQ 号；否则是名字（v4 转不了）。 */
function parseAtTarget (raw) {
  const s = String(raw == null ? '' : raw).trim()
  if (!s) return null
  if (/^\d{5,12}$/.test(s)) return { kind: 'qq', qq: s }
  return { kind: 'name', name: s }
}

/** 把一段正文转成 OneBot 消息段数组。 */
export function toSegments (text, opts = {}) {
  const raw = String(text == null ? '' : text)
  if (isSilence(raw)) return { ok: false, code: 'FORMAT_SILENT', segments: [], missedAt: [], dropped: [] }

  const missedAt = []
  const dropped = []
  const segments = []
  const pushText = (s) => {
    const v = String(s == null ? '' : s)
    if (!v) return
    const lastSeg = segments[segments.length - 1]
    if (lastSeg && lastSeg.type === 'text') { lastSeg.data.text += v; return }
    segments.push({ type: 'text', data: { text: v } })
  }

  // ① 先抽 @ 与 reply，剩下的当文字。一次扫描，避免互相吃掉。
  const tokenRe = new RegExp(AT_TAG.source + '|' + REPLY_TAG.source, 'g')
  let last = 0
  let m
  while ((m = tokenRe.exec(raw)) !== null) {
    pushText(raw.slice(last, m.index))
    if (m[1] !== undefined) {
      const target = parseAtTarget(m[1])
      if (target && target.kind === 'qq') segments.push({ type: 'at', data: { qq: target.qq } })
      else if (target && target.kind === 'name') {
        // 转不了：保留原文（不要吃掉她写的名字），并记一笔让调用方知道。
        pushText(m[0])
        missedAt.push(target.name)
      }
    } else if (m[2] !== undefined) {
      segments.push({ type: 'reply', data: { id: String(m[2]) } })
    }
    last = tokenRe.lastIndex
  }
  pushText(raw.slice(last))

  // ② 重建：text 段里可能藏着 <sticker:标签>，要**切开**成独立的 sticker 段。
  //
  //   ★ 不能在 for 循环里往同一个数组 push（会边遍历边长）。
  //     也不能先把 sticker 剥掉再事后拼 —— 那样表情会掉到整段最后，
  //     而她写的位置是有意义的（「笑死<sticker:笑哭>这什么」）。
  const rebuilt = []
  for (const seg of segments) {
    if (seg.type !== 'text') { rebuilt.push(seg); continue }
    // 先处理 voice（它包着要念的字）
    // ★★ 2026-11-12：<voice> 不再"保留里面的话当文字"，而是**切出独立的 voice 段**。
    //   以前的做法是「念不出来就发字」—— 但那不是她要的效果：
    //   她写 <voice> 就是要用说的。真念不出来时由 respond 决定退回文字还是跳过。
    let t = String(seg.data.text || '')
    const voiceParts = t.split(/(<voice>[\s\S]*?<\/voice>)/g)
    if (voiceParts.length > 1) {
      for (const vp of voiceParts) {
        if (!vp) continue
        const vm = /^<voice>([\s\S]*?)<\/voice>$/.exec(vp)
        if (vm) {
          const speech = String(vm[1] || '').trim()
          if (speech) rebuilt.push({ type: 'voice', data: { text: speech } })
        } else {
          const vclean = vp.trim()
          if (vclean) rebuilt.push({ type: 'text', data: { text: vclean } })
        }
      }
      continue
    }
    // 按 sticker 标记切成若干片，标记本身留在 split 结果里
    const parts = t.split(/(<sticker:\s*[^>]+?\s*>(?:\s*<\/sticker>)?)/g)
    for (const part of parts) {
      if (!part) continue
      const m = /^<sticker:\s*([^>]+?)\s*>/.exec(part)
      if (m) {
        const tag = String(m[1] || '').trim()
        if (tag) rebuilt.push({ type: 'sticker', data: { tag } })
        else dropped.push('sticker')
        continue
      }
      let x = part
      // ★★ 2026-11-12：戳一戳不再剥掉 —— 转成一段交给 respond。
      //   ★ 戳一戳是**独立动作**，不是消息段：QQ 的 send_poke 是另一个 API，
      //     所以它不能混在一条消息里发（respond 会单独调）。
      if (/<poke\s*\/?>/.test(x)) {
        x = x.replace(/<poke\s*\/?>/g, '')
        rebuilt.push({ type: 'poke', data: {} })
      }
      x = x.replace(/!\[[^\]]*\]\(\s*([^)\s]+)\s*\)/g, (_, url) => { dropped.push('image:' + String(url).slice(0, 60)); return '[图片]' })
      x = x.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/`([^`\n]+)`/g, '$1')
      const clean = x.trim()
      if (clean) rebuilt.push({ type: 'text', data: { text: clean } })
    }
  }

  // ③ 只留"能发出去"的东西。
  //   ★ 表情也算 —— 不然一句「笑死<sticker:笑哭>」会被判成空消息丢掉。
  const cleaned = rebuilt.filter((s) => s.type !== 'text' || String(s.data.text || '').length > 0)
  if (!cleaned.some((s) => s.type === 'text' || s.type === 'at' || s.type === 'sticker' || s.type === 'voice' || s.type === 'poke')) {
    return { ok: false, code: 'FORMAT_EMPTY', segments: [], missedAt, dropped }
  }
  return { ok: true, segments: cleaned, missedAt, dropped }
}

/** 按 ||| 分条（与 reply.js 一致）。每条独立转段。 */
export function toMessages (text, opts = {}) {
  const raw = String(text == null ? '' : text)
  const maxBubbles = Number(opts.maxBubbles) > 0 ? Number(opts.maxBubbles) : 3
  const missedAt = []
  const dropped = []
  const messages = []
  for (const part of raw.split('|||')) {
    const r = toSegments(part, opts)
    if (r.missedAt.length) missedAt.push(...r.missedAt)
    if (r.dropped.length) dropped.push(...r.dropped)
    if (r.ok) messages.push({ segments: r.segments })
    if (messages.length >= maxBubbles) break
  }
  if (!messages.length) return { ok: false, code: 'FORMAT_EMPTY', messages: [], missedAt, dropped }
  return { ok: true, messages, missedAt, dropped }
}

/**
 * 把正文里 <at:名字> 形式的 @ 预先解析成 <at:QQ号>。
 *
 * ★ 为什么单独一步：toSegments 是**同步纯函数**（自检要能直接喂字符串），
 *   而查名字必须走网络（OneBot get_group_member_list）。
 *   所以先异步把名字换成号，再交给 toSegments —— 这样纯函数仍然是纯的。
 *
 * ★ 解析不到的名字**原样保留**（不猜、不删），并在 unresolved 里报出来。
 *   调用方据此决定要不要告警；绝不允许静默降级成文字。
 *
 * @param {string} text
 * @param {(name:string)=>Promise<string|null>} resolveName  名字 → QQ 号，解析不到返回 null
 * @returns {Promise<{text:string, resolved:Array<{name:string,qq:string}>, unresolved:string[], failed:string[]}>}
 */
export async function resolveMentions (text, resolveName, opts = {}) {
  const raw = String(text == null ? '' : text)
  const resolved = []
  const unresolved = []
  const failed = []
  if (typeof resolveName !== 'function') return { text: raw, resolved, unresolved: [...raw.matchAll(AT_TAG)].map((m) => String(m[1] || '').trim()).filter((s) => s && !/^\d+$/.test(s)), failed }

  // ★ 逐个替换：不要先收集再统一替换 —— 同一个名字出现两次时下标会错位。
  let out = ''
  let last = 0
  const re = new RegExp(AT_TAG.source, 'g')
  let m
  while ((m = re.exec(raw)) !== null) {
    out += raw.slice(last, m.index)
    const name = String(m[1] || '').trim()
    last = re.lastIndex
    if (!name) { continue }
    if (/^\d{5,12}$/.test(name)) { out += m[0]; continue }  // 本来就是号，不动
    let qq = null
    try {
      qq = await resolveName(name)
    } catch (e) {
      failed.push(name + ':' + String((e && e.message) || e).slice(0, 60))
      out += m[0]
      continue
    }
    const s = String(qq == null ? '' : qq).trim()
    if (/^\d{5,12}$/.test(s)) {
      out += '<at:' + s + '>'
      resolved.push({ name, qq: s })
    } else {
      out += m[0]
      unresolved.push(name)
    }
  }
  out += raw.slice(last)
  return { text: out, resolved, unresolved, failed }
}
