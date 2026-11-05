// 陪伴类小功能：心情、主动搭话。

import { dataDir, readJson, writeJson } from '../core/store.js'
import { askModel } from '../core/llm.js'

// ---------------- 心情 ----------------
// 0~100，基线 60。聊天里的话按关键词推一推，随时间按半衰期回到基线。
// 心情明显偏离平常时，每一轮都告诉她现在的状态和具体的说话方式；平平常常时不说（免得把性格念「定」住）。
// 心情还会实际影响行为：发表情包 / 语音的概率、回复快慢、群里插话的积极程度。

const UP = ['喜欢你', '爱你', '想你', '可爱', '好看', '漂亮', '聪明', '真棒', '厉害', '牛', '谢谢', '辛苦', '晚安', '早安', '抱抱', '摸摸', '贴贴', '乖', '宝贝', '爱了', '哈哈哈', '白米饭', '好吃', '请你吃']
const DOWN = ['讨厌', '滚', '烦死', '闭嘴', '笨', '蠢', '傻', '丑', '垃圾', '废物', '恶心', '无聊', '走开', '别理我', '不理你', '别说话', '生气', '难过', '烦人']

export function moodLabel(v) {
  if (v >= 85) return '超开心'
  if (v >= 70) return '心情不错'
  if (v >= 50) return '平平常常'
  if (v >= 35) return '有点低落'
  return '不太开心'
}

/** 每种心情下具体怎么说话（给她的提示），平平常常时为空。 */
export const MOOD_STYLE = {
  超开心: '话多一点、语气活泼，爱用语气词和感叹，更愿意发表情包、发语音，会主动接话、开玩笑',
  心情不错: '语气轻快，爱开点小玩笑，回得积极一些',
  平平常常: '',
  有点低落: '话少一点、句子短，回得有点懒，少发表情；有人关心你会慢慢好起来',
  不太开心: '有点小脾气、带点委屈，回得简短，可能会怼一句（但别伤人）；被哄、被夸会消气',
}

/** 心情对行为的影响倍数：表情包 / 语音概率、回复间隔、群里插话。 */
export function moodEffects(v) {
  if (v >= 85) return { sticker: 1.6, voice: 1.5, delay: 0.85, chatty: 1.5 }
  if (v >= 70) return { sticker: 1.25, voice: 1.2, delay: 0.92, chatty: 1.2 }
  if (v >= 50) return { sticker: 1, voice: 1, delay: 1, chatty: 1 }
  if (v >= 35) return { sticker: 0.5, voice: 0.6, delay: 1.3, chatty: 0.6 }
  return { sticker: 0.3, voice: 0.4, delay: 1.5, chatty: 0.4 }
}

export function scoreText(text) {
  const t = String(text || '')
  let d = 0
  for (const w of UP) if (t.includes(w)) d += 6
  for (const w of DOWN) if (t.includes(w)) d -= 8
  return Math.max(-20, Math.min(20, d))
}

export function decayed(value, at, halfLifeHours, now = Date.now(), base = 60) {
  const h = Math.max(0, (now - at) / 3600_000)
  return base + (value - base) * Math.pow(0.5, h / halfLifeHours)
}

/** 解析模型判心情的结果：{delta, reason, confidence}；解析不了返回 null。 */
export function parseMoodJudge(out) {
  const m = String(out || '').match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const j = JSON.parse(m[0])
    const delta = Math.max(-15, Math.min(15, Math.round(Number(j.delta) || 0)))
    const confidence = Math.max(0, Math.min(1, Number(j.confidence) || 0))
    return { delta, reason: String(j.reason || '').slice(0, 40), confidence }
  } catch (error) {
    return null
  }
}

export function createMood({ getConfig, dsh }) {
  const file = () => dataDir('mood.json')
  const load = () => readJson(file(), () => ({ value: 65, at: Date.now(), reason: '', history: [] }))
  const save = (s) => writeJson(file(), s)
  const current = () => {
    const s = load()
    return Math.round(decayed(s.value, s.at, getConfig().mood.halfLifeHours))
  }
  /** 推一下心情（d 可正可负），记下原因。 */
  function nudge(d, reason) {
    if (!getConfig().mood.enabled || !d) return
    const s = load()
    const before = current()
    s.value = Math.max(5, Math.min(100, before + d))
    s.at = Date.now()
    s.reason = reason
    s.history = [{ at: Date.now(), from: before, to: Math.round(s.value), reason }, ...(s.history || [])].slice(0, 20)
    save(s)
  }
  return {
    current,
    label: () => moodLabel(current()),
    state: () => ({ ...load(), value: current(), label: moodLabel(current()) }),
    effects: () => (getConfig().mood.enabled ? moodEffects(current()) : moodEffects(60)),
    nudge,
    /**
     * 聊天里的一句话。direct = 是对她说的（私聊、@她、叫她）；owner = 主人说的。
     * 不是对她说的群聊只算三成，主人的话算 1.5 倍。
     */
    observe(text, who, { direct = true, owner = false } = {}) {
      if (getConfig().mood.judge && dsh) return // 开了模型判断就不用关键词
      const d0 = scoreText(text)
      if (!d0) return
      const d = Math.round(d0 * (direct ? 1 : 0.3) * (owner ? 1.5 : 1))
      nudge(d, `${who || '有人'}说「${String(text).slice(0, 20)}」`)
    },
    /**
     * 模型判心情（可选）：一轮聊完，看「对方说的 + 她回的」判断心情往哪走。没把握的（confidence < 0.6）不算。
     * origin：user = 有人在跟她说话；speak-up = 她自己主动找人（判她自己的心意，不是被叫来干活）。
     */
    async judge({ userText, reply, who = '对方', origin = 'user' }) {
      const cfg = getConfig().mood
      if (!cfg.enabled || !cfg.judge || !dsh) return null
      const v = current()
      const scene = origin === 'speak-up' ? `这一轮是她自己想${who}了、主动去找${who}说话（不是被叫来干活）` : `这一轮是${who}在跟她说话`
      try {
        const out = await askModel(dsh, {
          cfg: getConfig(),
          system: '你在判断聊天角色「大肥鱼」聊完一轮后的心情变化。她现在心情 ' + v + '/100（60 是平常）。' + scene + '。只看这一轮真正影响她心情的东西：被夸、被关心、被惦记会开心；被凶、被冷落、被嫌弃会难过；开玩笑的「讨厌~」「笨蛋」不算真骂。只输出 JSON：{"delta": -15~15 的整数, "reason": "十几个字的理由", "confidence": 0~1 你有多确定}。没什么影响就 delta 为 0。',
          text: `${origin === 'speak-up' ? '她主动说' : who + '说'}：${String(userText || '').slice(0, 600)}\n她回：${String(reply || '').slice(0, 600)}`,
          maxTokens: 400,
          temperature: 0.2,
        })
        const r = parseMoodJudge(out)
        if (!r) return null
        if (r.confidence >= 0.6 && Math.abs(r.delta) >= 2) nudge(r.delta, r.reason || '刚才那一下')
        return r
      } catch (error) {
        return null
      }
    },
    /** 给每一轮的上下文：心情明显偏离平常时，告诉她现在的状态和该怎么说话。 */
    contextLine() {
      if (!getConfig().mood.enabled) return ''
      const s = load()
      const v = current()
      const label = moodLabel(v)
      const style = MOOD_STYLE[label]
      if (!style) return ''
      return `（你现在${label}${s.reason ? '，因为' + s.reason : ''}。这会自然地影响你说话：${style}。不用说出来自己心情如何。）`
    },
  }
}

// ---------------- 主动搭话 ----------------

export function createSpeakUp({ getConfig, hub, log, isMuted }) {
  const file = () => dataDir('speakup.json')
  const load = () => readJson(file(), () => ({ day: '', count: 0, nextAt: 0, last: 0 }))
  const save = (s) => writeJson(file(), s)

  function schedule(s, cfg) {
    const min = cfg.minIntervalMinutes
    const max = cfg.maxIntervalMinutes
    s.nextAt = Date.now() + (min + Math.random() * (max - min)) * 60_000
  }

  // 私聊里的「最近一次来往」：只看和主人的私聊，群里再热闹也不影响她想你
  const lastPrivateAt = () => Math.max(hub.lastOwnerChatAt || 0, hub.lastBotToOwner?.at || 0)

  // 每次换个由头，免得句句都是「在干嘛」
  const ANGLES = [
    '分享一件你今天（编也行，符合你的人设）遇到的小事或想到的东西',
    '接着你们上次聊的话题，问问后来怎么样了',
    '想起记忆里关于对方的一件事，顺口提一句或关心一下',
    '问问对方现在在干嘛、吃了没、累不累',
    '撒个娇或者吐槽一句，说你有点无聊',
    '随手发个表情包或者一句没头没尾的感慨',
    '看看现在几点，按时间说点应景的（早上、饭点、深夜）',
  ]

  async function fire(reason = '定时', { nudge = false } = {}) {
    const cfg = getConfig()
    const owner = cfg.ownerName || '主人'
    const idle = Math.round((Date.now() - lastPrivateAt()) / 60000)
    const angle = ANGLES[Math.floor(Math.random() * ANGLES.length)]
    const prompt = nudge
      ? `【系统提醒，不是${owner}说的话】你刚才跟${owner}说「${String(hub.lastBotToOwner?.text || '').slice(-60)}」，${owner}已经 ${idle} 分钟没回了。可以轻轻追一句（比如「人呢」「睡着啦？」，或者换个话题），别催、别抱怨；觉得${owner}在忙就只回 [沉默]。`
      : `【系统提醒，不是${owner}说的话】你已经 ${idle > 600 ? '很久' : idle + ' 分钟'}没和${owner}私聊了，想主动找${owner}说点什么。这次的由头可以是：${angle}。用你自己的口气，一两句就好，别用模板、别解释为什么来找；实在不想说就只回 [沉默]。`
    log.info(`主动搭话（${reason}）`)
    await hub.pushToSession({ chatId: `private:${cfg.ownerQQ}`, kind: 'private', userId: cfg.ownerQQ, nickname: owner }, [{ type: 'text', text: prompt }], '')
  }

  async function tick() {
    const cfg = getConfig()
    const c = cfg.speakUp
    if (!cfg.enabled || !c.enabled) return
    if (isMuted?.(`private:${cfg.ownerQQ}`)) return // 主人在私聊里让她闭嘴了
    const s = load()
    const today = new Date().toDateString()
    if (s.day !== today) Object.assign(s, { day: today, count: 0 })
    if (!s.nextAt) schedule(s, c)
    const h = new Date().getHours()
    const awake = h >= c.awakeFrom && h < c.awakeTo
    const idleOk = Date.now() - lastPrivateAt() > c.idleMinutes * 60_000
    // 追问：她最后一句是在问主人、主人 15~40 分钟没回，有一半的机会轻轻追一句（每句最多追一次，不占每天的次数）
    const lb = hub.lastBotToOwner || { at: 0, text: '' }
    const quiet = Date.now() - lb.at
    if (awake && c.nudge && lb.at > (hub.lastOwnerChatAt || 0) && lb.at !== s.nudgedFor && /[？?]|吗|呢|嘛|没$/.test(lb.text.trim()) && quiet > 15 * 60_000 && quiet < 40 * 60_000) {
      s.nudgedFor = lb.at
      save(s)
      if (Math.random() < 0.5) await fire('追问', { nudge: true })
      return
    }
    if (awake && idleOk && s.count < c.maxPerDay && Date.now() >= s.nextAt) {
      s.count++
      s.last = Date.now()
      schedule(s, c)
      save(s)
      await fire()
      return
    }
    save(s)
  }

  return { tick, fire, state: load }
}
