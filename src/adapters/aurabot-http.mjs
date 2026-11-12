// adapters · aurabot 状态的口（③ 面板的数据源）
// ============================================================================
// ★★ 这个文件的第一条纪律：**脱敏**。
//   aurabot 的 config.json 里有 snowluma.httpToken / wsToken / imageGen.apiKey ——
//   那是凭据。这个口只回**白名单字段**，其余一律不出。
//
//   ★ 判据不是「把 token 字段删掉」，而是「只给白名单里的键」——
//     因为以后 aurabot 加了新字段，黑名单会漏，白名单不会。
//
// ★ 只读。改配置是另一件事（要校验、要备份、要防半截写），不塞在这里。
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'

// ★ 路径来自实际环境（aurabot 是 DSH 插件，配置在 plugins-data 下）
export const AURABOT_DIR = 'D:/AI/dsh/home/plugins-data/aurabot'

// 白名单：只有这些键会出现在 /api/aurabot 的返回里
const WHITELIST = [
  'enabled', 'dryRun', 'setupDone', 'botQQ', 'ownerQQ', 'ownerName', 'ownerLevel',
  'longTasks', 'gateway', 'workspaceDir',
]

let reads = 0
let failures = 0

export const AURABOT_STATUS_PORT = Object.freeze({
  id: 'aurabot-status-core',
  v: 1,
  routes: ['GET /api/aurabot'],
  writes: 0,
  capabilities: { receive: false, send: false, sendRoutes: [], apiCalls: [] },
})

export function aurabotView () {
  return { port: AURABOT_STATUS_PORT.id, v: AURABOT_STATUS_PORT.v, reads, failures }
}

/** 数一个目录里的文件数（不存在返回 0，不抛） */
function countFiles (dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).length } catch { return 0 }
}

/** 只挑白名单里的键 */
function pickWhitelisted (cfg) {
  const out = {}
  for (const k of WHITELIST) {
    if (Object.prototype.hasOwnProperty.call(cfg, k)) out[k] = cfg[k]
  }
  return out
}

/**
 * 拼 /api/aurabot 的 payload。
 * ★ 只读 + 脱敏 + 坏配置不抛（回 error 字段，让页面显示得出来）。
 */
export function aurabotStatus (opts = {}) {
  const dir = opts.dir || AURABOT_DIR
  const cfgFile = path.join(dir, 'config.json')
  const out = {
    ok: true,
    dir,
    configExists: false,
    config: null,
    counts: { stickers: 0, personas: 0 },
    error: null,
  }
  try {
    if (fs.existsSync(cfgFile)) {
      out.configExists = true
      const raw = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
      out.config = pickWhitelisted(raw)
      // ★ 脱敏后的形状：只给「有没有配」不给值
      // ★ 键名也别带 token / key 字样 —— 值虽然是布尔，但一个叫 xxxTokens 的键
      //   会让人（和自动扫描）第一眼以为那里装着凭据。**看得懂和看着像，是两件事。**
      out.configured = {
        snowluma: Boolean(raw && raw.snowluma && (raw.snowluma.httpToken || raw.snowluma.wsToken)),
        imageGen: Boolean(raw && raw.imageGen && raw.imageGen.apiKey),
      }
    }
    out.counts.stickers = countFiles(path.join(dir, 'stickers'))
    try { out.counts.personas = fs.readdirSync(path.join(dir, 'personas')).length } catch { out.counts.personas = 0 }
    // ★★ 2026-11-12：补仪表盘要的几样（照 aurabot 真实面板的结构）。
    //   从「只有身份和开关」扩成「她现在什么样 + 有多少会话 + 心情」。
    //   ★ 每个文件独立包死：某一个坏了不该让整页变空（今天踩过一次：引号写错 → 整页白屏）。
    const safeJson = (n) => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) } catch { return null }
    }
    const mood = safeJson('mood.json')
    if (mood && Number.isFinite(Number(mood.value))) {
      out.mood = {
        value: Number(mood.value),
        at: Number(mood.at) || null,
        reason: String(mood.reason || '').slice(0, 80),
        historyLen: Array.isArray(mood.history) ? mood.history.length : 0,
      }
    }
    const sess = safeJson('sessions.json')
    const chats = (sess && sess.chats) || {}
    const chatKeys = Object.keys(chats)
    out.chats = {
      count: chatKeys.length,
      items: chatKeys.slice(0, 12).map((k) => ({
        key: k,
        title: String((chats[k] && chats[k].title) || k).slice(0, 40),
        preset: String((chats[k] && chats[k].preset) || '').slice(0, 40),
      })),
    }
    const diary = safeJson('diary.json')
    if (diary) {
      const arr = Array.isArray(diary) ? diary : (Array.isArray(diary.entries) ? diary.entries : null)
      out.diary = { count: arr ? arr.length : null }
    }
    out.counts.voiceCache = countFiles(path.join(dir, 'voice-cache'))
    try { out.counts.chatlog = fs.readdirSync(path.join(dir, 'chatlog')).length } catch { out.counts.chatlog = 0 }
  } catch (e) {
    failures++
    out.ok = false
    out.error = String((e && e.message) || e).slice(0, 200)
  }
  reads++
  return out
}

/** 处理 GET /api/aurabot。命中返回 true。 */
export function handleAurabotStatus (req, res, opts = {}) {
  let p = ''
  try { p = new URL(req.url, 'http://x').pathname } catch { return false }
  if (p !== '/api/aurabot') return false

  const reply = (code, obj) => {
    const body = JSON.stringify(obj)
    try {
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        Connection: 'close',
      })
      res.end(body)
    } catch { /* 回包失败不影响已算出的结果 */ }
  }

  if (req.method !== 'GET') { reply(405, { ok: false, error: '只接受 GET' }); return true }
  reply(200, aurabotStatus(opts))
  return true
}