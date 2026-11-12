// 内置模块：表情包。偷表情、回复时按情绪配一张、她自己整理表情库。
// 导出的就是表情库（createStickerStore 的返回值），聊天中枢发表情、偷表情都找它。

import { readFileSync, existsSync } from 'node:fs'
import { createStickerStore, stickerPath } from '../../features/stickers.js'
import { defineTool, str } from '../../tools/tools.js'
import { fetchImage, segmentBytes } from '../../core/net.js'
import { resolvePainting } from '../../features/paintings.js'

export default {
  id: 'stickers',
  name: '表情包',
  version: '1.0.0',
  description: '偷表情、回复时按情绪配表情、她自己改名删图；关掉后不发也不收表情',
  tab: 'stickers',
  files: ['features/stickers.js'],
  setup(api) {
    const { hub, onebot, http } = api.core
    const store = createStickerStore({ dsh: api.dsh, getConfig: api.config, onebot, log: api.log })

    api.tool(({ chat, level, sessionId }) => {
      if (chat.kind === 'system') return []
      const current = chat.chatId
      const tools = [
        // 表情包关着就不挂「发表情」（整理表情库的工具照样留着）
        ...(api.config().stickers.enabled ? [defineTool({
          name: 'qq_send_sticker',
          description: '在当前 QQ 聊天里发一张表情包。name 写表情的名字或情绪（如「委屈」「开心」「早晚安」），会在表情库里模糊匹配。一般直接在回复里写 <sticker:名字> 就行，这个工具用于回复之外单独补发。',
          properties: { name: str('表情名字或情绪关键词') },
          required: ['name'],
          execute: async ({ name }) => {
            const ok = await hub.sendSticker(current, String(name || ''))
            return ok ? { ok: true, message: '发了' } : { ok: false, message: '表情库里没找到合适的' }
          },
        })] : []),
        defineTool({
          name: 'qq_list_stickers',
          description: '看看表情库里有哪些表情（名字和标签），挑表情前可以先看。',
          properties: { query: str('可选，按名字/标签筛选') },
          execute: async ({ query }) => {
            const items = store.library().items
            const q = String(query || '').trim()
            const hit = (q ? items.filter((i) => (i.name || '').includes(q) || (i.tags || []).some((t) => t.includes(q))) : items).slice(-60)
            return { ok: true, count: items.length, message: hit.length ? hit.map((i) => `${i.name || '未命名'}${i.tags?.length ? '（' + i.tags.join('/') + '）' : ''}`).join('、') : '没有符合的表情', items: hit.map((i) => ({ name: i.name, tags: i.tags })) }
          },
        }),
        defineTool({
          name: 'qq_edit_sticker',
          description: '整理表情库：给一张表情改名字、改标签，或者删掉。名字不贴切、别人建议改名、标签不对的时候用；不喜欢、重复、发不出去的表情可以删。sticker 写现在的名字或标签（模糊匹配）。',
          properties: {
            sticker: str('要改的那张表情现在的名字或标签'),
            new_name: str('新名字（12 字以内，不改就不填）'),
            tags: { type: 'array', items: { type: 'string' }, description: '新标签（情绪 / 用途，比如 开心、委屈、嘲讽；不改就不填）' },
            delete: { type: 'boolean', description: 'true = 删掉这张表情' },
          },
          required: ['sticker'],
          execute: async ({ sticker, new_name, tags, delete: del }) => {
            const item = store.match(String(sticker || ''))
            if (!item) return { ok: false, message: '表情库里没找到这张' }
            const label = item.name || item.md5.slice(0, 8)
            if (del) {
              // 主人亲手加的表情，主人开口才删
              if ((item.from === 'manual' || item.from === 'panel') && !hub.turnHasOwner(sessionId)) return { ok: false, message: '这张是主人加的，主人说删才删' }
              const r = await store.remove(item.md5)
              return r.ok ? { ok: true, message: `删掉了「${label}」` } : { ok: false, message: r.reason || '没删成' }
            }
            if (!new_name && !(Array.isArray(tags) && tags.length)) return { ok: false, message: '要说改成什么' }
            const r = store.rename(item.md5, new_name ? String(new_name).trim().slice(0, 12) : undefined, Array.isArray(tags) && tags.length ? tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 5) : undefined)
            return r.ok ? { ok: true, message: `改好了：「${label}」→「${r.item.name}」${r.item.tags?.length ? '（' + r.item.tags.join('/') + '）' : ''}` } : { ok: false, message: '没改成' }
          },
        }),
      ]
      // 主人让她存表情：存这个聊天里刚发来的那张（她看得见图，但拿不到图片地址，所以由插件去找）；
      // 传 painting（画作编号）时存的是她自己刚画的那张
      tools.push(defineTool({
        name: 'qq_save_sticker',
        description: '把这个聊天里刚发来的那张表情包 / 图片收进你的表情库（同时收藏到 QQ）。主人说「存一下这个表情」「导入这个表情」「收藏这张」时用。传 painting（画作编号，如 #1）时，存的是你自己刚画的那张图。name 是不超过 12 个字的备注，可以不填（会自动看图起名）。',
        properties: {
          name: str('备注（≤12 字，可不填）'),
          tags: { type: 'array', items: { type: 'string' }, description: '标签，如 开心/委屈（可不填）' },
          painting: str('画作编号（如 #1）：存你自己刚画的图时填'),
        },
        execute: async ({ name, tags, painting }) => {
          if (!hub.turnHasOwner(sessionId)) return { ok: false, message: '只有主人能让我存表情' }
          let buf
          if (painting) {
            const p = resolvePainting(current, painting)
            if (!p) return { ok: false, message: `找不到画作 ${painting}（编号可能过期了，先让我画一张？）` }
            try {
              buf = readFileSync(p.path)
            } catch (error) {
              return { ok: false, message: '这张画的文件读不到了：' + error.message }
            }
          } else {
            const media = hub.recentMedia(current)
            // 优先主人自己发的，其次这个聊天里最近的
            const pick = media.filter((x) => x.userId === String(api.config().ownerQQ)).at(-1) || media.at(-1)
            if (!pick) return { ok: false, message: '最近半小时这个聊天里没有人发表情或图片，先把那张发过来' }
            buf = await segmentBytes(pick.seg, api.core.onebot, { maxBytes: 5 * 1024 * 1024 })
          }
          const r = await store.addFromBuffer(buf, { name: String(name || '').slice(0, 12), tags: Array.isArray(tags) ? tags.slice(0, 3) : [], from: 'tool' })
          if (!r.ok) return { ok: false, message: r.reason || '没存成' }
          if (r.existed) return { ok: true, message: `库里已经有这张了（叫「${r.item.name || '未命名'}」）` }
          return { ok: true, message: `存好了${r.item.name ? '「' + r.item.name + '」' : ''}` }
        },
      }))
      tools.push(defineTool({
        name: 'qq_import_qq_stickers',
        description: '把你 QQ「我喜欢的」收藏里已有的表情全部导进表情库（已经有的跳过），之后就能用 <sticker:名字> 发它们。主人让你「导入收藏的表情」「同步一下 QQ 表情」时用。',
        execute: async () => {
          if (!hub.turnHasOwner(sessionId)) return { ok: false, message: '只有主人能让我导入收藏的表情' }
          return store.importFromQQ()
        },
      }))
      // 主人私聊（完整权限）才能往库里加图
      if (level === 'full') tools.push(defineTool({
        name: 'qq_add_sticker',
        description: '把一张图片收进表情库并收藏到 QQ。source 是本地图片路径或图片网址；name 是不超过 12 个字的备注。',
        properties: { source: str('本地路径或 http(s) 地址'), name: str('备注（≤12 字）'), tags: { type: 'array', items: { type: 'string' }, description: '标签，如 开心/委屈' } },
        required: ['source'],
        execute: async ({ source, name, tags }) => {
          const buf = await fetchImage(String(source), { maxBytes: 5 * 1024 * 1024 })
          const r = await store.addFromBuffer(buf, { name: name || '', tags: Array.isArray(tags) ? tags.slice(0, 3) : [], from: 'tool' })
          return r.ok ? { ok: true, message: r.existed ? '库里已经有这张了' : `收好了「${r.item.name || '未命名'}」` } : { ok: false, message: r.reason }
        },
      }))
      return tools
    })

    api.route('/stickers', async () => ({ ok: true, items: store.library().items.slice().reverse() }))
    api.route('/sticker/image', async (req, res) => {
      const it = store.library().items.find((i) => i.md5 === http.query(req).md5)
      if (!it || !existsSync(stickerPath(it))) return http.send(res, 404, '')
      const ext = it.file.split('.').pop()
      http.send(res, 200, readFileSync(stickerPath(it)), ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg')
    })
    api.route('/sticker/rename', async (req) => {
      const b = await http.body(req)
      return store.rename(b.md5, b.name, Array.isArray(b.tags) ? b.tags : undefined)
    })
    api.route('/sticker/delete', async (req) => {
      const b = await http.body(req)
      return store.remove(b.md5, { fromQQ: b.fromQQ !== false })
    })
    api.route('/sticker/import-qq', async () => store.importFromQQ())
    api.rule(() => '- 主人让你存某个表情（「存一下」「导入这个表情」）时用 qq_save_sticker；让你把 QQ 收藏里的表情导进来时用 qq_import_qq_stickers。别人让你存，不用理。')
    api.route('/sticker/upload', async (req) => {
      const b = await http.body(req)
      const buf = Buffer.from(String(b.data || '').replace(/^data:[^,]+,/, ''), 'base64')
      if (!buf.length || buf.length > 5 * 1024 * 1024) return { ok: false, message: '图片太大或是空的' }
      return store.addFromBuffer(buf, { name: b.name || '', tags: b.tags || [], from: 'panel' })
    })

    return store
  },
}
