// 查天气：群里有人问天气就查了告诉他；主人 /天气 城市；她自己也能用 weather_now 工具。
// 数据来自 https://wttr.in/<城市>?format=3（纯文本，一行）。

const CACHE_MS = 10 * 60 * 1000

// 「北京天气怎么样」「上海今天天气如何」「明天杭州天气」「天气 广州」
const ASK_RE = /^(?:请问|问下|问一下)?\s*(?:(?:今天|现在|明天)\s*)?([一-龥A-Za-z·\s]{1,20}?)\s*(?:今天|现在|明天)?\s*(?:的)?天气(?:怎么样|如何|咋样|好吗|好不好)?[?？。!！~～]*$/
const ASK_RE2 = /^天气\s+(.{1,20})$/

/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'weather',
  name: '查天气',
  version: '0.1.0',
  api: 1,
  description: '群里有人问天气就查一下告诉他；主人可以 /天气 城市；她也能自己决定查天气',
  defaults: {
    city: '北京',
    groupAuto: true,
    timeoutSec: 8,
  },
  settings: [
    { key: 'city', label: '默认城市', type: 'text', placeholder: '北京', hint: '没说哪个城市时查这里' },
    { key: 'groupAuto', label: '群里有人问天气时直接查了回', type: 'switch', hint: '关掉的话，只靠她自己决定要不要用查天气工具' },
    { key: 'timeoutSec', label: '查询超时（秒）', type: 'number', min: 2, max: 30 },
  ],

  setup(api) {
    const cache = new Map() // city -> { at, text }

    const defaultCity = () => String(api.settings().city || '').trim() || '北京'

    async function query(city) {
      city = String(city || '').trim() || defaultCity()
      const key = city.toLowerCase()
      const hit = cache.get(key)
      if (hit && Date.now() - hit.at < CACHE_MS) return hit.text

      const timeoutMs = Math.max(2, Number(api.settings().timeoutSec) || 8) * 1000
      const url = `https://wttr.in/${encodeURIComponent(city)}?format=3`
      const res = await fetch(url, {
        headers: { 'User-Agent': 'curl/8.0', 'Accept-Language': 'zh-CN' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = (await res.text()).trim()
      if (!res.ok || !text || /unknown location|<html/i.test(text)) {
        throw new Error(`查不到「${city}」的天气（HTTP ${res.status}）`)
      }
      cache.set(key, { at: Date.now(), text })
      return text
    }

    // 1) 群里有人问某个城市的天气 → 直接查了告诉他
    api.on('message', async (msg) => {
      if (msg.kind !== 'group') return false
      if (!api.settings().groupAuto) return false
      const t = (msg.text || '').trim()
      const m = t.match(ASK_RE2) || t.match(ASK_RE)
      if (!m) return false
      let city = (m[1] || '').trim()
      // 「今天天气怎么样」这种没说城市的：用默认城市
      if (!city || /^(今天|现在|明天|这边|这里|外面)$/.test(city)) city = defaultCity()
      try {
        const w = await query(city)
        api.log.info('群里查天气', msg.chatId, city, w)
        await api.send(msg.chatId, `${msg.nickname ? msg.nickname + '，' : ''}帮你查了：${w}`)
      } catch (e) {
        api.log.warn('查天气失败', city, e?.message || e)
        await api.send(msg.chatId, `呜，${city}的天气没查到……`)
      }
      return true
    })

    // 2) 主人在 QQ 里发 /天气 城市
    api.command({
      name: '天气',
      aliases: ['weather', 'tq'],
      desc: '查天气：/天气 城市（不写城市就查默认城市）',
      async run(arg) {
        try {
          return await query(arg)
        } catch (e) {
          return `没查到：${e?.message || e}`
        }
      },
    })

    // 3) 给她一个工具，让她自己决定什么时候查
    api.tool(({ chat }) => {
      if (chat.kind === 'system') return []
      return api.defineTool({
        name: 'weather_now',
        description: '查某个城市现在的天气（实时，一行文字）。有人问天气、或者聊到出门 / 穿衣 / 下雨时用。不填城市就查主人设置的默认城市。',
        properties: { city: { type: 'string', description: '城市名，比如 北京、上海、Tokyo；不知道就留空' } },
        required: [],
        execute: async ({ city } = {}) => {
          try {
            const w = await query(city)
            return { ok: true, message: w }
          } catch (e) {
            return { ok: false, message: e?.message || String(e) }
          }
        },
      })
    })

    api.rule(() => `你会查天气：别人问天气、或者聊到出门穿衣下雨时，用 weather_now 工具查（不填城市就是默认城市 ${defaultCity()}），用自己的话告诉对方。`)

    return { query, defaultCity }
  },
}
