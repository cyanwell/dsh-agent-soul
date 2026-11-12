// 消息中枢：QQ 会话 ↔ DSH 会话。
//   收：OneBot 事件 → 白名单 / 群聊策略 → 拼好文案（带发言人、群上下文、图片、语音转写）→ 喂进对应 DSH 会话
//   发：DSH 会话一轮结束 → 取最终正文 → 拆条 / 语音 / 表情 → 发回原来的 QQ 会话
// 每个 QQ 会话一个 DSH 会话，统一放在「Aurabot · QQ」工作区，主人可以在 DSH 侧栏点开看、插手。

import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync, mkdirSync, readFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { dataDir, readJson, writeJson } from '../core/store.js'
import { parseMessageEvent } from './inbound.js'
import { parseReply, bubbleDelay, wantsVoice } from './reply.js'
import { decideGroupReply, policyFor, topicRelevance } from './group-policy.js'
import { checkAllowed, levelFor, presetFor, isOwner } from './access.js'
import { fetchImage, segmentBytes } from '../core/net.js'
import { toMono16k } from '../voice/wav.js'
import { mimeOf } from './inbound.js'
import { redact } from '../core/redact.js'
import { defaultModel, pickReasoningEffort, canSeeImages, modelVision } from '../core/llm.js'
import { resolveChatModel } from './chat-model.js'
import { createFaces, textToSegments, stripFaceTags, speakableText } from './faces.js'
import { expandMentions, hasMention } from './mentions.js'
import { createRecentMedia } from './recent-media.js'
import { createTitleFilter } from './title-filter.js'

// QQ 会话的工作区目录，第一次收到消息时自动创建。面板「连接」页能改（config.workspaceDir，#32）；
// 没填就用环境变量 AURABOT_WORKSPACE，再没有：老安装沿用 C:\Aurabot\qq-chats，新安装放在用户目录下（不用往 C 盘根目录写）
const LEGACY_WORKSPACE = 'C:\\Aurabot\\qq-chats'
export const WORKSPACE_DIR = process.env.AURABOT_WORKSPACE || (existsSync(LEGACY_WORKSPACE) ? LEGACY_WORKSPACE : join(homedir(), 'Aurabot', 'qq-chats'))
/** 现在用的工作区目录：面板里填了就用填的，否则默认。 */
export const workspaceDirOf = (cfg) => String(cfg?.workspaceDir || '').trim() || WORKSPACE_DIR
export const WORKSPACE_TITLE = 'Aurabot · QQ'
const SOURCE_KIND = 'aurabot'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sessionKey = (id) => {
  const s = String(id ?? '')
  return s.startsWith('session-') ? s.slice(8) : s
}

/**
 * hooks（扩展模块用，都可以不传）：
 *   message(msg) → true 表示这条消息被模块接管了，她不再处理
 *   reply(text, {chatId}) → 改写她要发的话；返回 null 表示这次不发
 *   deniedTools() → 不许出现在她 QQ 会话里的全局工具名（给其他 DSH 会话用的联动工具）
 *   groupDecide(decision, info) → 改群聊「回不回、怎么回」的决定 { reply, mode, reason }
 *   prompt(content, info) → 改交给她的内容（文字 / 图片块）；返回 null 表示这次不交给她
 *   items(items, info) → 改拆好的回复（每条 { kind: text|voice|sticker|poke|image, value, replyTo }）
 *   send(message, info) → 改最终发出去的 OneBot 消息段；返回 null 表示不发
 *   model(selection, chat) → 这个聊天用哪个模型 { provider, model, reasoningEffort }（同步）；selection 已经按主人「按聊天选模型」的设置算过
 *   poke(event) → true 表示戳一戳被模块接管了
 */
// 模拟测试：这里面发出去的消息只记下来，不真发
const captureStore = new AsyncLocalStorage()
export function createHub({ dsh, getConfig, log, onebot, stickers, tts, buildTools, contextProviders, onActivity, memoryScore, onCommand, isMuted, moodEffects, localApi, hooks, availableModels, toolsGeneration }) {
  // 心情对行为的影响（表情 / 语音概率、回复快慢、插话积极程度），没接就是 1
  const mood = () => (typeof moodEffects === 'function' ? moodEffects() : null) || { sticker: 1, voice: 1, delay: 1, chatty: 1 }
  const mapFile = () => dataDir('sessions.json')
  const map = () => readJson(mapFile(), () => ({ chats: {} }))
  const saveMap = (m) => writeJson(mapFile(), m)

  const mounted = new Map() // sessionKey → { agent, offs, chatId, toolsKey }  按会话记，agent 对象换了也能清掉旧工具（#90）
  const toolDisposers = new Map() // `${sessionKey}|${工具名}` → disposer，防注册表里残留同名工具时挂不上（#90）
  const sessionToChat = new Map() // sessionKey → chatId
  const turnState = new Map() // sessionKey → { lastTurn, text, images, senders:Set, system?: {resolve, reject} }
  const groupBuf = new Map() // groupId → [{t, uid, nick, text, at}]
  const groupInterjects = new Map() // groupId → [t]  她主动开口（插话、接话）的时间
  const groupSaid = new Map() // groupId → [t]  她每次在群里说话的时间（刹车用）
  const groupRefs = new Map() // groupId → { 编号: { mid, uid } }  上一段提示词里的编号，引用回复用
  const groupEngaged = new Map() // groupId → 加入话题到什么时候（毫秒）
  const ENGAGE_MS = 3 * 60_000
  const groupNames = new Map()
  const recentMedia = createRecentMedia({ log }) // 最近发来的图片和表情，短期落盘恢复
  const slowNoticeSent = new Set() // sessionKey → 这一轮已经发过「正在做」提示（慢工具，issue #74）
  const faces = createFaces({ onebot, log }) // QQ 系统表情：<face:名字> ↔ 编号
  const titleFilter = createTitleFilter({ getConfig, onebot, log }) // 勾选的群里，头衔是某个词的成员（别的机器人）不理
  const groupMembers = new Map() // groupId → { at, list }  群成员（真 @ 时按名字找人，缓存 10 分钟）
  const saidElsewhere = new Map() // chatId → [{ at, text }]  别处安排她在这里发的话，下次这个聊天交给她时补进去

  async function membersOf(groupId) {
    const hit = groupMembers.get(groupId)
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.list
    try {
      const r = await onebot.call('get_group_member_list', { group_id: Number(groupId) }, { timeoutMs: 15000 })
      const list = Array.isArray(r) ? r : r?.data || []
      groupMembers.set(groupId, { at: Date.now(), list })
      return list
    } catch (error) {
      log.debug('拉群成员失败，@ 按文字发：', error.message)
      return hit?.list || []
    }
  }
  const sentIds = new Set()
  const stats = { received: 0, sent: 0, voice: 0, stickers: 0, errors: 0, day: new Date().toDateString() }
  let selfId = ''
  let lastChatAt = 0
  let lastOwnerChatAt = 0
  let lastBotToOwner = { at: 0, text: '' } // 她在主人私聊里最后说的话

  function bump(k) {
    const d = new Date().toDateString()
    if (stats.day !== d) Object.assign(stats, { received: 0, sent: 0, voice: 0, stickers: 0, errors: 0, day: d })
    stats[k]++
  }

  // ---------- 聊天流水（给空间日记、主动搭话、面板用） ----------
  function logChat(chatId, who, text, uid = '') {
    try {
      const d = new Date()
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const dir = dataDir('chatlog')
      mkdirSync(dir, { recursive: true })
      appendFileSync(join(dir, `${day}.jsonl`), JSON.stringify({ t: Date.now(), chatId, who, ...(uid ? { uid: String(uid) } : {}), text: redact(String(text).slice(0, 500)) }) + '\n', 'utf8')
    } catch (error) {}
  }

  /** 有聊天流水的日期（升序）。 */
  function chatLogDays() {
    try {
      return readdirSync(dataDir('chatlog')).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).map((n) => n.slice(0, 10)).sort()
    } catch (error) {
      return []
    }
  }

  function deleteChatLog(day) {
    try { unlinkSync(join(dataDir('chatlog'), `${day}.jsonl`)) } catch (error) {}
  }

  function chatLogOf(day) {
    try {
      const f = join(dataDir('chatlog'), `${day}.jsonl`)
      if (!existsSync(f)) return []
      return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    } catch (error) {
      return []
    }
  }

  // ---------- 工作区与会话 ----------
  async function ensureWorkspace() {
    const reg = dsh.workspaceRegistry || dsh.get('workspaceRegistry')
    if (!reg) throw new Error('宿主没有 workspaceRegistry')
    const dir = workspaceDirOf(getConfig())
    mkdirSync(dir, { recursive: true })
    const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase()
    let ws = reg.list().find((w) => norm(w.path) === norm(dir))
    if (!ws) {
      ws = await reg.create(dir, WORKSPACE_TITLE)
      log.info('建好了工作区「' + WORKSPACE_TITLE + '」：' + dir)
    }
    return ws
  }

  function controller() {
    const c = dsh.get('sessionController')
    if (!c) throw new Error('宿主没有 sessionController（需要 DSH 桌面版 / Web 组合）')
    return c
  }

  function titleFor(chat) {
    const owner = getConfig().ownerName || '主人'
    if (chat.kind === 'system') return `QQ · ${chat.title || '后台'}`
    if (chat.kind === 'group') return `QQ 群 · ${groupNames.get(chat.groupId) || chat.groupId}`
    return chat.userId === getConfig().ownerQQ ? `QQ · ${owner}私聊` : `QQ 私聊 · ${chat.nickname || chat.userId}`
  }

  async function createSession(chat, level) {
    const ws = await ensureWorkspace()
    const preset = presetFor(level, getConfig())
    const r = await controller().create({ workspaceId: ws.id, agentPreset: preset })
    const sid = String(r.sessionId)
    try {
      await controller().rename({ sessionId: sid, title: titleFor(chat) })
    } catch (error) {
      log.debug('改会话标题失败：', error.message)
    }
    const m = map()
    m.chats[chat.chatId] = { sessionId: sid, preset, level, createdAt: Date.now(), title: titleFor(chat) }
    saveMap(m)
    log.info(`为 ${chat.chatId} 新建了 DSH 会话 ${sid.slice(-8)}（${preset}）`)
    return sid
  }

  async function resolveAgent(sid) {
    const live = dsh.agents.get(sid) || dsh.agents.get('session-' + sid)
    if (live) return live
    const r = await controller().resolveAgent(sid)
    if (r && r.agent) return r.agent
    const e = r && r.error
    throw Object.assign(new Error(e?.message || '恢复会话失败'), { code: e?.code })
  }

  /** 拿到这个 QQ 会话对应的活 agent（没有就建，权限档位变了就换新会话）。 */
  async function agentFor(chat) {
    const cfg = getConfig()
    const level = chat.kind === 'system' ? (chat.noTools ? 'chat' : 'social') : levelFor(cfg, chat)
    const preset = presetFor(level, cfg)
    const entry = map().chats[chat.chatId]
    let sid = entry && entry.preset === preset && entry.level === level ? entry.sessionId : ''
    let agent = null
    if (sid) {
      try {
        agent = await resolveAgent(sid)
      } catch (error) {
        log.warn(`会话 ${sid.slice(-8)} 恢复不了（${error.message}），换一个新的`)
        sid = ''
      }
      const reg = dsh.workspaceRegistry || dsh.get('workspaceRegistry')
      if (sid && reg && (reg.archivedSessionIds || []).includes(sid)) {
        log.info(`会话 ${sid.slice(-8)} 被归档了，换一个新的`)
        sid = ''
        agent = null
      }
    }
    if (!sid) {
      sid = await createSession(chat, level)
      agent = await resolveAgent(sid)
    }
    // 模型 / 思考强度和设置不一致就切过去（面板改了模型，下一条消息起生效）
    const target = await resolveTarget(chat)
    const want = keyOf(target)
    const m = map()
    if (want && m.chats[chat.chatId] && m.chats[chat.chatId].model !== want) {
      if (applyModel(agent, target)) {
        m.chats[chat.chatId].model = want
        saveMap(m)
        log.info(`${chat.chatId} 的模型切到 ${want}`)
      }
    }
    sessionToChat.set(sessionKey(sid), chat.chatId)
    mount(agent, chat, level)
    return { agent, sessionId: sid, level }
  }

  /** 这个聊天要用的模型：主人按聊天指定的 > 面板里选的全局模型（或 DSH 默认），扩展模块还可以再按聊天改。 */
  function targetModel(chat) {
    const cfg = getConfig()
    const t = defaultModel(dsh, cfg)
    let sel = t ? { provider: t.provider, model: t.model, reasoningEffort: cfg.model.reasoningEffort || '' } : null
    // 主人按聊天指定的模型（私聊 QQ 号 > 群号 > 所有私聊 / 所有群默认）；没指定或指定的模型已不存在就用上面的
    try {
      const r = resolveChatModel(cfg, chat, typeof availableModels === 'function' ? availableModels() : null)
      if (r) sel = { provider: r.provider, model: r.model, reasoningEffort: r.reasoningEffort || cfg.model.reasoningEffort || '' }
    } catch (error) {}
    if (hooks?.model && chat) {
      try {
        const r = hooks.model(sel, chat)
        if (r && r.provider && r.model) sel = { reasoningEffort: '', ...r }
      } catch (error) {}
    }
    return sel
  }
  /**
   * 想要的思考强度要先按模型能力收敛：没有推理元数据的模型（本地 Ollama、部分手写 provider）
   * 只要收到 reasoningEffort 就会被 DSH 整轮拒掉（UNSUPPORTED_REASONING_EFFORT），
   * 等于这个模型直接没法用。不支持就不传这个参数，让 DSH 用模型自己的默认。
   */
  async function resolveTarget(chat) {
    const t = targetModel(chat)
    if (!t) return null
    const effort = await pickReasoningEffort(dsh, t.provider, t.model, t.reasoningEffort)
    return { provider: t.provider, model: t.model, ...(effort ? { reasoningEffort: effort } : {}) }
  }
  const keyOf = (t) => (t ? `${t.provider}::${t.model}::${t.reasoningEffort || ''}` : '')

  /** 让聊天会话用面板里选的模型和思考强度；只改这个会话，不改 DSH 的默认模型。 */
  function applyModel(agent, target) {
    try {
      if (!target) return false
      const sel = { provider: target.provider, model: target.model }
      if (target.reasoningEffort) sel.reasoningEffort = target.reasoningEffort
      // 活着的会话只认会话控制器内存里的选择：用它的 selectForNextRequest（selectModel 也是调它，
      // 但 selectModel 还会顺手改掉 DSH 的全局默认模型，我们不要）。拿不到就只写持久事件（重启恢复时生效）。
      const agents = controller().agents
      if (agents && typeof agents.selectForNextRequest === 'function') agents.selectForNextRequest(agent, sel)
      else agent.session.append('model/selection', sel)
      return true
    } catch (error) {
      log.debug('设置会话模型失败（用默认）：', error.message)
      return false
    }
  }

  function mount(agent, chat, level) {
    const sid = sessionKey(agent.session?.id ?? agent.id)
    const tools = level !== 'chat' && typeof buildTools === 'function' ? buildTools({ chat, level, sessionId: sid }) : []
    const denied = (() => { try { return hooks?.deniedTools?.() || [] } catch (error) { return [] } })()
    // 模块（重）启动代际也进 key：热重载后工具名通常不变，但工具对象是旧实例的闭包（issue #73），
    // 只比名字会一直 return，会话里永远用旧实现/旧状态；带上代际就整套重挂。
    let gen = 0
    try { gen = typeof toolsGeneration === 'function' ? Number(toolsGeneration()) || 0 : 0 } catch (error) { gen = 0 }
    const toolsKey = tools.map((t) => t.name).sort().join(',') + '|' + denied.join(',') + '|gen:' + gen
    const prev = mounted.get(sid)
    // 工具清单变了（比如面板里开了生图）就整套重挂；同一个 agent 且没变就别动（改工具会让前缀缓存失效）
    if (prev && prev.agent === agent && prev.chatId === chat.chatId && prev.toolsKey === toolsKey) return
    if (prev) for (const off of prev.offs) { try { if (typeof off === 'function') off() } catch (error) {} }
    const offs = []
    // 联动工具是给 DSH 其他会话用的，她自己的 QQ 会话里不该有（陌生人的会话更不行）
    if (denied.length) {
      try { offs.push(agent.ctx.tools.restrict({ deny: denied })) } catch (error) { log.debug('屏蔽联动工具：', error.message) }
    }
    {
      for (const tool of tools) {
        try {
          // 慢工具（生图 / 翻唱……）卡超过 1.5 秒就先发一条提示：不让主人以为她没收到（issue #74）。
          // 包装只加在挂给 agent 的这份工具上；面板里直接调工具（host 路由）照旧。
          let reg = tool
          if (tool.slow) {
            const { slow, ...base } = tool
            const notice = typeof slow === 'string' ? slow : '好，我这就去做，做完跟你说一声。'
            reg = {
              ...base,
              async execute(args, exec) {
                let fired = false
                const timer = setTimeout(() => {
                  if (fired) return
                  fired = true
                  if (slowNoticeSent.has(sid)) return
                  slowNoticeSent.add(sid)
                  sendText(chat.chatId, notice, undefined, [], undefined).catch((error) => log.debug('慢工具提示没发出去：', error.message))
                }, 1500)
                timer.unref?.()
                try {
                  return await tool.execute(args, exec)
                } finally {
                  clearTimeout(timer)
                }
              },
            }
          }
          // 注册表里如果残留同名工具（旧 agent 作用域/旧版泄漏），先把我们记着的旧 disposer 清掉再注册
          const dkey = sid + '|' + tool.name
          const stale = toolDisposers.get(dkey)
          if (stale) { try { stale() } catch (error) {} toolDisposers.delete(dkey) }
          const off = agent.ctx.tools.register(reg)
          toolDisposers.set(dkey, off)
          offs.push(() => { toolDisposers.delete(dkey); try { off() } catch (error) {} })
        } catch (error) {
          log.warn(`工具 ${tool.name} 挂不上：`, error.message)
        }
      }
    }
    try {
      offs.push(agent.ctx.systemPrompt.context({
        name: 'aurabot-context',
        order: 905,
        text: () => {
          const parts = []
          for (const p of contextProviders || []) {
            try {
              const t = p({ chat, sessionId: sid })
              if (t) parts.push(t)
            } catch (error) {}
          }
          return parts.join('\n\n')
        },
      }))
    } catch (error) {
      log.debug('挂上下文失败：', error.message)
    }
    mounted.set(sid, { agent, chatId: chat.chatId, offs, toolsKey })
  }

  // ---------- 发到 QQ ----------
  function targetOf(chatId) {
    const [kind, id] = String(chatId).split(':')
    return kind === 'group' ? { kind: 'group', id } : kind === 'private' ? { kind: 'private', id } : null
  }

  async function sendSegments(chatId, message, note, { force = false } = {}) {
    const cfg = getConfig()
    const tgt = targetOf(chatId)
    if (!tgt) return null
    // 扩展模块最后改一次（加签名、过滤敏感词、转发到别处……）；返回 null 就不发
    if (hooks?.send) {
      try {
        const next = await hooks.send(message, { chatId, note, force })
        if (next === null) { log.info(`扩展模块拦下了 → ${chatId}：${note}`); return null }
        if (Array.isArray(next)) message = next
      } catch (error) {
        log.warn('扩展模块改写发送内容出错：', error.message)
      }
    }
    const cap = captureStore.getStore()
    if (cap) {
      cap.push({ chatId, note, message })
      return { message_id: 'sim-' + cap.length }
    }
    if (force) {}
    else if (!cfg.enabled) {
      log.info(`总开关关着，没发 → ${chatId}：${note}`)
      return null
    }
    else if (cfg.dryRun) {
      log.info(`试运行（没真发）→ ${chatId}：${note}`)
      return null
    }
    const action = tgt.kind === 'group' ? 'send_group_msg' : 'send_private_msg'
    const params = tgt.kind === 'group' ? { group_id: Number(tgt.id), message } : { user_id: Number(tgt.id), message }
    try {
      const r = await onebot.call(action, params)
      if (r && r.message_id !== undefined) {
        sentIds.add(String(r.message_id))
        if (sentIds.size > 500) sentIds.delete(sentIds.values().next().value)
      }
      bump('sent')
      return r
    } catch (error) {
      bump('errors')
      log.warn(`发到 ${chatId} 失败：`, error.message)
      return null
    }
  }

  /** replyId：要引用回复的那条 QQ 消息（可选）。 */
  const quote = (replyId) => (replyId ? [{ type: 'reply', data: { id: String(replyId) } }] : [])

  const mention = (userId, segs = []) => (userId && !segs.some((s) => s.type === 'at' && String(s.data?.qq) === String(userId)) ? [{ type: 'at', data: { qq: String(userId) } }, { type: 'text', data: { text: ' ' } }] : [])

  async function sendText(chatId, text, replyId, missed, userId) {
    // 文字里的 <face:名字> 换成 QQ 系统表情，和文字在同一条消息里；系统表情关着就去掉标签
    let segs = getConfig().stickers.faces ? textToSegments(text, faces.idOf) : [{ type: 'text', data: { text: stripFaceTags(text) } }]
    // 群里的 @名字 / <at:QQ号> 换成真 @（对方会收到提醒）
    if (chatId.startsWith('group:') && hasMention(text)) segs = expandMentions(segs, await membersOf(chatId.slice(6)), missed)
    if (!segs.length || (segs.length === 1 && segs[0].type === 'text' && !segs[0].data.text.trim())) return null
    return sendSegments(chatId, [...quote(replyId), ...mention(userId, segs), ...segs], (replyId ? '[引用] ' : '') + text.slice(0, 60))
  }

  async function sendVoice(chatId, text, replyId, userId) {
    try {
      // 表情标签 / emoji 不念出来：TTS 只念能说的字（用户反馈：发语音时「呲牙」被读出来）
      const spoken = speakableText(text)
      if (!spoken) throw new Error('这条语音里只有表情/符号，没有能念的字')
      const { file, engine } = await tts.speak(spoken)
      const b64 = readFileSync(file).toString('base64')
      // QQ 客户端不支持「引用 / @ + 语音」同一条消息：这样发电脑 QQ 是空白气泡、手机 QQ 提示
      // 「该消息类型暂不支持查看」，语音也听不到（issue #103）。语音条一律单独成条，引用和 @ 只能放弃。
      if (replyId || userId) log.debug(`语音条不能带引用/@（QQ 限制），单独发：${chatId}`)
      const r = await sendSegments(chatId, [{ type: 'record', data: { file: 'base64://' + b64 } }], `[语音·${engine}] ${text.slice(0, 40)}`)
      if (r || getConfig().dryRun || !getConfig().enabled) bump('voice')
      if (!r && getConfig().enabled && !getConfig().dryRun) throw new Error('网关没接受语音')
      return true
    } catch (error) {
      log.warn('语音没发出去，改发文字：', error.message)
      await sendText(chatId, text, replyId, undefined, userId)
      return false
    }
  }

  /** 戳回去：私聊戳对方，群里戳最近戳她的人（没人戳过就戳这一段最后说话的人）。 */
  async function pokeBack(chatId) {
    const cfg = getConfig()
    const group = chatId.startsWith('group:') ? chatId.slice(6) : ''
    const target = group ? lastPoker.get(chatId) || lastSpeaker.get(chatId) : chatId.slice(8)
    if (!target) return
    if (!cfg.enabled || cfg.dryRun) return log.info(`试运行（没真戳）→ ${chatId}：戳了戳 ${target}`)
    try {
      await onebot.call('send_poke', { user_id: Number(target), ...(group ? { group_id: Number(group) } : {}) }, { timeoutMs: 10000 })
      log.info(`${chatId}：她戳了戳 ${target}`)
    } catch (error) {
      log.debug('戳一戳失败：', error.message)
    }
  }

  /** 把一个音频文件当语音条发出去（翻唱用）。 */
  async function sendVoiceFile(chatId, file, note) {
    const b64 = readFileSync(file).toString('base64')
    const r = await sendSegments(chatId, [{ type: 'record', data: { file: 'base64://' + b64 } }], note || '[语音]')
    if (r || getConfig().dryRun || !getConfig().enabled) bump('voice')
    if (!r && getConfig().enabled && !getConfig().dryRun) throw new Error('网关没接受这条语音')
    return r
  }

  // 发文件：网关可能和插件不在同一台机器上（Docker / 远程 OneBot），它看不到本机路径，
  // 所以按本机路径发失败时，小文件会用 base64 再试一次；超时留长一点，别把大文件上传误判成失败。
  // 安全默认（#52）：功能默认关；只允许发 QQ 工作区（她平时写文件的地方）和面板里额外加的目录里的文件；
  // 单个文件有大小上限；只在主人私聊里能触发；发了什么会写进日志。
  const FILE_TIMEOUT_MS = 120_000
  const FILE_BASE64_MAX = 30 * 1024 * 1024
  const isExternalFile = (s) => /^(https?:\/\/|base64:\/\/)/i.test(s)
  const fileLabel = (name, src) => String(name || '').trim() || basename(src.split(/[?#]/)[0]) || '文件'
  const fileRootsOf = (cfg) => [workspaceDirOf(cfg), ...(Array.isArray(cfg?.files?.dirs) ? cfg.files.dirs : [])]
    .filter(Boolean)
    .map((d) => { try { return resolve(String(d)) } catch (error) { return '' } })
    .filter(Boolean)
  const insideRoots = (file, roots) => {
    let p
    try { p = resolve(file) } catch (error) { return false }
    return roots.some((root) => {
      const rel = relative(root, p)
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
    })
  }

  /** 把一个文件当文件发到 QQ（OneBot upload_private_file / upload_group_file）。file 可以是本机绝对路径、网址或 base64://。 */
  async function sendFile(chatId, file, name) {
    const cfg = getConfig()
    const tgt = targetOf(chatId)
    if (!tgt) return null
    if (!cfg.files?.enabled) throw new Error('发文件没打开（面板「聊天」页 → 发文件），打开后才能发')
    const src = String(file ?? '').trim()
    if (!src) throw new Error('要发哪个文件？')
    const external = isExternalFile(src)
    const maxBytes = Math.max(1, Number(cfg.files.maxMB) || 50) * 1024 * 1024
    let size = 0
    if (!external) {
      if (!isAbsolute(src)) throw new Error('要发本机文件得给绝对路径')
      if (!existsSync(src)) throw new Error(`找不到这个文件：${src}`)
      const st = statSync(src)
      if (!st.isFile()) throw new Error(`这不是文件：${src}`)
      size = st.size
      const roots = fileRootsOf(cfg)
      if (roots.length && !insideRoots(src, roots)) throw new Error('这个文件不在允许发送的目录里（面板「聊天」页 → 发文件 可以加目录）')
      if (size > maxBytes) throw new Error(`文件太大（${(size / 1024 / 1024).toFixed(1)} MB），上限 ${Math.round(maxBytes / 1024 / 1024)} MB`)
    }
    const label = fileLabel(name, src)
    // 模拟测试：只记下来，不真发
    const cap = captureStore.getStore()
    if (cap) {
      cap.push({ chatId, note: `[文件] ${label}`, message: [{ type: 'file', data: { file: src, name: label } }] })
      return { message_id: 'sim-' + cap.length }
    }
    if (!cfg.enabled) { log.info(`总开关关着，没发 → ${chatId}：[文件] ${label}`); return null }
    if (cfg.dryRun) { log.info(`试运行（没真发）→ ${chatId}：[文件] ${label}`); return null }
    const action = tgt.kind === 'group' ? 'upload_group_file' : 'upload_private_file'
    const params = tgt.kind === 'group'
      ? { group_id: Number(tgt.id), file: src, name: label }
      : { user_id: Number(tgt.id), file: src, name: label }
    const srcLabel = external ? (src.startsWith('base64://') ? 'base64' : '外部地址') : size < 1024 ? size + ' B' : Math.round(size / 1024) + ' KB'
    try {
      const r = await onebot.call(action, params, { timeoutMs: FILE_TIMEOUT_MS })
      bump('sent')
      log.info(`${chatId}：发文件「${label}」（${srcLabel}）`)
      return r
    } catch (error) {
      // 网关看不到本机路径（远程 / 容器）时，小文件改用 base64 再试
      const canRetryBase64 = !external && size <= Math.min(FILE_BASE64_MAX, maxBytes)
      if (!canRetryBase64) {
        bump('errors')
        throw new Error(`发文件失败：${error.message}`)
      }
      try {
        const b64 = 'base64://' + readFileSync(src).toString('base64')
        const r = await onebot.call(action, { ...params, file: b64 }, { timeoutMs: FILE_TIMEOUT_MS })
        bump('sent')
        log.info(`${chatId}：发文件「${label}」（网关看不到本机路径，改走 base64）`)
        return r
      } catch (error2) {
        bump('errors')
        throw new Error(`发文件失败：${error2.message || error.message}`)
      }
    }
  }

  async function sendSticker(chatId, query, replyId, userId) {
    // 面板里把表情包关了：回复里的 <sticker:…>、工具、扩展模块要发的一律不发（#31）
    if (!getConfig().stickers.enabled) {
      log.debug(`表情包关着，「${typeof query === 'object' ? query?.name || '' : query}」不发`)
      return false
    }
    const item = query && typeof query === 'object' ? query : stickers.match(query)
    if (!item) {
      log.debug(`没找到「${query}」这张表情，跳过`)
      return false
    }
    const seg = stickers.segmentFor(item)
    if (!seg) return false
    await sendSegments(chatId, [...quote(replyId), ...mention(userId), seg], `[表情] ${item.name || item.md5.slice(0, 8)}`)
    stickers.markUsed?.(item.md5)
    bump('stickers')
    return true
  }

  async function sendImage(chatId, src, replyId, userId) {
    try {
      const buf = await fetchImage(src, { maxBytes: 10 * 1024 * 1024 })
      return sendSegments(chatId, [...quote(replyId), ...mention(userId), { type: 'image', data: { file: 'base64://' + buf.toString('base64') } }], `[图片] ${src.slice(-40)}`)
    } catch (error) {
      log.warn('图片发不出去：', error.message)
      return null
    }
  }

  /** 一轮回复落地：拆条、语音、表情。 */
  async function deliver(chatId, text, opts = {}) {
    const cfg = getConfig()
    if (hooks?.reply) {
      try {
        const next = await hooks.reply(text, { chatId, userText: opts.userText || '' })
        if (next === null) return log.info(`${chatId}：扩展模块拦下了这次回复`)
        if (typeof next === 'string') text = next
      } catch (error) {
        log.warn('扩展模块改写回复出错：', error.message)
      }
    }
    const r = parseReply(text)
    if (r.silent) {
      log.info(`${chatId}：她选择不说话`)
      if (chatId.startsWith('group:')) groupEngaged.delete(chatId.slice(6)) // 不想聊就退出这个话题
      return
    }
    let items = r.items
    // 对方明确要语音、她却只打了字：整段改成语音发（模型偶尔会忘，这里兜底）
    if (opts.wantVoice && cfg.voice.enabled && !items.some((i) => i.kind === 'voice')) {
      const spoken = items.filter((i) => i.kind === 'text').map((i) => i.value).join('，')
      if (spoken && spoken.length <= 300) items = [{ kind: 'voice', value: spoken }, ...items.filter((i) => i.kind !== 'text')]
    }
    // 短回复按概率整条变语音
    const texts = items.filter((i) => i.kind === 'text')
    if (cfg.voice.enabled && items.length === texts.length && texts.length > 0) {
      const all = texts.map((t) => t.value).join('，')
      if (all.length <= cfg.voice.autoMaxChars && Math.random() < cfg.voice.autoChance * mood().voice) items = [{ kind: 'voice', value: all }]
    }
    const inGroup = chatId.startsWith('group:')
    // 群里别刷屏：一段最多 3 条
    if (inGroup && items.length > 3) items = items.slice(0, 3)
    // 按概率补一张表情（群里已经有两条以上就不补了）
    if (cfg.stickers.enabled && !items.some((i) => i.kind === 'sticker') && !(inGroup && items.length >= 2) && Math.random() < cfg.stickers.autoChance * mood().sticker) {
      const pick = stickers.pickForReply(texts.map((t) => t.value).join(' '))
      if (pick) items.push({ kind: 'sticker', value: pick })
    }
    if (hooks?.items) {
      try {
        const next = await hooks.items(items, { chatId, text, userText: opts.userText || '' })
        if (next === null) return log.info(`${chatId}：扩展模块拦下了这次回复`)
        if (Array.isArray(next)) items = next
      } catch (error) {
        log.warn('扩展模块改写回复出错：', error.message)
      }
    }
    // 一段只有一个人明确 @ / 引用她时，第一条回复引用并 @ 那个人；多人同时叫她不猜。
    // 模型明确选了引用编号时尊重它，不再自动引用另一条。
    const refs = inGroup ? groupRefs.get(chatId.slice(6)) || {} : {}
    const explicit = items.some((item) => item.replyTo)
    const firstSendable = items.findIndex((item) => item.kind === 'text' || item.kind === 'voice' || item.kind === 'image' || (item.kind === 'sticker' && cfg.stickers.enabled && Boolean(item.value && typeof item.value === 'object' ? item.value : stickers.match(item.value))))
    const missedAt = [] // 写了 @ 却没对上群里人的名字
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      const selected = it.replyTo ? refs[it.replyTo] : (!explicit && i === firstSendable ? opts.autoReply : null)
      const replyId = selected?.mid
      const userId = selected && opts.autoReply?.uid === selected.uid ? selected.uid : undefined
      if (it.replyTo && !replyId) log.debug(`${chatId}：引用的编号 ${it.replyTo} 对不上，正常发`)
      if (it.kind === 'text') await sendText(chatId, it.value, replyId, missedAt, userId)
      else if (it.kind === 'voice') {
        if (cfg.voice.enabled) await sendVoice(chatId, it.value, replyId, userId)
        else await sendText(chatId, it.value, replyId, missedAt, userId)
      } else if (it.kind === 'sticker') await sendSticker(chatId, it.value, replyId, userId)
      else if (it.kind === 'poke') { if (!opts.simulate) await pokeBack(chatId) }
      else if (it.kind === 'image') await sendImage(chatId, it.value, replyId, userId)
      if (i < items.length - 1 && !opts.simulate) await sleep(bubbleDelay(items[i + 1].kind === 'text' ? items[i + 1].value : '') * mood().delay)
    }
    if (opts.simulate) return items
    if (inGroup) {
      const gid = chatId.slice(6)
      const said = (groupSaid.get(gid) || []).filter((t) => Date.now() - t < 3600_000)
      said.push(Date.now())
      groupSaid.set(gid, said)
      groupEngaged.set(gid, Date.now() + ENGAGE_MS) // 在群里说了话 = 加入了话题
    }
    const said = items.map((i) => (i.kind === 'text' || i.kind === 'voice' ? i.value : `[${i.kind}]`)).join(' ')
    logChat(chatId, 'bot', said)
    // 不是这个聊天自己那一轮发的（主人在私聊里让她去群里说、扩展模块代发）：记下来，下次这个聊天交给她时告诉她自己说过什么
    if (!opts.own) saidElsewhere.set(chatId, [...(saidElsewhere.get(chatId) || []), { at: Date.now(), text: said.slice(0, 300) }].slice(-5))
    lastChatAt = Date.now()
    if (chatId === `private:${cfg.ownerQQ}`) lastBotToOwner = { at: Date.now(), text: items.filter((i) => i.kind === 'text' || i.kind === 'voice').map((i) => i.value).join('\n') }
    onActivity?.({ kind: 'out', chatId, reply: text, userText: opts.userText || '' })
    return { missedAt }
  }

  // ---------- 盯 DSH 会话：一轮结束就发 ----------
  function textOf(message) {
    if (!message || !Array.isArray(message.content)) return ''
    return message.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim()
  }

  function onSessionEvent(session, event) {
    const key = sessionKey(session && session.id)
    const chatId = sessionToChat.get(key)
    if (!chatId || !event) return
    const st = turnState.get(key) || { lastTurn: -1, text: '', senders: new Set() }
    turnState.set(key, st)
    if (event.type === 'user/message') {
      // 主人在 DSH 会话窗口里直接打字（不是从 QQ 转进来的，#58）：只有主人能操作 DSH，
      // 这一轮按「主人说的」算；不然重开会话后在面板里让她改资料会报没权限。
      const src = event.data && event.data.source
      if (src && src.kind === 'user') st.directOwner = true
      return
    }
    if (event.type === 'assistant/message') {
      const d = event.data || {}
      if (d.interrupted) return
      const t = textOf(d.message)
      if (t) {
        st.lastTurn = d.turn
        st.text = t
      }
      return
    }
    if (event.type === 'turn/end') {
      slowNoticeSent.delete(key)
      running.delete(chatId)
      stopTyping(key)
      const d = event.data || {}
      const completed = d.reason && d.reason.kind === 'completed'
      const text = st.lastTurn === d.turn ? st.text : ''
      const sys = st.system
      const wantVoice = Boolean(st.wantVoice)
      const autoReply = st.autoReply
      st.autoReply = null
      st.text = ''
      // 上一轮还在跑时新消息已经排队给「下一轮」：这一轮 turn/end 不能把下一轮的说话人清掉（#90）
      st.senders = st.pendingSenders || new Set()
      st.pendingSenders = new Set()
      st.directOwner = false
      st.system = null
      st.wantVoice = false
      if (sys) {
        if (completed) sys.resolve(text)
        else sys.reject(new Error('这一轮没正常结束：' + (d.reason?.kind || '?')))
        return
      }
      if (!completed) {
        const detail = String(d.reason?.error?.message || d.reason?.failure?.message || '').replace(/\s+/g, ' ').slice(0, 180)
        log.warn(`${chatId} 这一轮没正常结束（${d.reason?.kind || '?'}${detail ? '：' + redact(detail) : ''}），不发`)
        release(chatId)
        return
      }
      if (chatId.startsWith('system:')) return // 已超时的后台轮次不能误发到 QQ
      if (!text) return release(chatId)
      // 发完再放开：发送期间来的消息也攒到下一段
      deliver(chatId, text, { wantVoice, autoReply, userText: st.lastText || '', own: true }).catch((error) => log.warn('发送出错：', error.message)).finally(() => release(chatId))
    }
  }

  // ---------- 收 QQ ----------
  async function groupName(gid) {
    if (groupNames.has(gid)) return groupNames.get(gid)
    try {
      // 查群名是锦上添花：失败就退回群号，别在网关抖动时白等重试
      const info = await onebot.call('get_group_info', { group_id: Number(gid) }, { retries: 0 })
      if (info?.group_name) groupNames.set(gid, info.group_name)
    } catch (error) {}
    return groupNames.get(gid) || gid
  }

  async function repliedToBot(replyId) {
    if (!replyId) return false
    if (sentIds.has(replyId)) return true
    try {
      const m = await onebot.call('get_msg', { message_id: Number(replyId) || replyId }, { timeoutMs: 5000 })
      return String(m?.sender?.user_id ?? m?.user_id ?? '') === String(selfId || getConfig().botQQ)
    } catch (error) {
      return false
    }
  }

  async function transcribe(msg) {
    for (const rec of msg.records) {
      // 本地接口接管：用用户自己的识别服务（最先试）
      if (localApi?.active('asr')) {
        try {
          const info = await onebot.call('get_record', { file: rec.data?.file, out_format: 'wav' }, { timeoutMs: 30000 })
          const raw = info?.base64 ? Buffer.from(info.base64, 'base64') : await fetchImage(info?.file || info?.url, { maxBytes: 30 * 1024 * 1024 })
          const { writeFileSync, mkdirSync } = await import('node:fs')
          const { join } = await import('node:path')
          const dir = localApi.dir() + '/out'
          mkdirSync(dir, { recursive: true })
          const file = join(dir, `asr-${Date.now()}.wav`)
          writeFileSync(file, toMono16k(raw))
          const r = await localApi.call('asr', { file })
          const text = String(typeof r === 'string' ? r : r?.text || '').trim()
          if (text) return `[语音] ${text}`
        } catch (error) {
          log.debug('本地接口语音识别失败：', error.message)
        }
      }
      try {
        const r = await onebot.call('fetch_ptt_text', { message_id: Number(msg.messageId) || msg.messageId }, { timeoutMs: 20000 })
        if (r?.text) return `[语音] ${r.text}`
      } catch (error) {
        log.debug('QQ 语音转文字失败：', error.message)
      }
      try {
        const text = await localTranscribe(rec)
        if (text) return `[语音] ${text}`
      } catch (error) {
        log.debug('本地语音识别失败：', error.message)
      }
      return '[发来一条语音，没听清]'
    }
    return ''
  }

  /**
   * DSH 自带识别（SenseVoice）：resolve({audio}) → transcribe(spec, signal)，音频必须是 16kHz 单声道 PCM16 WAV。
   * QQ 语音是 silk：先让网关 get_record 转成 wav，再重采样。
   */
  async function localTranscribe(rec) {
    const stt = dsh.get('speechToText')
    if (!stt || typeof stt.resolve !== 'function' || typeof stt.transcribe !== 'function') throw new Error('DSH 没开启语音输入')
    // 模型还没下载好：顺手开始准备（下载一次，之后常驻），这一条先算没听清
    const snap = typeof stt.snapshot === 'function' ? stt.snapshot() : null
    const pid = snap?.selection?.providerId
    const prov = snap?.providers?.find((p) => p.id === pid)
    if (prov && prov.preparation && !['ready', 'standby'].includes(prov.preparation.phase)) {
      try { stt.prepare(pid) } catch (error) {}
      throw new Error(`识别模型还在准备（${prov.preparation.phase}）`)
    }
    const info = await onebot.call('get_record', { file: rec.data?.file, out_format: 'wav' }, { timeoutMs: 30000 })
    const raw = info?.base64 ? Buffer.from(info.base64, 'base64') : await fetchImage(info?.file || info?.url, { maxBytes: 30 * 1024 * 1024 })
    const spec = stt.resolve({ audio: new Uint8Array(toMono16k(raw)) })
    const r = await stt.transcribe(spec, AbortSignal.timeout(60000))
    const text = typeof r === 'string' ? r : r?.text || r?.transcript
    return text ? String(text).trim() : ''
  }

  async function imagesOf(msg) {
    const out = []
    for (const seg of [...msg.stickers, ...msg.images].slice(0, 4)) {
      try {
        const buf = await segmentBytes(seg, onebot, { maxBytes: 8 * 1024 * 1024 })
        const mime = mimeOf(buf)
        if (!mime.startsWith('image/')) continue
        out.push({ data: buf.toString('base64'), mediaType: mime })
      } catch (error) {
        log.debug('图片下载失败：', error.message)
      }
    }
    return out
  }

  async function onMessage(event) {
    selfId = String(event.self_id || selfId || getConfig().botQQ)
    const cfg = getConfig()
    const msg = parseMessageEvent(event, selfId, { faceName: faces.nameOf })
    if (msg.userId === selfId) return
    // 按群头衔过滤：这条当没看见（不进群聊上下文、不触发回复，@ 她、主人命令也一样）
    if (msg.kind === 'group' && await titleFilter.shouldIgnore(event)) return
    bump('received')
    const now = Date.now()

    // 群里的每条消息都记进缓冲（给上下文和「群里在不在聊」用）
    let groupEntry = null
    if (msg.kind === 'group') {
      const buf = groupBuf.get(msg.groupId) || []
      groupEntry = { t: now, uid: msg.userId, nick: msg.nickname, text: msg.text, at: msg.mentioned, mid: msg.messageId, direct: false }
      buf.push(groupEntry)
      while (buf.length > 40) buf.shift()
      groupBuf.set(msg.groupId, buf)
    }

    const allowed = checkAllowed(cfg, msg)
    // 偷表情：只从白名单里的会话偷
    if (allowed.allowed && msg.stickers.length && cfg.stickers.collect) {
      const okSrc = msg.kind === 'group' ? cfg.stickers.fromGroups : cfg.stickers.fromPrivate
      if (okSrc) for (const s of msg.stickers) stickers.collect(s, msg.chatId).then((r) => { if (!r.ok) log.debug('没收这张表情：', r.reason) }).catch(() => {})
    }
    if (!allowed.allowed) {
      log.debug(`忽略 ${msg.chatId}（${allowed.reason}）`)
      return
    }
    // 最近发来的图片 / 表情记几张（「把刚才那张存下来」时用）
    if (msg.stickers.length || msg.images.length) {
      recentMedia.remember(msg.chatId, [...msg.stickers, ...msg.images].map((seg) => ({ seg, userId: msg.userId, sticker: msg.stickers.includes(seg) })))
    }
    // 主人命令（/silent /active …）：总开关关着也处理，回复直接发
    if (onCommand && isOwner(cfg, msg.userId) && /^\s*[/／]/.test(msg.text)) {
      try {
        const reply = await onCommand(msg)
        if (reply) {
          log.info(`主人命令 ${msg.text.trim().slice(0, 30)} → ${reply.split('\n')[0]}`)
          await sendSegments(msg.chatId, [{ type: 'text', data: { text: reply } }], reply.slice(0, 60), { force: true })
          return
        }
      } catch (error) {
        log.warn('执行命令出错：', error.message)
        await sendSegments(msg.chatId, [{ type: 'text', data: { text: '命令没执行成功：' + error.message } }], '命令出错', { force: true })
        return
      }
    }
    if (!getConfig().enabled) {
      log.info(`总开关关着，收到 ${msg.chatId} 的消息但不处理：${msg.text.slice(0, 30)}`)
      return
    }

    if (isMuted?.(msg.chatId)) {
      log.debug(`${msg.chatId}：主人让她闭嘴中，不回`)
      logChat(msg.chatId, msg.nickname, msg.text, msg.userId)
      return
    }

    // 扩展模块可以先接管这条消息（关键词回复、转给自己的服务……）
    if (hooks?.message) {
      try {
        if (await hooks.message({ ...msg, raw: event })) {
          logChat(msg.chatId, msg.nickname, msg.text, msg.userId)
          return
        }
      } catch (error) {
        log.warn('扩展模块处理消息出错：', error.message)
      }
    }

    let mode = 'must'
    if (msg.kind === 'group') {
      const pol0 = policyFor(cfg.group, cfg.group.overrides, msg.groupId)
      // 心情好更爱插话，心情差少插话
      const pol = { ...pol0, interjectChance: Math.min(1, pol0.interjectChance * mood().chatty) }
      // 群里最近在聊的（窗口内最后几条）和她有多相关
      const recentTexts = (groupBuf.get(msg.groupId) || []).filter((x) => now - x.t < pol.activeWindowSec * 1000).slice(-6).map((x) => x.text)
      let memScore = 0
      try { memScore = typeof memoryScore === 'function' ? memoryScore(recentTexts.join(' ')) : 0 } catch (error) {}
      const quotedBot = await repliedToBot(msg.replyId)
      const decision = decideGroupReply({
        policy: pol,
        relevance: topicRelevance(recentTexts, pol.interests, memScore),
        engagedUntil: groupEngaged.get(msg.groupId) || 0,
        mentioned: msg.mentioned,
        repliedToBot: quotedBot,
        fromOwner: isOwner(cfg, msg.userId),
        text: msg.text,
        now,
        hour: new Date().getHours(),
        recentTimes: (groupBuf.get(msg.groupId) || []).map((x) => x.t),
        interjectTimes: groupInterjects.get(msg.groupId) || [],
        botReplyTimes: groupSaid.get(msg.groupId) || [],
      })
      if (hooks?.groupDecide) {
        try {
          const next = await hooks.groupDecide(decision, { msg, policy: pol, recentTexts, memScore })
          if (next && typeof next === 'object') Object.assign(decision, next)
        } catch (error) {
          log.warn('扩展模块改群聊决定出错：', error.message)
        }
      }
      if (!decision.reply) {
        log.debug(`群 ${msg.groupId}：不回（${decision.reason}）`)
        logChat(msg.chatId, msg.nickname, msg.text, msg.userId)
        // 已经有一段在等她回：这条也算进去（她回的时候能看到），但不单独再触发一次
        if (pending.has(msg.chatId)) await addGroupImages(msg)
        return
      }
      groupEntry.direct = Boolean(msg.messageId && msg.messageId !== '0' && msg.userId && (msg.mentioned || quotedBot))
      mode = decision.mode
      log.info(`群 ${msg.groupId}：${decision.reason} → 交给她`)
    }

    // 拼文案
    let text = msg.text
    if (msg.forwards?.length) {
      text = await expandForwards(msg, text)
      if (msg.kind === 'group') {
        const last = (groupBuf.get(msg.groupId) || []).findLast?.((x) => x.uid === msg.userId)
        if (last) last.text = text
      }
    }
    const voiceText = cfg.voice.asr && msg.records.length ? await transcribe(msg) : msg.records.length ? '[发来一条语音]' : ''
    if (voiceText) text = (text ? text + ' ' : '') + voiceText
    if (voiceText && msg.kind === 'group') {
      // 群消息的文字在 groupBuf 里，语音转出来的字补进去，拼提示词时才看得到
      const last = (groupBuf.get(msg.groupId) || []).findLast?.((x) => x.uid === msg.userId)
      if (last) last.text = text
    }
    // 群聊：不在这里拼文案。等这段消息攒齐了（或她回完上一段），flush 时把群里新来的话一次性交给她
    const content = msg.kind === 'group' ? [] : [{ type: 'text', text: `【私聊】${msg.nickname}(${msg.userId})：` + (text || '（没有文字）') }]
    const imgs = await imagesOf(msg)
    if (imgs.length) {
      // 模型明确不支持看图：硬塞图片块会让整轮请求被拒（她就一个字都回不了），改成一行文字提示
      if ((await canSeeImages(dsh, cfg)) === false) {
        content.push({ type: 'text', text: `（${msg.nickname} 发了 ${imgs.length} 张图片，你现在的模型看不了图，只能知道有这么回事）` })
        log.debug(`模型不支持看图：${msg.chatId} 的 ${imgs.length} 张图换成文字提示`)
      } else {
        for (let i = 0; i < imgs.length; i++) content.push({ type: 'image', data: imgs[i].data, mediaType: imgs[i].mediaType, name: `qq-${msg.messageId}-${i + 1}` })
      }
    }
    logChat(msg.chatId, msg.nickname, text, msg.userId)
    lastChatAt = now
    if (msg.kind === 'private' && msg.userId === cfg.ownerQQ) lastOwnerChatAt = now
    onActivity?.({ kind: 'in', chatId: msg.chatId, userId: msg.userId, nickname: msg.nickname, text, direct: msg.kind === 'private' || msg.mentioned || mode === 'must', owner: isOwner(cfg, msg.userId) })

    enqueue({ chatId: msg.chatId, kind: msg.kind, userId: msg.userId, groupId: msg.groupId, nickname: msg.nickname }, content, msg.userId, wantsVoice(msg.text), mode)
  }

  /** 把消息里的「[合并转发]」换成里面的聊天记录（最多 40 条，嵌套的转发不再展开）。 */
  async function expandForwards(msg, text) {
    let out = text
    for (const id of msg.forwards.slice(0, 2)) {
      let lines = []
      try {
        const r = await onebot.call('get_forward_msg', { id }, { timeoutMs: 15000 })
        for (const node of (r?.messages || []).slice(0, 40)) {
          const who = node.sender?.card || node.sender?.nickname || String(node.sender?.user_id ?? node.user_id ?? '某人')
          const m = parseMessageEvent({ message_type: 'private', user_id: node.sender?.user_id ?? node.user_id, message: node.message ?? node.content ?? [] }, selfId, { faceName: faces.nameOf })
          lines.push(`  ${who}：${(m.text || '（图片/表情）').slice(0, 120)}`)
        }
      } catch (error) {
        log.debug('拉合并转发失败：', error.message)
      }
      const body = lines.length ? `[合并转发的聊天记录（${lines.length} 条）]\n${lines.join('\n').slice(0, 2000)}\n[转发结束]` : '[合并转发（内容没拉到）]'
      out = out.replace('[合并转发]', body)
    }
    return out
  }

  // ---------- 戳一戳 ----------
  const lastPoker = new Map() // chatId → 最近戳她的人（她戳回去用）
  const lastSpeaker = new Map() // chatId → 群里最近一段最后说话的人
  const pokeAt = new Map() // chatId → 上次处理戳一戳的时间
  /** 有人戳了她：当成一条对她说的话交给她（群里也一定回），同一个聊天 20 秒内只算一次。 */
  async function onPoke(ev) {
    const self = String(ev.self_id || selfId || getConfig().botQQ)
    if (String(ev.target_id) !== self) return
    if (hooks?.poke) {
      try { if (await hooks.poke(ev)) return } catch (error) {}
    }
    const group = ev.group_id ? String(ev.group_id) : ''
    const poker = String(group ? ev.user_id : ev.sender_id ?? ev.user_id)
    if (!poker || poker === self) return
    if (group && await titleFilter.shouldIgnore({ group_id: group, user_id: poker })) return
    const chatId = group ? `group:${group}` : `private:${poker}`
    lastPoker.set(chatId, poker)
    if (Date.now() - (pokeAt.get(chatId) || 0) < 20_000) return
    pokeAt.set(chatId, Date.now())
    let nickname = poker
    try {
      const info = group ? await onebot.call('get_group_member_info', { group_id: Number(group), user_id: Number(poker) }, { timeoutMs: 5000 }) : await onebot.call('get_stranger_info', { user_id: Number(poker) }, { timeoutMs: 5000 })
      nickname = info?.card || info?.nickname || poker
    } catch (error) {}
    log.info(`${chatId}：${nickname} 戳了戳她`)
    await onMessage({
      post_type: 'message', message_type: group ? 'group' : 'private', sub_type: group ? 'normal' : 'friend',
      self_id: Number(self), user_id: Number(poker), ...(group ? { group_id: Number(group) } : {}), message_id: 0,
      sender: { user_id: Number(poker), nickname, card: nickname },
      message: [{ type: 'at', data: { qq: self } }, { type: 'text', data: { text: ` [戳了戳你${ev.action ? '：' + ev.action + (ev.suffix || '') : ''}]` } }],
    })
  }

  /** 没触发回复的群消息带的图：如果正有一段在等她回，把图也带上（最多 4 张）。 */
  async function addGroupImages(msg) {
    const p = pending.get(msg.chatId)
    if (!p || p.images.length >= 4) return
    try {
      if ((await canSeeImages(dsh, getConfig())) === false) return
      const imgs = await imagesOf(msg)
      for (let i = 0; i < imgs.length && p.images.length < 4; i++) p.images.push({ type: 'image', data: imgs[i].data, mediaType: imgs[i].mediaType, name: `qq-${msg.messageId}-${i + 1}` })
    } catch (error) {}
  }

  /** 群聊这一段的提示词：之前的几句当背景，上次交给她之后群里新说的话全部列出来，让她看完整段再回。 */
  async function groupPrompt(chat, mode) {
    const name = await groupName(chat.groupId)
    const buf = groupBuf.get(chat.groupId) || []
    // 时间戳可能同一毫秒：直接取上一轮之后的消息，避免紧接着到达的消息丢失。
    const fresh = buf.filter((x) => !x.fed).slice(-20)
    const older = buf.filter((x) => x.fed).slice(-8)
    for (const x of buf) x.fed = true
    const line = (x) => `${x.nick}(${x.uid})${x.at ? '@了你' : ''}：${x.text || '（图片/表情）'}`
    // 新消息带编号，她想专门回某一条时可以引用；编号 → QQ 消息 ID 记下来，发的时候换成引用
    const refs = {}
    const numbered = fresh.map((x, i) => {
      if (x.mid && x.mid !== '0') refs[i + 1] = { mid: x.mid, uid: x.uid }
      return `[${i + 1}] ${line(x)}`
    })
    groupRefs.set(chat.groupId, refs)
    const query = fresh.map((x) => x.text).filter(Boolean).join('\n')
    const speakers = [...new Set(fresh.map((x) => String(x.uid)).filter(Boolean))]
    const hint = mode === 'interject' ? '（没人叫你。只有你对这个话题真有话说、能自然接上时才插一句：接着话题说，别突然开新话题；接不上就只回 [沉默]）'
      : mode === 'engaged' ? '（你刚才在参与这个话题。想接着聊就接着说，话题和你没关系了或没什么可说的就只回 [沉默]）'
      : '（有人在叫你，看完这一段再回）'
    const text = (older.length ? `【群聊 ${name}】之前在聊：\n${older.map(line).join('\n')}\n\n` : '') +
      `【群聊 ${name}】刚才新说的（${fresh.length} 条）${hint}\n${numbered.join('\n')}\n\n` +
      '把这一段当成整体来回：一般说一两句就好，回给最需要回的那个人或者整个话题，不要一条一条地挨个回。\n' +
      '大多数时候直接说就行。只有想专门接其中某一条、而直接说别人会看不出你在回谁时（比如那条已经被后面的话刷上去了、或者你在回某个人随口一提的事），才在那句话开头写 <reply:编号>，会以「引用回复」发出；一次最多引用一条。\n' +
      '要 @ 某个人（对方会收到提醒），写 <at:QQ号>，QQ 号就是上面名字后面括号里的数字。'
    const direct = fresh.filter((x) => x.direct)
    const directSenders = new Set(direct.map((x) => x.uid))
    const target = directSenders.size === 1 ? direct.at(-1) : null
    const autoReply = target ? { mid: target.mid, uid: target.uid } : null
    return { text, query, speakers, autoReply }
  }

  // ---------- 连发合并：人常常一口气发好几句，等对方说完再一起交给她，别一句一回 ----------
  // 群聊再加一层：她正在回上一段时，新消息先攒着，等她说完再一起交给她（不会一条消息一轮、挨个回）
  const pending = new Map() // chatId → { chat, texts, images, senders, wantVoice, timer, firstAt, mode, count }
  const busy = new Map() // chatId → 这一轮开始的时间（她正在想 / 正在发）
  const BUSY_MAX_MS = 4 * 60_000 // 卡住保护：超过这么久就当她已经回完了
  const RANK = { engaged: 1, interject: 2, must: 3 }
  const running = new Set() // chatId → 这一轮还在跑（模型 / 工具还没结束，turn/end 之前）；私聊此时新消息直接 steer 进去
  const isBusy = (chatId) => busy.has(chatId) && Date.now() - busy.get(chatId) < BUSY_MAX_MS

  function enqueue(chat, content, senderId, wantVoice, mode = 'must') {
    const m = getConfig().merge
    const p = pending.get(chat.chatId) || { chat, texts: [], images: [], senders: new Set(), wantVoice: false, timer: null, firstAt: Date.now(), mode, count: 0 }
    p.chat = chat
    p.count++
    if ((RANK[mode] || 3) > (RANK[p.mode] || 3)) p.mode = mode
    for (const c of content) {
      if (c.type === 'text') p.texts.push(c.text)
      else if (c.type === 'image' && p.images.length < 4) p.images.push(c)
    }
    if (senderId) p.senders.add(String(senderId))
    p.wantVoice = p.wantVoice || wantVoice
    pending.set(chat.chatId, p)
    clearTimeout(p.timer)
    if (!m.enabled) return flush(chat.chatId)
    // 群里大家一来一回说得慢，多等一会儿把一段话攒齐
    const group = chat.kind === 'group'
    const wait = (group ? m.groupWaitSec : m.waitSec) * 1000
    const max = (group ? m.groupMaxSec : m.maxSec) * 1000
    const left = Math.max(0, max - (Date.now() - p.firstAt))
    p.timer = setTimeout(() => flush(chat.chatId), Math.min(wait, left))
    p.timer.unref?.()
  }

  async function flush(chatId) {
    const p = pending.get(chatId)
    if (!p) return
    clearTimeout(p.timer)
    // 私聊：她这一轮还在跑（想 / 调工具），新消息直接 steer 进当前这一轮，像在 DSH 界面里插话一样（#7）
    if (isBusy(chatId) && p.chat.kind === 'private' && running.has(chatId)) {
      pending.delete(chatId)
      if (p.count > 1) log.info(`${chatId}：合并了 ${p.count} 条消息一起插给她`)
      const content = [{ type: 'text', text: p.texts.join('\n') }, ...p.images]
      const query = p.texts.map((t) => t.replace(/^【私聊】[^：]*：/, '')).join('\n')
      const [first, ...rest] = [...p.senders]
      try {
        await pushToSession(p.chat, content, first, { wantVoice: p.wantVoice, extraSenders: rest, queryText: query, steer: true })
      } catch (error) {
        bump('errors')
        log.error(`插话进 DSH 失败（${chatId}）：`, error.message)
      }
      return
    }
    // 她还在回上一段：先攒着，回完了再交（release 会叫 flush）
    if (isBusy(chatId)) {
      p.waiting = true
      return
    }
    pending.delete(chatId)
    if (p.count > 1) log.info(`${chatId}：合并了 ${p.count} 条消息一起交给她`)
    let content
    if (p.chat.kind === 'group') {
      const gid = p.chat.groupId
      if (p.mode === 'interject') {
        const arr = (groupInterjects.get(gid) || []).filter((t) => Date.now() - t < 3600_000)
        arr.push(Date.now())
        groupInterjects.set(gid, arr)
      }
      const gp = await groupPrompt(p.chat, p.mode)
      if (gp.speakers.length) lastSpeaker.set(chatId, [...p.senders].pop() || gp.speakers.at(-1))
      content = [{ type: 'text', text: gp.text }, ...p.images]
      p.query = gp.query
      p.speakers = gp.speakers
      p.autoReply = gp.autoReply
    } else {
      content = [{ type: 'text', text: p.texts.join('\n') }, ...p.images]
    }
    busy.set(chatId, Date.now())
    try {
      const [first, ...rest] = [...p.senders]
      // 私聊：检索记忆时去掉「【私聊】某某(QQ)：」这个头
      const query = p.query ?? p.texts.map((t) => t.replace(/^【私聊】[^：]*：/, '')).join('\n')
      await pushToSession(p.chat, content, first, { wantVoice: p.wantVoice, extraSenders: rest, queryText: query, speakers: p.speakers, autoReply: p.autoReply })
    } catch (error) {
      release(chatId)
      bump('errors')
      log.error(`转进 DSH 失败（${chatId}）：`, error.message)
    }
  }

  /** 她这一轮说完了（或者没说）：放开，把这期间攒下的消息交给她。 */
  function release(chatId) {
    busy.delete(chatId)
    running.delete(chatId)
    const p = pending.get(chatId)
    if (p && p.waiting) {
      p.waiting = false
      flush(chatId).catch(() => {})
    }
  }

  async function admit(agent, content) {
    if (content.length === 1) return content
    const att = dsh.attachments || dsh.get('attachments')
    if (att && typeof att.admitPromptContent === 'function') {
      try {
        return await att.admitPromptContent(content)
      } catch (error) {
        log.warn('图片交给 DSH 没成功（这轮只给文字）：', error.message)
      }
    }
    return content.filter((c) => c.type === 'text')
  }

  // 私聊里等她回复时，在 QQ 上显示「对方正在输入…」（模型慢的时候让人知道她在想）
  const typing = new Map() // sessionKey → timer
  function startTyping(key, chat) {
    const cfg = getConfig()
    if (chat.kind !== 'private' || !cfg.enabled || cfg.dryRun || typing.has(key)) return
    const ping = () => onebot.call('set_input_status', { user_id: Number(chat.userId), event_type: 1 }, { timeoutMs: 5000 }).catch(() => {})
    ping()
    const started = Date.now()
    const t = setInterval(() => {
      if (Date.now() - started > 6 * 60_000) return stopTyping(key)
      ping()
    }, 15_000)
    t.unref?.()
    typing.set(key, t)
  }
  function stopTyping(key) {
    const t = typing.get(key)
    if (t) clearInterval(t)
    typing.delete(key)
  }

  async function pushToSession(chat, content, senderId, opts = {}) {
    const { agent, sessionId } = await agentFor(chat)
    const key = sessionKey(sessionId)
    const st = turnState.get(key) || { lastTurn: -1, text: '', senders: new Set() }
    // 上一句也带上：相关记忆检索遇到「嗯嗯」这种短句时，用上一句一起找（#79 之后由模块在提示词里加）
    const prevText = st.lastText || st.prevText || ''
    if (hooks?.prompt) {
      try {
        const next = await hooks.prompt(content, { chat, sessionId, senderId, prevText, ...opts })
        if (next === null) {
          log.info(`${chat.chatId}：扩展模块决定这次不交给她`)
          if (!opts.steer) release(chat.chatId) // 插话被拦下时，当前这一轮还在跑，不能放开
          return
        }
        if (Array.isArray(next)) content = next
      } catch (error) {
        log.warn('扩展模块改提示词出错：', error.message)
      }
    }
    const earlier = saidElsewhere.get(chat.chatId)
    if (earlier?.length) {
      saidElsewhere.delete(chat.chatId)
      const lines = earlier.map((x) => `${new Date(x.at).toTimeString().slice(0, 5)} 你：${x.text}`)
      content = [{ type: 'text', text: `【你之前在这个聊天里主动说过（是在别处安排下发的，这里的人都看到了）】\n${lines.join('\n')}\n` }, ...content]
    }
    // 这一轮还在跑、这句是排队给下一轮的：额外记到 pendingSenders，等上一轮 turn/end 时接过去（#90）
    const queuedNextTurn = !opts.steer && (running.has(chat.chatId) || busy.has(chat.chatId))
    const addSender = (u) => {
      st.senders.add(String(u))
      if (queuedNextTurn) {
        if (!st.pendingSenders) st.pendingSenders = new Set()
        st.pendingSenders.add(String(u))
      }
    }
    if (senderId) addSender(senderId)
    for (const s of opts.extraSenders || []) addSender(s)
    // 上一句也留着：这一句太短（「嗯嗯」「然后呢」）时一起拿去想起相关的事
    if (st.lastText) st.prevText = st.lastText
    st.lastText = String(opts.queryText ?? content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')).slice(-600)
    st.speakers = opts.speakers || (senderId ? [String(senderId), ...(opts.extraSenders || []).map(String)] : [])
    if (opts.wantVoice) st.wantVoice = true
    if (!opts.steer) st.autoReply = opts.autoReply || null
    turnState.set(key, st)
    const admitted = await admit(agent, content)
    startTyping(key, chat)
    const message = { id: randomUUID(), role: 'user', content: admitted, source: { kind: SOURCE_KIND } }
    // 正在跑的这一轮：steer = 下一步就看到这句（DSH 界面插话走的也是它）；空闲时照旧 followup 开新一轮
    if (opts.steer && typeof agent.steer === 'function') {
      log.info(`${chat.chatId}：她还在忙，这句直接插进当前这一轮（steer）`)
      await agent.steer(message)
    } else {
      running.add(chat.chatId)
      await agent.followup(message)
    }
    try {
      if (dsh.sessions && typeof dsh.sessions.flush === 'function') await dsh.sessions.flush(agent.session)
    } catch (error) {}
  }

  /** 后台任务（写日记、主动搭话的草稿）：在专用会话里跑一轮，拿到正文但不自动转发。 */
  async function runSystemTurn(name, title, prompt, { timeoutMs = 180000, noTools = false } = {}) {
    const chat = { chatId: `system:${name}`, kind: 'system', title, noTools: !!noTools }
    const { agent, sessionId } = await agentFor(chat)
    const key = sessionKey(sessionId)
    const st = turnState.get(key) || { lastTurn: -1, text: '', senders: new Set() }
    if (st.system) throw new Error('这个后台会话的上一轮还没结束')
    turnState.set(key, st)
    let timer
    const result = new Promise((resolve, reject) => {
      st.system = { resolve, reject }
      timer = setTimeout(() => {
        if (st.system) st.system = { resolve() {}, reject() {} }
        reject(new Error('等太久了'))
      }, timeoutMs)
    }).finally(() => clearTimeout(timer))
    // followup 有的宿主一直等到整轮结束才返回；不能先 await 它，否则超时 Promise 会悬空。
    // 超时后的系统会话仍保留标记，晚到的结果只丢弃，绝不误发到 QQ。
    const system = st.system
    Promise.resolve().then(() => agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: SOURCE_KIND } })).catch((error) => {
      if (st.system === system) { st.system = null; system.reject(error) }
    })
    return result
  }

  /** 这一轮里说话的人是不是全是主人（群管等敏感工具用）。 */
  /** 这一轮里主人说过话（群里常有别人插话，不要求每条都是主人）。 */
  // 主人私聊里只可能是主人说话：就算这一轮的记录丢了（工具是旧闭包、排队轮次被上一轮 turn/end 清掉等，见 #90），
  // 「仅主人」也应当放行；群聊 / 别人私聊不放宽。
  function ownerPrivateChat(sessionId) {
    try { return chatOfSession(sessionId) === `private:${getConfig().ownerQQ}` } catch (error) { return false }
  }

  function turnHasOwner(sessionId) {
    const st = turnState.get(sessionKey(sessionId))
    if (st && st.directOwner) return true // 主人在 DSH 面板里直接打字
    if (st && [...st.senders].some((u) => isOwner(getConfig(), u))) return true
    return ownerPrivateChat(sessionId)
  }

  function turnSendersAllOwner(sessionId) {
    const st = turnState.get(sessionKey(sessionId))
    if (st && st.directOwner) return true // 主人在 DSH 面板里直接打字
    if (!st || !st.senders.size) return ownerPrivateChat(sessionId)
    return [...st.senders].every((u) => isOwner(getConfig(), u))
  }

  function chatOfSession(sessionId) {
    const key = sessionKey(sessionId)
    const live = sessionToChat.get(key)
    if (live) return live
    // 重启后会话还没被第一条消息唤醒时，内存映射是空的：退回持久化的 聊天→会话 映射（#90 兜底要用）
    try {
      for (const [chatId, entry] of Object.entries(map().chats || {})) {
        if (entry && entry.sessionId && sessionKey(entry.sessionId) === key) return chatId
      }
    } catch (error) {}
    return ''
  }

  /** 只让一个聊天重新开始：归档它的会话，下一条消息开新会话。 */
  function resetChat(chatId) {
    const reg = dsh.workspaceRegistry || dsh.get('workspaceRegistry')
    const m = map()
    const e = m.chats[chatId]
    if (!e) return false
    Promise.resolve(reg?.archiveSession?.(e.sessionId)).catch((error) => log.debug('归档会话失败：', error.message))
    sessionToChat.delete(sessionKey(e.sessionId))
    turnState.delete(sessionKey(e.sessionId))
    delete m.chats[chatId]
    saveMap(m)
    log.info(`${chatId} 重新开始`)
    return true
  }

  /** 重新开始：把现有的 QQ 会话都归档（侧栏里还能找回），下一条消息起开新会话。 */
  function resetSessions() {
    const reg = dsh.workspaceRegistry || dsh.get('workspaceRegistry')
    const m = map()
    let n = 0
    for (const [chatId, e] of Object.entries(m.chats)) {
      try {
        // 可能返回 Promise：必须接住 rejection，未处理的 rejection 会让 DSH 宿主退出
        Promise.resolve(reg?.archiveSession?.(e.sessionId)).catch((error) => log.debug('归档会话失败：', error.message))
      } catch (error) {
        log.debug('归档会话失败：', error.message)
      }
      sessionToChat.delete(sessionKey(e.sessionId))
      turnState.delete(sessionKey(e.sessionId))
      delete m.chats[chatId]
      n++
    }
    // 专用工作区里其他零散的会话（比如手动点「新会话」留下的空白会话）也一起归档
    try {
      const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase()
      const ws = (reg?.list?.() || []).find((w) => norm(w.path) === norm(workspaceDirOf(getConfig())))
      for (const sid of ws?.sessionIds || []) {
        if ((reg.archivedSessionIds || []).includes(sid)) continue
        Promise.resolve(reg.archiveSession(sid)).catch(() => {})
        n++
      }
    } catch (error) {}
    saveMap(m)
    log.info(`重新开始：归档了 ${n} 个 QQ 会话`)
    return n
  }

  /** 模拟测试：fn 里发出去的消息都记下来不真发，返回 { result, sent }。 */
  async function capture(fn) {
    const sent = []
    const result = await captureStore.run(sent, fn)
    return { result, sent }
  }
  /** 模拟测试：假装这个会话这一轮是谁在说话（工具里的「主人才能用」靠它判断）。 */
  function simulateTurn(sessionId, senders) {
    turnState.set(sessionKey(sessionId), { lastTurn: -1, text: '', senders: new Set(senders.map(String)) })
  }

  return {
    // 仅关闭本中枢持有的短期媒体缓存，迟到的事件不能重新写入。
    disposeRecentMedia: () => recentMedia.dispose(),
    modelFor: targetModel,
    /** 这个聊天最近发来的图片 / 表情（新的在后面），可选只要某人发的 */
    recentMedia: (chatId, userId) => recentMedia.get(chatId, userId),
    capture,
    simulateTurn,
    onMessage,
    onPoke,
    onSessionEvent,
    deliver,
    sendText,
    sendVoice,
    sendVoiceFile,
    sendFile,
    sendSticker,
    sendImage,
    sendSegments,
    pushToSession,
    titleFilter,
    runSystemTurn,
    turnSendersAllOwner,
    turnHasOwner,
    resetChat,
    joinTopic: (gid) => groupEngaged.set(String(gid), Date.now() + ENGAGE_MS),
    leaveTopic: (gid) => groupEngaged.delete(String(gid)),
    chatOfSession,
    canSeeImages: async (chat) => {
      const cfg = getConfig()
      if (cfg.model?.vision === 'on') return true
      if (cfg.model?.vision === 'off') return false
      const selected = targetModel(chat)
      return selected ? modelVision(dsh, selected.provider, selected.model) : null
    },
    resetSessions,
    lastTextOf: (sessionId) => turnState.get(sessionKey(sessionId))?.lastText || '',
    prevTextOf: (sessionId) => turnState.get(sessionKey(sessionId))?.prevText || '',
    speakersOf: (sessionId) => turnState.get(sessionKey(sessionId))?.speakers || [],
    logChat,
    localTranscribe,
    ensureWorkspace,
    chatLogOf,
    chatLogDays,
    deleteChatLog,
    sessions: () => map().chats,
    groupName,
    stats: () => ({ ...stats }),
    get lastChatAt() { return lastChatAt },
    get lastOwnerChatAt() { return lastOwnerChatAt },
    get lastBotToOwner() { return lastBotToOwner },
    get selfId() { return selfId },
    groupNames,
  }
}
