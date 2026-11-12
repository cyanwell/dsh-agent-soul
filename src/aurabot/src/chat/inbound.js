// 把一条 OneBot v11 消息事件拆成插件好用的形状。纯函数。

/** 消息段数组（兼容字符串 CQ 码：只取纯文字）。 */
export function segmentsOf(event) {
  const m = event && event.message
  if (Array.isArray(m)) return m.filter((s) => s && typeof s === 'object')
  if (typeof m === 'string') return [{ type: 'text', data: { text: m.replace(/\[CQ:[^\]]*\]/g, '') } }]
  return []
}

/** 这个段是不是「表情包」（不是普通照片）。判定必须严格。 */
export function isStickerSegment(seg) {
  if (!seg || !seg.data) return false
  if (seg.type === 'mface') return true
  if (seg.type !== 'image') return false
  const d = seg.data
  if (String(d.sub_type ?? d.subType ?? '') === '1') return true
  if (d.emoji_id || d.emojiId) return true
  return false
}

/**
 * @param {object} event OneBot 消息事件
 * @param {string|number} selfId 机器人 QQ
 * @returns {{
 *   kind: 'private'|'group', chatId: string, userId: string, groupId: string,
 *   nickname: string, role: string, messageId: string, text: string,
 *   mentioned: boolean, replyId: string, images: object[], stickers: object[], records: object[],
 * }}
 */
export function parseMessageEvent(event, selfId, { faceName } = {}) {
  const self = String(selfId || event.self_id || '')
  const kind = event.message_type === 'group' ? 'group' : 'private'
  const userId = String(event.user_id ?? event.sender?.user_id ?? '')
  const groupId = kind === 'group' ? String(event.group_id ?? '') : ''
  const sender = event.sender || {}
  let mentioned = false
  let replyId = ''
  const texts = []
  const images = []
  const stickers = []
  const records = []
  const forwards = [] // 合并转发的 id
  for (const seg of segmentsOf(event)) {
    const d = seg.data || {}
    switch (seg.type) {
      case 'text':
        texts.push(String(d.text ?? ''))
        break
      case 'at':
        if (String(d.qq) === self || d.qq === 'all') mentioned = mentioned || String(d.qq) === self
        else texts.push(`@${d.name || d.qq} `)
        break
      case 'reply':
        replyId = String(d.id ?? '')
        break
      case 'face': {
        // QQ 系统表情按名字给她看（「[捂脸]」），认不出才写「[表情]」
        const name = faceName?.(d.id)
        texts.push(name ? `[${name}]` : d.raw?.faceText || '[表情]')
        break
      }
      case 'image':
      case 'mface':
        if (isStickerSegment(seg)) {
          stickers.push(seg)
          texts.push(d.summary ? `${d.summary}` : '[表情包]')
        } else {
          images.push(seg)
          texts.push('[图片]')
        }
        break
      case 'record':
        records.push(seg)
        break
      case 'video':
        texts.push('[视频]')
        break
      case 'file':
        texts.push(`[文件 ${d.name || d.file || ''}]`)
        break
      case 'json':
        texts.push(cardText(d.data))
        break
      case 'xml':
        texts.push('[卡片消息]')
        break
      case 'poke':
        texts.push('[戳一戳]')
        break
      case 'forward': {
        // 合并转发：先放个占位，收到后再去拉里面的聊天记录展开
        const id = String(d.id ?? d.res_id ?? d.forward_id ?? '')
        if (id) forwards.push(id)
        texts.push('[合并转发]')
        break
      }
      default:
        break
    }
  }
  const text = texts.join('').replace(/\s+\n/g, '\n').trim()
  return {
    kind,
    chatId: kind === 'group' ? `group:${groupId}` : `private:${userId}`,
    userId,
    groupId,
    nickname: String(sender.card || sender.nickname || userId),
    role: String(sender.role || ''),
    messageId: String(event.message_id ?? ''),
    text,
    mentioned,
    replyId,
    images,
    stickers,
    records,
    forwards,
  }
}

/** 偷表情的尺寸兜底（拿到字节、宽高之后再判）。 */
export function stickerSizeOk({ width, height, bytes }, limits = {}) {
  const maxSide = limits.maxSide ?? 520
  const maxBytes = limits.maxBytes ?? 1.5 * 1024 * 1024
  if (!(bytes > 0) || bytes > maxBytes) return false
  if (!(width > 0) || !(height > 0)) return true // 读不出尺寸就只看体积
  if (width > maxSide || height > maxSide) return false
  const r = width / height
  return r >= 0.75 && r <= 1.33
}

/** 从图片字节里读宽高（PNG / GIF / JPEG / WEBP），读不出返回 0。 */
export function imageSize(buf) {
  try {
    if (!buf || buf.length < 24) return { width: 0, height: 0 }
    if (buf[0] === 0x89 && buf[1] === 0x50) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    if (buf[0] === 0x47 && buf[1] === 0x49) return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) {
      const chunk = buf.toString('ascii', 12, 16)
      if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
      if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
      if (chunk === 'VP8L') {
        const b = buf.readUInt32LE(21)
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }
      }
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue }
        const marker = buf[i + 1]
        const len = buf.readUInt16BE(i + 2)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) }
        }
        i += 2 + len
      }
    }
  } catch (error) {}
  return { width: 0, height: 0 }
}

/** QQ 分享卡片（B 站 / 链接分享）里认出标题和链接；认不出就是「[卡片消息]」。 */
export function cardText(raw) {
  try {
    const j = typeof raw === 'string' ? JSON.parse(raw) : raw
    const meta = j?.meta || {}
    const m = meta.detail_1 || meta.news || meta.music || Object.values(meta)[0] || {}
    const title = String(m.desc || m.title || j.prompt || '').trim()
    const url = String(m.qqdocurl || m.jumpUrl || m.url || '').split('?')[0]
    const from = String(m.title && m.desc ? m.title : m.tag || '').trim()
    if (!title && !url) return '[卡片消息]'
    return `[分享卡片${from ? '（' + from + '）' : ''}：${title}${url ? ' ' + url : ''}]`
  } catch (error) {
    return '[卡片消息]'
  }
}

export function mimeOf(buf) {
  if (!buf || buf.length < 12) return 'application/octet-stream'
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif'
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) return 'image/webp'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  return 'application/octet-stream'
}
