// QQ 里的主人命令：/silent /active 之类，直接在 QQ 上管她。只认主人；在总开关关着时也能用（所以 /on 才有用）。

import { dataDir, readJson, writeJson } from '../core/store.js'

/**
 * 解析命令：「/silent 30」→ { name: 'silent', arg: '30' }。不是命令返回 null。支持全角斜杠和中文别名。
 * extra：扩展模块加的命令 [{ name, aliases, desc, run }]，命中时返回 { name, arg, ext }；和内置同名时扩展的优先。
 */
export function parseCommand(text, extra = []) {
  const m = String(text || '').trim().match(/^[/／]\s*([A-Za-z0-9一-龥_-]+)\s*([\s\S]*)$/)
  if (!m) return null
  const word = m[1].toLowerCase()
  for (const c of extra) {
    const names = [c.name, ...(c.aliases || [])].map((x) => String(x).toLowerCase())
    if (names.includes(word)) return { name: c.name, arg: m[2].trim(), ext: c }
    // 中文命令后面直接跟内容：「/天气北京」
    const pre = names.filter((k) => /[一-龥]/.test(k) && word.startsWith(k)).sort((a, b) => b.length - a.length)[0]
    if (pre) return { name: c.name, arg: (m[1].slice(pre.length) + ' ' + m[2]).trim(), ext: c }
  }
  const name = ALIASES[word] || word
  if (COMMANDS[name]) return { name, arg: m[2].trim() }
  // 中文命令后面不加空格直接跟内容：「/记住我不吃香菜」
  const pre = Object.keys(ALIASES).filter((k) => /[一-龥]/.test(k) && word.startsWith(k)).sort((a, b) => b.length - a.length)[0]
  return pre ? { name: ALIASES[pre], arg: (m[1].slice(pre.length) + ' ' + m[2]).trim() } : null
}

const ALIASES = {
  闭嘴: 'silent', 安静: 'silent', 静音: 'silent', shutup: 'silent', mute: 'silent',
  说话: 'active', 醒醒: 'active', 解除静音: 'active', unmute: 'active',
  少说: 'quiet', 话少: 'quiet',
  多说: 'chatty', 话多: 'chatty',
  正常: 'normal',
  模型: 'model', 换模型: 'model',
  唱: 'sing', 点歌: 'sing', 翻唱: 'sing',
  状态: 'status', 心情: 'mood', 日记: 'diary', 记住: 'remember', 记一下: 'remember',
  重开: 'reset', 开机: 'on', 关机: 'off', 帮助: 'help', 命令: 'help', h: 'help',
}

const COMMANDS = {
  help: '看这份命令列表',
  silent: '在这里闭嘴（可带分钟数，如 /silent 30；不带就一直到 /active）',
  active: '解除闭嘴；在群里还会接着参与话题一会儿',
  quiet: '这个群里只在被叫到时说话，不插话',
  chatty: '这个群里话多一点，更爱插话',
  normal: '这个群恢复默认的插话频率',
  model: '看或换她用的模型：/model 看列表，/model 2 或 /model 名字 换，/model 默认 跟随 DSH',
  sing: '让她翻唱一首：/sing 小幸运 田馥甄；后面加 +12 / -3 之类可以变调（原唱是男声一般 +12）',
  status: '看她现在的状态',
  mood: '看她现在的心情',
  diary: '马上写一篇空间日记',
  remember: '让她记住一件事，如 /remember 我不吃香菜',
  reset: '这个聊天重新开始（旧的对话在 DSH 侧栏里还能找回）',
  on: '打开总开关',
  off: '关掉总开关（之后除了命令什么都不回）',
}

export const commandList = (extra = []) => [
  ...Object.entries(COMMANDS).map(([name, desc]) => ({ name, desc, aliases: Object.keys(ALIASES).filter((k) => ALIASES[k] === name && /[一-龥]/.test(k)) })),
  ...extra.map((c) => ({ name: c.name, desc: c.desc || '', aliases: c.aliases || [], module: c.module || '' })),
]

export function helpText(extra = []) {
  return '主人命令（也可以用中文，如 /闭嘴 /说话）：\n' + Object.entries(COMMANDS).map(([k, v]) => `/${k}  ${v}`).join('\n')
    + (extra.length ? '\n扩展模块加的：\n' + extra.map((c) => `/${c.name}  ${c.desc || ''}`).join('\n') : '')
}

/** 每个聊天的闭嘴状态：chatId → 到什么时候（毫秒，Infinity 写成 0 表示一直）。 */
export function createMutes() {
  const file = () => dataDir('mutes.json')
  const load = () => readJson(file(), {})
  return {
    muted(chatId, now = Date.now()) {
      const m = load()
      if (!(chatId in m)) return false
      if (m[chatId] === 0 || m[chatId] > now) return true
      delete m[chatId]
      writeJson(file(), m)
      return false
    },
    set(chatId, minutes) {
      const m = load()
      m[chatId] = minutes > 0 ? Date.now() + minutes * 60_000 : 0
      writeJson(file(), m)
    },
    clear(chatId) {
      const m = load()
      delete m[chatId]
      writeJson(file(), m)
    },
    until: (chatId) => load()[chatId],
  }
}

/**
 * 执行命令，返回要回给主人的话。
 * @param {object} deps { getConfig, setConfig, mutes, hub, mood, memory, qzone, onebot }
 */
export async function runCommand(cmd, msg, deps) {
  const { getConfig, setConfig, mutes, hub, mood, memory, qzone } = deps
  const cfg = getConfig()
  const inGroup = msg.kind === 'group'
  const here = inGroup ? '这个群' : '这里'
  const setGroup = (patch) => {
    const overrides = { ...(cfg.group.overrides || {}) }
    if (patch === null) delete overrides[msg.groupId]
    else overrides[msg.groupId] = { ...(overrides[msg.groupId] || {}), ...patch }
    setConfig({ ...cfg, group: { ...cfg.group, overrides } })
  }
  switch (cmd.name) {
    case 'help':
      return helpText(deps.extraCommands || [])
    case 'silent': {
      const min = Math.max(0, Math.min(7 * 24 * 60, Number.parseInt(cmd.arg, 10) || 0))
      mutes.set(msg.chatId, min)
      mood?.nudge?.(-6, '主人让她闭嘴') // 有点委屈
      if (inGroup) hub.leaveTopic?.(msg.groupId)
      return min ? `好，我在${here}安静 ${min} 分钟` : `好，我在${here}先不说话了，想我了发 /active`
    }
    case 'active':
      mutes.clear(msg.chatId)
      mood?.nudge?.(4, '主人让她回来说话')
      if (inGroup) hub.joinTopic?.(msg.groupId)
      return inGroup ? '我回来啦' : '在呢'
    case 'quiet':
      if (!inGroup) return '这个命令要在群里用'
      setGroup({ interjectChance: 0 })
      return '好，这个群里没人叫我我就不插话'
    case 'chatty':
      if (!inGroup) return '这个命令要在群里用'
      setGroup({ interjectChance: 0.4, minRelevance: 0.1 })
      return '好耶，那我在这个群多说两句'
    case 'normal':
      if (!inGroup) return '这个命令要在群里用'
      setGroup(null)
      return '好，按平常的样子来'
    case 'status': {
      const st = hub.stats()
      const mu = mutes.until(msg.chatId)
      const lines = [
        `总开关：${cfg.enabled ? '开' : '关'}${cfg.dryRun ? '（试运行，不真发）' : ''}`,
        ...(mood ? [`心情：${mood.label()}`] : []),
        `今天：收到 ${st.received} 条，发出 ${st.sent} 条`,
        `${here}：${mu === undefined ? '正常说话' : mu === 0 ? '闭嘴中' : '闭嘴到 ' + new Date(mu).toLocaleTimeString().slice(0, 5)}`,
      ]
      if (inGroup) {
        const o = (cfg.group.overrides || {})[msg.groupId] || {}
        lines.push(`插话：${o.interjectChance === 0 ? '不插话' : o.interjectChance >= 0.4 ? '话多' : '默认'}`)
      }
      return lines.join('\n')
    }
    case 'model': {
      const list = deps.listModels ? await deps.listModels() : []
      const cur = cfg.model.provider && cfg.model.model ? cfg.model : null
      const label = (m) => (m.name && m.name !== m.model ? `${m.name}（${m.model}）` : m.model)
      if (!cmd.arg) {
        const def = deps.defaultModel?.()
        const head = cur ? `现在用的：${cur.model}` : `现在跟随 DSH 默认${def ? '：' + def.model : ''}`
        if (!list.length) return head + '\n（拿不到模型列表）'
        return head + '\n' + list.slice(0, 20).map((m, i) => `${i + 1}. ${label(m)}${cur && m.provider === cur.provider && m.model === cur.model ? '  ← 当前' : ''}`).join('\n') + '\n发 /model 序号 换，/model 默认 跟随 DSH'
      }
      if (/^(默认|default|auto|跟随)$/i.test(cmd.arg)) {
        setConfig({ ...cfg, model: { ...cfg.model, provider: '', model: '' } })
        return '好，换回跟随 DSH 的默认模型，下一句起生效'
      }
      const n = Number.parseInt(cmd.arg, 10)
      const q = cmd.arg.toLowerCase()
      const hit = String(n) === cmd.arg ? list[n - 1]
        : list.find((m) => m.model.toLowerCase() === q || String(m.name).toLowerCase() === q) || list.find((m) => m.model.toLowerCase().includes(q) || String(m.name).toLowerCase().includes(q))
      if (!hit) return `没找到「${cmd.arg}」这个模型，发 /model 看列表`
      setConfig({ ...cfg, model: { ...cfg.model, provider: hit.provider, model: hit.model } })
      return `好，换成 ${label(hit)} 了，下一句起生效`
    }
    case 'sing': {
      if (!deps.song) return '翻唱功能不可用'
      // 末尾的 +12 / -3 是变调
      const m = cmd.arg.match(/^(.*?)\s+([+-]\d{1,2})$/)
      const name = (m ? m[1] : cmd.arg).trim()
      if (!name) return '唱哪首？比如 /sing 小幸运 田馥甄'
      return deps.song.request({ song: name, pitch: m ? Number(m[2]) : undefined, chatId: msg.chatId }).message
    }
    case 'mood':
      return mood ? `现在${mood.label()}` : '心情模块关着'
    case 'diary': {
      if (!qzone) return '空间日记没开'
      const r = await qzone.writeDiary()
      return r.ok ? (r.dryRun ? '写好了，不过现在是试运行，没真发' : '写好发出去啦，去空间看看') : '没写成：' + (r.message || '不知道为啥')
    }
    case 'remember': {
      if (!memory) return '记忆模块关着'
      if (!cmd.arg) return '要我记住什么呀？比如 /remember 我不吃香菜'
      const r = memory.add({ text: cmd.arg, aboutName: cfg.ownerName || '主人', about: cfg.ownerQQ, importance: 0.8, source: 'panel', chatId: msg.chatId })
      return r.ok ? '记住了' : '没记上：' + (r.message || '')
    }
    case 'reset':
      hub.resetChat(msg.chatId)
      return '好，我们重新开始'
    case 'on':
      setConfig({ ...cfg, enabled: true })
      return cfg.dryRun ? '总开关打开了（现在是试运行，我说的话只进日志）' : '我上线啦'
    case 'off':
      setConfig({ ...cfg, enabled: false })
      return '好，我先下线了。发 /on 叫我回来'
    default:
      return null
  }
}
