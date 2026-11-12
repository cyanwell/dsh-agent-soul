// 内置模块：主人私聊时查看自己的 QQ 资料，以及按权限修改昵称、签名、头像。
// 三个都是 SnowLuma 的扩展动作（不是标准 OneBot v11）：set_qq_profile / set_self_longnick / set_qq_avatar。
// 每个操作单独一档权限（面板「权限」页）：off 关 / owner 仅主人私聊（默认）/ all 所有人。B 站签名在 bili 模块里。

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool, str } from '../../tools/tools.js'
import { isOwner, profileToolVisible, profilePermits } from '../../chat/access.js'
import { createQqProfile } from '../../features/qq-profile.js'
import { resolvePainting } from '../../features/paintings.js'
import { findFfmpeg, findSharp, shrinkImage, shrinkWithSharp } from '../../core/img.js'
import { segmentBytes } from '../../core/net.js'
import { dataDir } from '../../core/store.js'

const NICK_MAX = 36
const SIGN_MAX = 80
const AVATAR_MAX_SIDE = 640
const AVATAR_MAX_BYTES = 2 * 1024 * 1024

export function profileResultBlocks(_args, value) {
  const blocks = [{ type: 'text', text: value?.ok === false ? '✗ ' + value.message : value?.message || '✓' }]
  if (value?.ok !== false && value?.image?.attachment) blocks.push(value.image)
  return blocks
}

/** 头像来源只收 http(s) 网址；「刚才那张图」和「画作 #1」在工具里单独取字节，本地路径一律不收。 */
export function avatarSource(input) {
  const s = String(input || '').trim()
  if (/^https?:\/\//i.test(s)) return { ok: true, file: s }
  return { ok: false, message: '头像只能用网址图片，或者「刚才那张图」/「画作 #1」' }
}

/** 换头像前把图压到 QQ 能收下：1MB 以内原样，大了先缩到 640 以内、JPEG。缩不了返回 null。 */
async function smallerForAvatar (buf, cfg) {
  if (buf.length <= 1024 * 1024) return buf
  const ffmpeg = findFfmpeg(cfg && cfg.bili && cfg.bili.ffmpegPath)
  let small = ffmpeg ? await shrinkImage(buf, AVATAR_MAX_SIDE, ffmpeg) : null
  if (!small) small = await shrinkWithSharp(await findSharp(), buf, AVATAR_MAX_SIDE)
  if (!small || small.length > AVATAR_MAX_BYTES) return null
  return small
}

export default {
  id: 'profile',
  name: '改资料',
  version: '1.2.0',
  description: '主人私聊时查看自己的 QQ 资料与头像图片（qq_get_profile）、发送当前头像（qq_send_avatar）；按权限修改 QQ 资料',
  files: ['features/qq-profile.js'],
  setup(api, { fetchAvatar, ask } = {}) {
    const { hub, onebot } = api.core
    const reader = createQqProfile({ getConfig: api.config, onebot, dsh: api.dsh, log: api.log, fetchAvatar, ask })
    api.onDispose(reader.dispose)
    api.rule((kind) => kind === 'private' ? '主人谈到你自己的 QQ 昵称、个性签名或头像时，可以主动用 qq_get_profile 查看当前资料，不必等主人明确说“查询”。例如“你现在叫什么”“签名是什么”“喜欢这个头像吗”。问头像画面时传 view_avatar=true，依据本次头像附件和描述回答；查不到就如实说明，不凭旧聊天记录猜。主人明确说“把现在头像发出来”“发你的头像给我”时，用 qq_send_avatar 直接发送，不必先识图；只有工具报告 sent=true 才能说发出去了，成功后不要再用链接或 Markdown 重复发图。查询不会发送图片或修改资料；普通无关聊天无需查询。' : '')
    // 统一套路：dryRun 只说不做；执行前再按最新配置查一遍权限
    const guarded = (key, chat, sessionId, run) => async (args) => {
      const cfg = api.config()
      const p = profilePermits(cfg, key, chat, hub.turnSendersAllOwner(sessionId))
      if (!p.ok) return p
      return run(args, cfg)
    }

    /** 真正换头像：图先压到 QQ 能收下，再依次试 base64、临时文件（网关可能不在同一台机器）。 */
    const applyAvatar = async (buf, c, okMessage) => {
      const small = await smallerForAvatar(buf, c)
      if (!small) return { ok: false, message: `这张图太大（${Math.round(buf.length / 1024)} KB），换头像最多 2 MB，本机也没有 ffmpeg / sharp 可以缩小 —— 先裁小一点再试` }
      if (c.dryRun) return { ok: true, message: `试运行：本来要换 QQ 头像（图片 ${Math.round(small.length / 1024)} KB）` }
      const tmpDir = dataDir('tmp')
      const tmp = join(tmpDir, `avatar-${process.pid}-${Date.now()}.jpg`)
      let lastError = null
      try {
        mkdirSync(tmpDir, { recursive: true })
        writeFileSync(tmp, small)
        for (const file of [`base64://${small.toString('base64')}`, tmp]) {
          try {
            await onebot.call('set_qq_avatar', { file }, { timeoutMs: 30000 })
            return { ok: true, message: okMessage }
          } catch (error) {
            lastError = error
          }
        }
      } catch (error) {
        lastError = error
      } finally {
        try { unlinkSync(tmp) } catch (error) {}
      }
      return { ok: false, message: '换头像失败：网关不接受这张图（' + (lastError && lastError.message ? lastError.message : '未知错误') + '）' }
    }

    api.tool(({ chat, sessionId }) => {
      if (chat.kind !== 'private' && chat.kind !== 'group') return []
      const cfg = api.config()
      const tools = []
      const allowed = () => chat.kind === 'private' && isOwner(api.config(), chat.userId) && hub.turnSendersAllOwner(sessionId)
      // 查询权限独立于修改权限，始终只给主人私聊，读取对象固定为机器人自己。
      if (chat.kind === 'private' && isOwner(cfg, chat.userId)) tools.push(defineTool({
        name: 'qq_get_profile',
        description: '查看你自己的当前 QQ 昵称、个性签名和头像地址。主人私聊谈到资料时可主动查询；需要看头像长什么样、评价头像时传 view_avatar=true，返回实际头像图片附件及辅助描述。只读，不发送图片或修改资料；主人要你发头像时用 qq_send_avatar。',
        properties: { view_avatar: { type: 'boolean', description: '是否实际查看头像画面；讨论头像外观时填 true，默认 false' } },
        render: profileResultBlocks,
        execute: async ({ view_avatar }) => {
          if (!allowed()) return { ok: false, message: '只有主人 QQ 私聊时才能查看我的 QQ 资料' }
          const result = await reader.read({ viewAvatar: view_avatar === true, model: view_avatar === true ? hub.modelFor?.(chat) : null })
          if (!allowed()) return { ok: false, message: '主人身份已变化，请在主人 QQ 私聊中重新查询' }
          return result
        },
      }))
      if (chat.kind === 'private' && isOwner(cfg, chat.userId)) tools.push(defineTool({
        name: 'qq_send_avatar',
        description: '主人明确要求“把现在头像发出来”“发你的头像给我”时，发送你自己的当前 QQ 头像图片到本次主人私聊。无需先识图，不接受地址、QQ 号或发送目标。发送成功后不要再重复发图。',
        execute: async () => {
          try {
            if (!allowed()) throw new Error('只有主人 QQ 私聊时才能发送我的 QQ 头像')
            const ready = () => {
              reader.assertCurrent(String(api.config().botQQ || ''))
              if (!api.config().enabled) throw new Error('插件总开关已关闭，未发送头像')
              return api.config().dryRun || api.config().debug
            }
            if (ready()) return { ok: true, sent: false, simulated: true, message: '试运行或调试模式：不会真实发送 QQ 头像' }
            const avatar = await reader.avatar()
            reader.assertCurrent(avatar.qq)
            if (!allowed()) throw new Error('主人身份已变化，未发送头像')
            if (ready()) return { ok: true, sent: false, simulated: true, message: '已切换到试运行或调试模式，未发送头像' }
            const sent = await hub.sendSegments(chat.chatId, [{ type: 'image', data: { file: 'base64://' + avatar.bytes.toString('base64') } }], '[当前 QQ 头像]')
            if (sent?.message_id == null) throw new Error('未收到 QQ 网关的头像发送确认，请检查连接；不要重复发送')
            api.log?.info?.('当前 QQ 头像已发送给主人私聊')
            return { ok: true, sent: true, messageId: sent.message_id, message: '当前 QQ 头像图片已发送给本次主人私聊，不要再用链接或 Markdown 重复发图' }
          } catch (error) {
            api.log?.warn?.('QQ 头像未确认发送：', error.message)
            return { ok: false, sent: false, message: error.message }
          }
        },
      }))
      if (profileToolVisible(cfg, 'qqNickname', chat)) tools.push(defineTool({
        name: 'qq_set_nickname',
        description: `改你自己的 QQ 昵称（最多 ${NICK_MAX} 字）。有人让你改名时用。`,
        properties: { name: str('新昵称') },
        required: ['name'],
        execute: guarded('qqNickname', chat, sessionId, async ({ name }, c) => {
          const nick = String(name || '').trim()
          if (!nick) return { ok: false, message: '昵称不能是空的' }
          if ([...nick].length > NICK_MAX) return { ok: false, message: `昵称最多 ${NICK_MAX} 个字` }
          if (c.dryRun) return { ok: true, message: `试运行：本来要把 QQ 昵称改成：${nick}` }
          await onebot.call('set_qq_profile', { nickname: nick }, { timeoutMs: 15000 })
          return { ok: true, message: `QQ 昵称改好了：${nick}` }
        }),
      }))
      if (profileToolVisible(cfg, 'qqSignature', chat)) tools.push(defineTool({
        name: 'qq_set_signature',
        description: `改你自己的 QQ 个性签名（最多 ${SIGN_MAX} 字）。有人让你改签名时用。`,
        properties: { text: str('新签名') },
        required: ['text'],
        execute: guarded('qqSignature', chat, sessionId, async ({ text }, c) => {
          const sign = String(text || '').trim()
          if (!sign) return { ok: false, message: '签名不能是空的' }
          if ([...sign].length > SIGN_MAX) return { ok: false, message: `签名最多 ${SIGN_MAX} 个字` }
          if (c.dryRun) return { ok: true, message: `试运行：本来要把 QQ 签名改成：${sign}` }
          await onebot.call('set_self_longnick', { longNick: sign }, { timeoutMs: 15000 })
          return { ok: true, message: `QQ 签名改好了：${sign}` }
        }),
      }))
      if (profileToolVisible(cfg, 'qqAvatar', chat)) tools.push(defineTool({
        name: 'qq_set_avatar',
        description: '换你自己的 QQ 头像。image 填图片网址；主人刚发来一张图、说「用我刚才发的 / 刚才那张」换头像时，填 last（不是画作编号）；填「画作 #1」才是用你自己画的那张（画完时会告诉你编号）。图太大会自动缩小。',
        properties: { image: str('图片网址（http/https）／last（刚才那张图）／画作编号（如 #1）') },
        required: ['image'],
        execute: guarded('qqAvatar', chat, sessionId, async ({ image }, c) => {
          const chatId = hub.chatOfSession(sessionId) || chat.chatId
          const raw = String(image || '').trim()
          // ① 刚才那张图（别人发来的）：直接拿图片字节 —— 不再依赖 QQ 图片链接能不能被网关拉到。
          // ⚠ 这里必须排在画作前面：'last' 是「别人发的图」，不能被她自己的画作别名抢走。
          if (!raw || /^(last|刚才|上一张|最近)/i.test(raw)) {
            const list = hub.recentMedia(chatId)
            const pick = list.filter((x) => !x.sticker).at(-1) || list.at(-1)
            if (!pick) return { ok: false, message: '最近半小时这个聊天里没人发过图片，先把图发过来' }
            let buf
            try {
              buf = await segmentBytes(pick.seg, onebot, { maxBytes: 10 * 1024 * 1024 })
            } catch (error) {
              return { ok: false, message: '这张图我拿不到：' + error.message }
            }
            return applyAvatar(buf, c, 'QQ 头像换好了（用刚才那张图）')
          }
          // ② 显式网址：原样交给网关（.png 结尾的网址也是网址，不能被当成画作文件名）
          if (/^https?:\/\//i.test(raw)) {
            const src = avatarSource(raw)
            if (!src.ok) return src
            if (c.dryRun) return { ok: true, message: `试运行：本来要把 QQ 头像换成：${src.file}` }
            await onebot.call('set_qq_avatar', { file: src.file }, { timeoutMs: 30000 })
            return { ok: true, message: 'QQ 头像换好了' }
          }
          // ③ 自己画的图：只认「画作」「画作 #1」「#1」或完整文件名；绝对路径一律不认
          const paintingRef = /^画作/i.test(raw) ? (raw.replace(/^画作\s*[:：#]?\s*/i, '').trim() || '画作') : raw
          const looksLikePath = /^[a-zA-Z]:[\\/]|^\/(?!\/)|^file:|^base64:/i.test(raw)
          const isPainting = !looksLikePath && (/^#?\d{1,2}$/.test(paintingRef) || /^画作$/i.test(paintingRef) || /\.(png|jpe?g|webp|gif)$/i.test(paintingRef))
          if (isPainting) {
            const painting = resolvePainting(chatId, paintingRef)
            if (!painting) return { ok: false, message: `找不到画作 ${raw}（编号可能过期了，先让我画一张？）` }
            let buf
            try {
              buf = readFileSync(painting.path)
            } catch (error) {
              return { ok: false, message: '这张画的文件读不到了：' + error.message }
            }
            return applyAvatar(buf, c, 'QQ 头像换好了（用我自己画的那张）')
          }
          // ④ 其它（本地路径、base64 等）一律不收
          return { ok: false, message: '头像只能用网址图片、「刚才那张图」或「画作 #1」' }
        }),
      }))
      return tools
    })
    return {}
  },
}
