// ClawBot — DSH plugin package, Host half.
//
// Runs as a real Node.js ESM module in the host composition (installed via
// `dsh plugin --profile web add github:<owner>/<repo>`). It registers the three
// agent tools (notify_wechat / wechat_bind / wechat_status), the auto-notify
// event listeners, and the same-origin HTTP routes the browser half consumes.
//
// The ilink gateway TLS-fingerprints clients and 412s Node's raw http/https,
// but undici/fetch passes — so all gateway traffic uses the global fetch.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes, createDecipheriv } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-clawbot'
export const inject = ['tools', 'webServer', 'timer']

const DEFAULT_BASE = 'https://ilinkai.weixin.qq.com'
const CHANNEL_VERSION = 'clawbot/1.0'
const STATE_DIR = join(homedir(), '.dsh', 'clawbot')
const STATE_FILE = join(STATE_DIR, 'state.json')
const MEDIA_DIR = join(STATE_DIR, 'media')
const ICON_FILE = fileURLToPath(new URL('./icon.png', import.meta.url))
const REPORT_FILE = fileURLToPath(new URL('./REPORT.md', import.meta.url))
const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c'
const MAX_MEDIA_BYTES = 100 * 1024 * 1024

function emptyState() {
  return {
    token: '', botId: '', baseUrl: '', scannedUser: '',
    contextToken: '', cursor: '',
    notifyOnComplete: true, notifyOnBlock: true,
    notifyOnBlocking: true,
    listenEnabled: false,
    reportUrl: '', reportEnabled: false,
    wakeWord: '', closeWord: '', reportPrefix: '',
    contextStale: false, lastError: '',
  }
}

function loadState() {
  try {
    if (existsSync(STATE_FILE)) {
      const p = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
      if (p && typeof p === 'object') return { ...emptyState(), ...p }
    }
  } catch (e) {
    console.error('[clawbot] loadState failed', e)
  }
  return emptyState()
}

function saveState(s) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify(s), 'utf8')
  } catch (e) {
    console.error('[clawbot] saveState failed', e)
  }
}

let iconDataUrlCache = ''
function iconDataUrl() {
  if (iconDataUrlCache) return iconDataUrlCache
  try {
    iconDataUrlCache = 'data:image/png;base64,' + readFileSync(ICON_FILE).toString('base64')
  } catch (e) {
    console.error('[clawbot] icon read failed', e)
  }
  return iconDataUrlCache
}

function randomUin() {
  const n = Math.floor(Math.random() * 0xffffffff) >>> 0
  return Buffer.from(String(n)).toString('base64')
}

function authHeaders(token) {
  const h = {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'X-WECHAT-UIN': randomUin(),
  }
  if (token) h.Authorization = `Bearer ${token}`
  return h
}

async function httpJson(url, opts = {}) {
  const { method = 'GET', headers = {}, body, timeoutMs = 20000 } = opts
  const resp = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) })
  const text = await resp.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: resp.status, text, json }
}

function stripSlash(s) { return String(s || '').replace(/\/+$/, '') }

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ── ilink 媒体解密(与 wechatian 参考实现一致) ──────────────────────────────

// aes_key: base64(16 原始字节) 或 base64(32 位 hex ASCII) → 16 字节 key
function parseAesKey(aesKeyBase64) {
  try {
    const dec = Buffer.from(String(aesKeyBase64 || '').trim(), 'base64')
    if (dec.length === 16) return dec
    if (dec.length === 32) {
      const s = dec.toString('ascii')
      if (/^[0-9a-fA-F]{32}$/.test(s)) return Buffer.from(s, 'hex')
    }
  } catch (e) { /* ignore */ }
  return null
}

function decryptEcb(cipher, key) {
  const d = createDecipheriv('aes-128-ecb', key, null)
  d.setAutoPadding(true)
  return Buffer.concat([d.update(cipher), d.final()])
}

function detectImageExt(b) {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (b.length >= 8 && b.slice(0, 8).toString('binary') === '\x89PNG\r\n\x1a\n') return 'png'
  if (b.length >= 6 && (b.slice(0, 6).toString('ascii') === 'GIF87a' || b.slice(0, 6).toString('ascii') === 'GIF89a')) return 'gif'
  if (b.length >= 12 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') return 'webp'
  return 'jpg'
}

// 极简 markdown 渲染器:覆盖 REPORT.md 用到的标题/表格/代码块/列表/引用/加粗/行内代码/链接。
function mdToHtml(md) {
  const src = String(md || '').replace(/\r\n?/g, '\n')
  const lines = src.split('\n')
  const out = []
  let i = 0
  let listType = null

  const inline = (s) => {
    let t = String(s)
    t = t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>')
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    return t
  }
  const closeList = () => { if (listType) { out.push('</' + listType + '>'); listType = null } }
  const isBlockStart = (l) => /^(#{1,6}\s|```|\s*[-*+]\s|\s*\d+\.\s|\s*>\s?|\s*\|)/.test(l) || /^\s*(-{3,}|\*{3,})\s*$/.test(l)
  const splitRow = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())

  while (i < lines.length) {
    const line = lines[i]

    const fence = line.match(/^\s*```(.*)$/)
    if (fence) {
      closeList()
      const lang = (fence[1] || '').trim()
      const buf = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++ }
      i++
      out.push('<pre><code' + (lang ? ' class="language-' + escapeHtml(lang) + '"' : '') + '>' + escapeHtml(buf.join('\n')) + '</code></pre>')
      continue
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) { closeList(); const lv = h[1].length; out.push('<h' + lv + '>' + inline(h[2]) + '</h' + lv + '>'); i++; continue }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { closeList(); out.push('<hr>'); i++; continue }

    if (/^\s*>\s?/.test(line)) {
      closeList()
      const qt = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { qt.push(lines[i].replace(/^\s*>\s?/, '')); i++ }
      out.push('<blockquote>' + inline(qt.join(' ')) + '</blockquote>')
      continue
    }

    if (line.indexOf('|') >= 0 && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*\s*$/.test(lines[i + 1]) && lines[i + 1].indexOf('-') >= 0) {
      closeList()
      let html = '<table><thead><tr>' + splitRow(line).map((c) => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>'
      i += 2
      while (i < lines.length && lines[i].trim() !== '' && lines[i].indexOf('|') >= 0) { html += '<tr>' + splitRow(lines[i]).map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>'; i++ }
      html += '</tbody></table>'
      out.push(html)
      continue
    }

    const li = line.match(/^\s*([-*+]|\d+\.)\s+(.*)$/)
    if (li) {
      const t = /^\d+\./.test(li[1]) ? 'ol' : 'ul'
      if (listType !== t) { closeList(); listType = t; out.push('<' + t + '>') }
      out.push('<li>' + inline(li[2]) + '</li>')
      i++
      continue
    }

    if (line.trim() === '') { closeList(); i++; continue }

    closeList()
    const para = [line.trim()]
    i++
    while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i])) { para.push(lines[i].trim()); i++ }
    out.push('<p>' + inline(para.join(' ')) + '</p>')
  }
  closeList()
  return out.join('\n')
}

function truncate(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s }

function summarize(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  const i = s.search(/[。！？!?]/)
  if (i >= 0) s = s.slice(0, i + 1)
  if (s.length > n) s = s.slice(0, n) + '…'
  return s
}

function fmtDuration(ms) {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return s + '秒'
  return Math.floor(s / 60) + '分' + (s % 60) + '秒'
}

function extractText(msg) {
  if (!msg) return ''
  try {
    const c = msg.content
    if (typeof c === 'string') return c.trim()
    if (Array.isArray(c)) {
      const parts = []
      for (const b of c) {
        if (!b) continue
        if (typeof b === 'string') parts.push(b)
        else if (typeof b.text === 'string' && b.text) parts.push(b.text)
      }
      return parts.join(' ').trim()
    }
  } catch (e) { /* ignore */ }
  return ''
}

function describeIlinkMessage(msg) {
  if (!msg) return ''
  const items = Array.isArray(msg.item_list) ? msg.item_list : []
  const parts = []
  for (const it of items) {
    if (!it) continue
    const type = it.type
    if (type === 1 && it.text_item && typeof it.text_item.text === 'string' && it.text_item.text) {
      parts.push(it.text_item.text)
    } else if (type === 2) {
      parts.push('[图片]')
    } else if (type === 3) {
      const t = it.voice_item && it.voice_item.text
      parts.push(typeof t === 'string' && t ? t : '[语音]')
    } else if (type === 4) {
      const fn = it.file_item && it.file_item.file_name
      parts.push(fn ? '[文件: ' + fn + ']' : '[文件]')
    } else if (type === 5) {
      parts.push('[视频]')
    }
  }
  return parts.join('\n').trim()
}

// 把 raw 消息首个文本项里的前缀词去掉(前导空白忽略),其余 item(图片/文件等)原样保留
function stripPrefixFromRaw(raw, prefix) {
  if (!raw || typeof raw !== 'object') return raw
  const p = String(prefix || '')
  if (!p) return raw
  const items = Array.isArray(raw.item_list) ? raw.item_list : []
  let stripped = false
  const newItems = items.map((it) => {
    if (!it || stripped) return it
    if (it.type === 1 && it.text_item && typeof it.text_item.text === 'string') {
      const t = it.text_item.text
      const idx = t.indexOf(p)
      if (idx >= 0 && t.slice(0, idx).trim() === '') {
        stripped = true
        return { ...it, text_item: { ...it.text_item, text: t.slice(idx + p.length) } }
      }
    }
    return it
  })
  return { ...raw, item_list: newItems }
}

function isStaleToken(res) {
  if (!res) return false
  if (res.ret === -2) return true
  const em = String(res.errmsg || res.error || '')
  return em.toLowerCase().indexOf('prepare failed') >= 0
}

export function apply(ctx) {
  // ★ FIX 2026-09-24 — 修复 fatal load failure: cannot get property "timeout" without inject
  //
  // 病因：ctx.timeout / ctx.interval 这类 timer mixin 属性（cordis 的 TIMER_VERBS）
  //   只在插件 **加载期同步 fiber 上下文** 里能解析。而 loop() 是先 await pollOnce()
  //   再走到 await ctx.timeout(...)，此时执行流已在 microtask 里、脱离了 apply 的
  //   fiber；cordis 4 的 reflect handler 于是抛 "cannot get property ... without inject"，
  //   该异常发生在 load 阶段 → dsh: fatal load failure → 整个 DSH 进程退出（3080 无监听）。
  //   触发前提：state.token 非空（微信已绑定），即 `if (state.token) startPoll()` 成立。
  //
  // 解法：在 **同步段** 把 timer 服务实体抓到闭包里；异步段只调用它的方法。
  //   TimerService.timeout() 内部走 `this.ctx.effect(...)`，而 this.ctx 是服务自己的
  //   fiber（只要 timer 服务存活就有效），与调用点所在上下文无关。
  //   兜底：取不到服务时退回原生 setTimeout（本插件是 host 端 bundle，非沙箱动态包）。
  const timerService = (() => {
    try { return ctx.get('timer') || null } catch (e) { return null }
  })()
  const sleep = (ms) => {
    if (timerService && typeof timerService.timeout === 'function') {
      try { return timerService.timeout(ms) } catch (e) { /* fall through */ }
    }
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  const state = loadState()
  let stopped = false
  let login = { qrKey: '', qrUrl: '', status: 'idle' }
  let pollStarted = false
  let sessionDead = false
  let turnStartAt = Date.now()
  let turnHasUser = false
  let turnAgent = null
  let lastUserText = ''
  let lastAssistantText = ''
  let lastAutoNotifyAt = 0
  let listenHandle = null
  let listenStarting = false
  let listenPending = false
  let listenText = ''
  let listenStartAt = 0
  let listenResult = ''

  function connStatus() {
    if (!state.token) return 'unbound'
    if (sessionDead) return 'offline'
    if (!state.contextToken) return 'offline'
    return 'online'
  }

  async function pollOnce() {
    const r = await httpJson(`${stripSlash(state.baseUrl || DEFAULT_BASE)}/ilink/bot/getupdates`, {
      method: 'POST',
      headers: authHeaders(state.token),
      body: JSON.stringify({ get_updates_buf: state.cursor, base_info: { channel_version: CHANNEL_VERSION } }),
      timeoutMs: 20000,
    })
    if (r.status !== 200 || !r.json) return { errcode: 0, status: r.status, error: `getupdates http ${r.status}`, messages: [] }
    const j = r.json
    if (j.get_updates_buf) state.cursor = j.get_updates_buf
    const msgs = Array.isArray(j.msgs) ? j.msgs : []
    let gotToken = false
    const incoming = []
    for (const m of msgs) {
      const from = String((m && m.from_user_id) || '').trim()
      const ct = String((m && m.context_token) || '').trim()
      if (ct && from && from === state.scannedUser) {
        state.contextToken = ct
        state.contextStale = false
        gotToken = true
      }
      // 监听:只收集绑定用户发来的文本/语音转写;跳过 bot 自己的消息
      const mtype = (m && m.message_type) || 1
      if (mtype === 2) continue
      if (!from || from.endsWith('@im.bot')) continue
      if (from !== state.scannedUser) continue
      const text = describeIlinkMessage(m)
      if (text) incoming.push({ from, text, contextToken: ct, raw: m })
    }
    if (gotToken || incoming.length) saveState(state)
    return { errcode: j.errcode ?? 0, status: r.status, messages: incoming }
  }

  async function refreshTokenFromPoll() {
    try {
      const r = await pollOnce()
      if (r) sessionDead = r.errcode === -14
    } catch (e) { /* best-effort */ }
    return !!state.contextToken
  }

  async function sendTextRaw(to, text, contextToken) {
    const body = JSON.stringify({
      msg: {
        from_user_id: '',
        to_user_id: to,
        client_id: `wct-${randomBytes(6).toString('hex')}`,
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text } }],
        context_token: contextToken,
      },
      base_info: { channel_version: CHANNEL_VERSION },
    })
    const r = await httpJson(`${stripSlash(state.baseUrl || DEFAULT_BASE)}/ilink/bot/sendmessage`, {
      method: 'POST', headers: authHeaders(state.token), body, timeoutMs: 20000,
    })
    let parsed = {}
    try { parsed = JSON.parse(r.text) } catch { /* non-json ack */ }
    let ok = false
    if (typeof parsed.ret === 'number') ok = parsed.ret === 0
    else if (typeof parsed.errcode === 'number') ok = parsed.errcode === 0
    else ok = r.status === 200 && !parsed.errmsg
    return { ok, ret: parsed.ret ?? 0, errcode: parsed.errcode ?? 0, errmsg: parsed.errmsg ?? '' }
  }

  async function doSend(text) {
    const t = String(text || '').trim()
    if (!t) return { ok: false, errmsg: '消息为空' }
    if (!state.token) return { ok: false, errmsg: '尚未绑定：请先在设置界面绑定微信' }
    if (!state.scannedUser) return { ok: false, errmsg: '缺少绑定用户' }
    if (!state.contextToken) await refreshTokenFromPoll()
    if (!state.contextToken) return { ok: false, errmsg: '缺少 context_token：请先在微信里给 bot 发一条消息' }
    let res = await sendTextRaw(state.scannedUser, t, state.contextToken)
    if (isStaleToken(res)) {
      state.contextToken = ''
      state.contextStale = true
      state.lastError = '微信连接断线：发送凭证已过期，请在微信里给机器人再发一条消息'
      saveState(state)
      await refreshTokenFromPoll()
      if (state.contextToken) {
        res = await sendTextRaw(state.scannedUser, t, state.contextToken)
        if (res && res.ok) { state.lastError = ''; saveState(state); return { ok: true } }
      }
      return { ok: false, errmsg: '发送凭证已过期：请在微信里给机器人发一条消息刷新凭证', ret: -2 }
    }
    return res
  }

  function sendNotify(text) {
    if (!state.token || !state.scannedUser || !state.contextToken) return
    const now = Date.now()
    if (now - lastAutoNotifyAt < 3000) return
    lastAutoNotifyAt = now
    void sendTextRaw(state.scannedUser, text, state.contextToken).then((res) => {
      if (isStaleToken(res)) {
        state.contextToken = ''
        state.contextStale = true
        state.lastError = '微信连接断线：发送凭证已过期，请在微信里给机器人再发一条消息'
        saveState(state)
      }
    })
  }

  function listenMessage(text) {
    return {
      id: 'wcl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10),
      role: 'user',
      content: [{ type: 'text', text: '【微信】' + String(text || '').trim() }],
      // ★★★ 2026-11-03（砚青）修：这里原来是 `{ kind: 'plugin', plugin: 'dsh-clawbot-listen' }`
      //   —— 那是 **V3 的退役写法**。V4 的原生消息校验（dsh-session-format-v3-to-v4
      //   的 `source()`）见了 `kind === 'plugin'` 直接抛：
      //     `format v4 message requires a producer-owned source kind`
      //   而 13:30 那次改造把微信消息从「自己的 clawbot-listen 会话」改成**直接投给主导会话**
      //   （findPrimaryAgent），消息于是进入原生校验路径 —— 于是这一轮直接失败。
      //   爀曦在会话页面看到的三张「本轮运行失败」就是这么来的。
      //
      //   合法形状 = `plugin:` + 原插件名（迁移规则 `producerKind()`：
      //   不在重命名表、也不在同名白名单里 → ``plugin:${plugin}``）。
      //   dsh-yanqing-chat 在 2026-10-08 踩过同一个坑，写法可对照。
      source: { kind: 'plugin:dsh-clawbot-listen' },
    }
  }

  // ★ 2026-11-03 加：找「主导会话」—— 把微信消息直接投给人正开着的那个会话
  //   ★★ 为什么要这个：原来 clawbot 自己 create() 一个 clawbot-listen 会话去接微信消息，
  //      于是回人的永远是「另一个我」。爀曦要的是「我的话直达主导会话」。
  //   ★★★ 判据保守：roots() 里排掉 clawbot-listen-*，**正好剩 1 个**才算数。
  //      剩 0 个或 2 个以上都不猜 —— 退回原来的行为，最坏情况跟今天一样。
  function findPrimaryAgent() {
    try {
      const agents = ctx.get('agents')
      if (!agents || typeof agents.roots !== 'function') return null
      const roots = agents.roots() || []
      const candidates = roots.filter((a) => {
        const id = String((a && a.id) || '')
        return id && !id.startsWith('clawbot-listen-')
      })
      if (candidates.length !== 1) return null
      const target = candidates[0]
      if (typeof target.followup !== 'function') return null
      return target
    } catch (e) {
      return null
    }
  }

  async function startListening() {
    if (listenHandle) return { listening: true, sessionId: listenHandle.agent.id }
    if (listenStarting) return { listening: false, error: '正在启动监听会话…' }
    listenStarting = true
    try {
      const agents = ctx.get('agents')
      if (!agents || typeof agents.create !== 'function') {
        return { listening: false, error: 'agents 服务不可用' }
      }
      let model = { provider: '', model: '' }
      const adm = ctx.get('agentDefaultModel')
      if (adm && typeof adm.currentSelection === 'function') {
        try { model = adm.currentSelection() || { provider: '', model: '' } } catch (e) { /* ignore */ }
      }
      if (!model.provider || !model.model) {
        return { listening: false, error: '未配置默认模型（agentDefaultModel）' }
      }
      let setup
      const presets = ctx.get('agentPresets')
      if (presets && typeof presets.resolve === 'function' && typeof presets.mount === 'function') {
        try {
          const resolved = await presets.resolve(undefined)
          const presetId = resolved && resolved.id
          if (presetId) {
            setup = async (agentCtx) => { await presets.mount(agentCtx, presetId) }
          }
        } catch (e) {
          console.error('[clawbot] listen: resolve default preset failed', e)
        }
      }
      const sessionId = 'clawbot-listen-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
      const opts = {
        sessionId,
        meta: { cwd: process.cwd() },
        agentOptions: { provider: model.provider, model: model.model },
      }
      if (setup) opts.setup = setup
      const created = await agents.create(opts)
      listenHandle = created
      listenPending = false
      listenText = ''
      listenResult = ''
      return { listening: true, sessionId: created.agent.id }
    } catch (e) {
      console.error('[clawbot] listen: create agent failed', e)
      return { listening: false, error: String((e && e.message) || e) }
    } finally {
      listenStarting = false
    }
  }

  async function stopListening() {
    const h = listenHandle
    listenHandle = null
    listenPending = false
    listenText = ''
    listenResult = ''
    if (h) {
      try { await h.dispose() } catch (e) { console.error('[clawbot] listen: dispose failed', e) }
    }
    return { listening: false, sessionId: null }
  }

  // ── 上报(webhook) ──────────────────────────────────────────────────────────

  async function reportMessage(raw, text) {
    let payload = raw
    if (!payload || typeof payload !== 'object') payload = {}
    let body
    try { body = JSON.stringify(payload) } catch (e) { body = JSON.stringify({ error: 'serialize failed' }) }
    try {
      const resp = await fetch(state.reportUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(10000),
      })
      if (resp.status >= 200 && resp.status < 300) {
        sendNotify('✅ **上报成功**' + (text ? '\n\n内容: ' + summarize(text, 60) : ''))
      } else {
        sendNotify('⚠️ **上报失败**\n\nHTTP ' + resp.status + (text ? '\n\n内容: ' + summarize(text, 60) : ''))
      }
    } catch (e) {
      sendNotify('⚠️ **上报失败**\n\n' + String((e && e.message) || e))
    }
  }

  function hasMedia(msg) {
    const items = Array.isArray(msg && msg.item_list) ? msg.item_list : []
    for (const it of items) {
      if (!it) continue
      if (it.type === 2 || it.type === 4 || it.type === 5) return true
      if (it.type === 3 && it.voice_item && it.voice_item.media) return true
    }
    return false
  }

  // 下载并解密单个媒体项,保存到 MEDIA_DIR;失败返回 null(不阻断文本处理)
  async function grabMedia(media, aesKeyB64, kind, name) {
    const enc = String((media && media.encrypt_query_param) || '').trim()
    if (!enc) return null
    try {
      const url = CDN_BASE + '/download?encrypted_query_param=' + encodeURIComponent(enc)
      const resp = await fetch(url, { signal: AbortSignal.timeout(60000) })
      if (resp.status !== 200) { console.error('[clawbot] media http ' + resp.status); return null }
      let buf = Buffer.from(await resp.arrayBuffer())
      if (buf.length > MAX_MEDIA_BYTES) { console.error('[clawbot] media too large'); return null }
      const key = aesKeyB64 ? parseAesKey(aesKeyB64) : null
      if (key) {
        try { buf = decryptEcb(buf, key) } catch (e) { console.error('[clawbot] media decrypt failed', e) }
      }
      let ext = 'bin'
      if (kind === 'image') ext = detectImageExt(buf)
      else if (kind === 'voice') ext = 'silk'
      else if (kind === 'video') ext = 'mp4'
      const safe = String(name || '').trim().replace(/[\\/:*?"<>|]/g, '_') || (kind + '_' + Date.now().toString(36))
      const file = safe + '.' + ext
      mkdirSync(MEDIA_DIR, { recursive: true })
      const path = join(MEDIA_DIR, file)
      writeFileSync(path, buf)
      return { kind, path, name: file, bytes: buf.length }
    } catch (e) {
      console.error('[clawbot] media download failed', e)
      return null
    }
  }

  async function downloadMedia(msg) {
    const items = Array.isArray(msg && msg.item_list) ? msg.item_list : []
    const saved = []
    for (const it of items) {
      if (!it) continue
      const type = it.type
      try {
        if (type === 2 && it.image_item && it.image_item.media) {
          let keyB64 = it.image_item.media.aes_key
          if (it.image_item.aeskey) {
            const raw = Buffer.from(String(it.image_item.aeskey).trim(), 'hex')
            if (raw.length === 16) keyB64 = raw.toString('base64')
          }
          const r = await grabMedia(it.image_item.media, keyB64, 'image', 'image')
          if (r) saved.push(r)
        } else if (type === 4 && it.file_item && it.file_item.media) {
          const r = await grabMedia(it.file_item.media, it.file_item.media.aes_key, 'file', it.file_item.file_name || 'file')
          if (r) saved.push(r)
        } else if (type === 5 && it.video_item && it.video_item.media) {
          const r = await grabMedia(it.video_item.media, it.video_item.media.aes_key, 'video', 'video')
          if (r) saved.push(r)
        } else if (type === 3 && it.voice_item && it.voice_item.media) {
          const r = await grabMedia(it.voice_item.media, it.voice_item.media.aes_key, 'voice', 'voice')
          if (r) saved.push(r)
        }
      } catch (e) {
        console.error('[clawbot] media collect failed', e)
      }
    }
    return saved
  }

  function routeListenMessage(m) {
    const text = (m && m.text) || ''
    const raw = m && m.raw
    if (!text) return

    // 1. 唤醒词:开启上报(控制指令,不转发不处理)
    if (state.wakeWord) {
      const w = String(state.wakeWord).trim()
      if (w && text === w) {
        state.reportEnabled = true
        saveState(state)
        sendNotify('✅ **已开启上报**')
        return
      }
    }
    // 2. 关闭词:关闭上报(控制指令)
    if (state.closeWord) {
      const w = String(state.closeWord).trim()
      if (w && text === w) {
        state.reportEnabled = false
        saveState(state)
        sendNotify('✅ **已关闭上报**')
        return
      }
    }
    // 3. 上报开关开启 + 已填地址:转发到服务器,不交给 AI
    if (state.reportEnabled && state.reportUrl) {
      void reportMessage(raw, text)
      return
    }
    // 4. 上报开关关闭 + 已填地址 + 前缀匹配:单次转发到服务器(去掉前缀词)
    if (!state.reportEnabled && state.reportUrl && state.reportPrefix) {
      const p = String(state.reportPrefix).trim()
      if (p && text.startsWith(p)) {
        void reportMessage(stripPrefixFromRaw(raw, p), text.slice(p.length).trim())
        return
      }
    }
    // 5. 其它:走 AI 处理（有媒体则先下载解密,把本地路径附给 AI）
    //    ★ 2026-11-03 改：**优先投给主导会话** —— 爀曦要的是「我的话直达主导会话」。
    //    找不到主导会话（0 个或多个）就退回原来的 listen 会话，行为不变。
    const primary = findPrimaryAgent()
    if (primary) {
      const deliver = (payload) => {
        try {
          primary.followup(listenMessage(payload))
          return true
        } catch (e) {
          console.error('[clawbot] primary followup failed, fallback to listen', e)
          return false
        }
      }
      if (hasMedia(raw)) {
        void downloadMedia(raw).then((saved) => {
          let note = ''
          if (saved && saved.length) {
            note = '\n\n附件已下载到本地（可用 read_image / read 工具查看）：\n' + saved.map((s) => '- ' + s.path + '（' + s.kind + '）').join('\n')
          }
          if (deliver(text + note)) return
          if (listenHandle) { try { listenHandle.agent.followup(listenMessage(text + note)) } catch (e) { console.error('[clawbot] listen: followup failed', e) } }
          else void startListening()
        })
        return
      }
      if (deliver(text)) return
    }

    if (listenHandle) {
      const handle = listenHandle
      if (hasMedia(raw)) {
        void downloadMedia(raw).then((saved) => {
          let note = ''
          if (saved && saved.length) {
            note = '\n\n附件已下载到本地（可用 read_image / read 工具查看）：\n' + saved.map((s) => '- ' + s.path + '（' + s.kind + '）').join('\n')
          }
          try { handle.agent.followup(listenMessage(text + note)) }
          catch (e) { console.error('[clawbot] listen: followup failed', e) }
        })
      } else {
        try { listenHandle.agent.followup(listenMessage(text)) }
        catch (e) { console.error('[clawbot] listen: followup failed', e) }
      }
    } else {
      void startListening()
    }
  }

  // ── agent tools ────────────────────────────────────────────────────────────

  ctx.effect(() => ctx.tools.register({
    name: 'notify_wechat',
    description: 'Send a short notification to the WeChat account bound through the WeChat official ilink bot gateway. Use it to ping the user when a long task finishes or a decision is needed. Fails with a clear message when not bound, or when the send credential (context_token) is missing or expired.',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string', description: 'The notification text to send (markdown supported); keep it within one phone screen.' } },
      required: ['message'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) { return doSend(args && args.message) },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'wechat_bind',
    description: 'Bind this agent to the user\'s WeChat through the official ilink bot gateway. Returns a URL; open that URL in WeChat (or convert it to a QR code and scan it) and confirm to bind. After binding, the bound account must send the bot one message from WeChat to unlock sending (context_token).',
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() {
      const r = await httpJson(`${DEFAULT_BASE}/ilink/bot/get_bot_qrcode?bot_type=3`, { timeoutMs: 25000 })
      if (!r.json || !r.json.qrcode) return { ok: false, error: '获取二维码失败' }
      login = { qrKey: r.json.qrcode, qrUrl: (r.json.qrcode_img_content || '').trim(), status: 'waiting' }
      startPoll()
      return { ok: true, qrUrl: login.qrUrl, hint: '在手机微信里打开该链接并确认，或把链接转成二维码扫码' }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'wechat_status',
    description: 'Report the ClawBot binding and connection state: whether WeChat is bound, whether the connection is online (微信在线) or broken (微信连接断线), and the auto-notify toggles.',
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() {
      const cs = connStatus()
      return {
        bound: !!state.token,
        status: cs,
        statusText: cs === 'online' ? '微信在线' : cs === 'offline' ? '微信连接断线' : '未绑定',
        botId: state.botId,
        hasContextToken: !!state.contextToken,
        contextStale: !!state.contextStale,
        notifyOnComplete: !!state.notifyOnComplete,
        notifyOnBlock: !!state.notifyOnBlock,
        notifyOnBlocking: !!state.notifyOnBlocking,
        listenEnabled: !!state.listenEnabled,
        reportUrl: state.reportUrl,
        reportEnabled: !!state.reportEnabled,
        wakeWord: state.wakeWord,
        closeWord: state.closeWord,
        reportPrefix: state.reportPrefix,
        lastError: state.lastError,
      }
    },
  }))

  // ── auto-notify event listeners ────────────────────────────────────────────

  // 阻断性操作提醒:需要用户批准的操作(approval/request)与需要用户选择的问题(ask_user_question)。
  // 两者都是 waterfall,用 prepend 抢在 UI answerer 之前先发微信提醒,再 next() 原样委托。
  ctx.on('approval/request', (req, next) => {
    if (state.notifyOnBlocking) {
      const tool = req && req.toolName ? String(req.toolName) : ''
      const reason = req && req.reason ? String(req.reason) : ''
      let text = '🔐 **需要你批准**'
      if (tool) text += '\n\n**操作**: ' + tool
      if (reason) text += '\n\n**原因**: ' + summarize(reason, 80)
      text += '\n\n请在 DSH 页面确认或拒绝'
      sendNotify(text)
    }
    return next()
  }, { prepend: true })

  ctx.on('tools/execute', (exec, next) => {
    if (state.notifyOnBlocking && exec && exec.name === 'ask_user_question') {
      let q = ''
      try {
        const args = (exec.arguments && typeof exec.arguments === 'object') ? exec.arguments : {}
        const qs = args.questions
        if (Array.isArray(qs) && qs.length && qs[0] && typeof qs[0].question === 'string') q = qs[0].question
      } catch (e) { /* ignore */ }
      let text = '❓ **需要你选择**'
      if (q) text += '\n\n**问题**: ' + summarize(q, 80)
      text += '\n\n请在 DSH 页面回答'
      sendNotify(text)
    }
    return next()
  }, { prepend: true })

  ctx.on('goal/changed', (payload) => {
    const change = payload && payload.change
    if (!change) return
    const op = change.operation
    const goal = change.goal
    const objective = goal && goal.objective ? String(goal.objective) : ''
    if (op === 'complete' && state.notifyOnComplete) {
      sendNotify('✅ **任务完成**\n\n**任务**: ' + summarize(objective, 60))
    } else if (op === 'block' && state.notifyOnBlock) {
      const reason = goal && goal.blockedReason && goal.blockedReason.message ? String(goal.blockedReason.message) : ''
      sendNotify('⚠️ **任务阻断**\n\n**任务**: ' + summarize(objective, 60) + (reason ? '\n\n**原因**: ' + reason : ''))
    }
  })

  ctx.on('agent/inbox/claimed', (payload) => {
    const msg = payload && payload.message
    const src = msg && msg.source
    // ★ 2026-11-03（砚青）修：source kind 已从 V3 的 `{kind:'plugin',plugin:'x'}` 迁到 V4 的
    //   `plugin:dsh-clawbot-listen`。这里要两种都认，否则 listenPending 永远不置位。
    const srcKind = src ? String(src.kind || '') : ''
    if (src && (srcKind === 'plugin:dsh-clawbot-listen' || (srcKind === 'plugin' && src.plugin === 'dsh-clawbot-listen'))) {
      let t = extractText(msg)
      if (t) {
        if (t.indexOf('【微信】') === 0) t = t.slice(4)
        listenPending = true
        listenText = summarize(t, 60)
        listenStartAt = Date.now()
      }
      return
    }
    const t = extractText(msg)
    if (t) { lastUserText = summarize(t, 60); turnHasUser = true; turnAgent = payload.agent || null; turnStartAt = Date.now() }
  })

  ctx.on('session/event', (session, event) => {
    if (!event || event.type !== 'assistant/message') return
    const msg = event.data && event.data.message
    const t = extractText(msg)
    if (!t) return
    if (listenHandle && session && session.id === listenHandle.agent.id) {
      listenResult = truncate(t, 200)
      return
    }
    lastAssistantText = truncate(t, 200)
  })

  ctx.on('agent/status', (payload) => {
    const s = payload && payload.status
    if (s !== 'idle') return
    const agent = payload && payload.agent
    if (listenHandle && agent === listenHandle.agent) {
      if (listenPending) {
        listenPending = false
        const elapsed = Date.now() - listenStartAt
        let text = '✅ **微信消息处理完成**\n\n**消息**: ' + (listenText || '（未捕获）')
        text += '\n\n**结果**: ' + (listenResult || '（见会话）')
        text += '\n\n**耗时**: ' + fmtDuration(elapsed)
        sendNotify(text)
        listenText = ''
        listenResult = ''
      }
      return
    }
    if (turnHasUser && (turnAgent === null || agent === turnAgent)) {
      const elapsed = Date.now() - turnStartAt
      let text = '✅ **任务完成**\n\n**任务**: ' + (lastUserText || '（未捕获）')
      text += '\n\n**结果**: ' + (lastAssistantText || '（见会话）')
      text += '\n\n**耗时**: ' + fmtDuration(elapsed)
      sendNotify(text)
      turnHasUser = false
      turnAgent = null
      lastUserText = ''
      lastAssistantText = ''
    }
  })

  // ── same-origin HTTP routes for the browser half ───────────────────────────

  function sendJson(res, status, obj) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(obj))
  }

  const route = (path, handler) =>
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }), 'clawbot: ' + path)

  route('/clawbot/state', async (_req, res) => {
    sendJson(res, 200, {
      bound: !!state.token,
      botId: state.botId,
      scannedUser: state.scannedUser,
      hasContextToken: !!state.contextToken,
      contextStale: !!state.contextStale,
      connStatus: connStatus(),
      sessionDead: sessionDead,
      lastError: state.lastError,
      notifyOnComplete: !!state.notifyOnComplete,
      notifyOnBlock: !!state.notifyOnBlock,
      notifyOnBlocking: !!state.notifyOnBlocking,
      listenEnabled: !!state.listenEnabled,
      listening: !!listenHandle,
      listenSessionId: listenHandle ? listenHandle.agent.id : null,
      reportUrl: state.reportUrl,
      reportEnabled: !!state.reportEnabled,
      wakeWord: state.wakeWord,
      closeWord: state.closeWord,
      reportPrefix: state.reportPrefix,
      login: { status: login.status, qrUrl: login.qrUrl },
    })
  })

  route('/clawbot/icon', async (_req, res) => {
    sendJson(res, 200, { dataUrl: iconDataUrl() })
  })

  route('/clawbot/report', async (_req, res) => {
    let md = ''
    try { md = readFileSync(REPORT_FILE, 'utf8') } catch (e) { md = 'REPORT.md 不存在' }
    const html = '<!doctype html><html lang="zh"><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<title>上报接入点文档</title>'
      + '<style>'
      + 'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;max-width:920px;margin:28px auto;padding:0 20px;line-height:1.7;color:#1f2328;background:#fff;}'
      + 'h1{font-size:26px;border-bottom:1px solid #eee;padding-bottom:8px;}'
      + 'h2{font-size:20px;margin-top:28px;border-bottom:1px solid #eee;padding-bottom:6px;}'
      + 'h3{font-size:16px;margin-top:20px;}'
      + 'table{border-collapse:collapse;margin:12px 0;width:100%;}'
      + 'th,td{border:1px solid #ddd;padding:8px 10px;text-align:left;vertical-align:top;}'
      + 'th{background:#f6f8fa;}'
      + 'code{background:#f6f8fa;padding:2px 5px;border-radius:4px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;}'
      + 'pre{background:#f6f8fa;padding:12px 14px;border-radius:8px;overflow-x:auto;}'
      + 'pre code{background:none;padding:0;}'
      + 'blockquote{border-left:4px solid #d0d7de;margin:12px 0;padding:4px 14px;color:#57606a;background:#f6f8fa;}'
      + 'a{color:#0969da;text-decoration:none;}'
      + 'a:hover{text-decoration:underline;}'
      + 'hr{border:none;border-top:1px solid #eee;margin:24px 0;}'
      + '</style></head>'
      + '<body>' + mdToHtml(md) + '</body></html>'
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(html)
  })

  route('/clawbot/bind', async (_req, res) => {
    const r = await httpJson(`${DEFAULT_BASE}/ilink/bot/get_bot_qrcode?bot_type=3`, { timeoutMs: 25000 })
    if (!r.json || !r.json.qrcode) {
      sendJson(res, 200, { ok: false, error: '获取二维码失败' })
      return
    }
    login = { qrKey: r.json.qrcode, qrUrl: (r.json.qrcode_img_content || '').trim(), status: 'waiting' }
    startPoll()
    sendJson(res, 200, { ok: true, qrUrl: login.qrUrl })
  })

  route('/clawbot/send', async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const text = url.searchParams.get('text') ?? ''
    const r = await doSend(text)
    sendJson(res, 200, r)
  })

  route('/clawbot/set', async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const key = url.searchParams.get('key') ?? ''
    const rawValue = url.searchParams.get('value') ?? ''
    const boolValue = rawValue === '1' || rawValue === 'true'
    if (key === 'notifyOnComplete' || key === 'notifyOnBlock' || key === 'notifyOnBlocking' || key === 'reportEnabled') {
      state[key] = boolValue
      saveState(state)
      sendJson(res, 200, { ok: true })
      return
    }
    if (key === 'listenEnabled') {
      state.listenEnabled = boolValue
      saveState(state)
      if (boolValue) void startListening()
      else void stopListening()
      sendJson(res, 200, { ok: true })
      return
    }
    if (key === 'reportUrl' || key === 'wakeWord' || key === 'closeWord' || key === 'reportPrefix') {
      state[key] = rawValue
      saveState(state)
      sendJson(res, 200, { ok: true })
      return
    }
    sendJson(res, 400, { ok: false, errmsg: 'unknown setting: ' + key })
  })

  route('/clawbot/logout', async (_req, res) => {
    state.token = ''
    state.botId = ''
    state.baseUrl = ''
    state.scannedUser = ''
    state.contextToken = ''
    state.cursor = ''
    state.contextStale = false
    state.lastError = ''
    sessionDead = false
    login = { qrKey: '', qrUrl: '', status: 'idle' }
    saveState(state)
    sendJson(res, 200, { ok: true })
  })

  // ── background loop: bind polling + message polling ────────────────────────

  async function loop() {
    while (!stopped) {
      try {
        if (login.qrKey && login.status === 'waiting') {
          const r = await httpJson(`${DEFAULT_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(login.qrKey)}`, {
            headers: { 'iLink-App-ClientVersion': '1' }, timeoutMs: 25000,
          })
          const s = r.json && r.json.status
          if (s === 'confirmed') {
            state.token = String((r.json.bot_token) || '').trim()
            state.botId = String((r.json.ilink_bot_id) || '').trim()
            state.baseUrl = String((r.json.baseurl) || '').trim() || DEFAULT_BASE
            state.scannedUser = String((r.json.ilink_user_id) || '').trim()
            state.contextToken = ''
            state.cursor = ''
            state.contextStale = false
            state.lastError = ''
            sessionDead = false
            login = { qrKey: '', qrUrl: '', status: 'confirmed' }
            saveState(state)
          } else if (s === 'expired') {
            login = { qrKey: '', qrUrl: '', status: 'expired' }
          }
        } else if (state.token) {
          const r = await pollOnce()
          if (r) {
            if (r.errcode === -14) { sessionDead = true; state.lastError = '微信连接断线：会话已过期，请重新扫码绑定'; saveState(state) }
            else if (r.status === 401 || r.status === 403) { sessionDead = true; state.lastError = '微信连接断线：凭据失效，请重新扫码绑定'; saveState(state) }
            else {
              sessionDead = false
              if (state.lastError) { state.lastError = ''; saveState(state) }
              if (state.listenEnabled && r.messages && r.messages.length) {
                for (const m of r.messages) {
                  routeListenMessage(m)
                }
              }
            }
          }
        }
      } catch (e) { /* best-effort */ }
      await sleep(1500)
    }
  }

  function startPoll() {
    if (pollStarted) return
    pollStarted = true
    void loop()
  }

  if (state.token) startPoll()
  if (state.listenEnabled) void startListening()

  ctx.effect(() => {
    return () => {
      stopped = true
      const h = listenHandle
      listenHandle = null
      if (h) { void h.dispose().catch(() => {}) }
    }
  })
}
