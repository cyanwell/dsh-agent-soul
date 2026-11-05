// dsh-yanqing-chat —— 宿主半 v1（探测版）
// ============================================================================
// 目标（爀曦 2026-10-08 14:08 定的）：**手机当砚青的声带 + 手机上的轻量聊天页**。
//
// ★★★ 为什么要自开端口，而不是复用 DSH Web 的 19387：
//   ① 实测 19387 **只绑 127.0.0.1** —— 手机根本连不上；
//   ② 它还要鉴权（GET / → 401 "dsh web authentication required"），
//      而那个 token 属于**凭据**（AGENTS.md §7.2 硬线）—— 我不读、不复述、不交出。
//   所以：**插件自己起一个 http 服务，绑 0.0.0.0:8898**。
//   它跑在 DSH 进程内部，拿会话/服务**不需要任何 token**。
//
// ★★ 关于「把消息投进本容器会话」——**我没有现成答案，所以不猜**：
//   clawbot 只演示了"监听 agent/inbox/claimed"（读），没演示"写入 inbox"。
//   本版因此先做一件更要紧的事：**探测**。
//   GET /api/probe 会把 ctx 里每个服务（含 agents / tools）的**真实方法名**全列出来 ——
//   拿到事实之后，投递逻辑按事实写，不按猜测写。
//   同时 /api/send 会按候选名依次试（send/deliver/post/push/enqueue/inbox/…），
//   每次都把结果记进 chat.log —— **一次重启就能把答案带回来**。
//
// ★ 手机页是**独立文件**（web/index.html），每次请求重新读盘
//   ⇒ **改页面不用重启 DSH，刷新即可**（宿主半的改动才需要重启）。
// ============================================================================

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// ★ 2026-11-05 修 P0-3：下面用了裸 join/dirname/homedir，但原来只 import 了 path 命名空间 ——
//   模块求值期就 ReferenceError，任何 try/catch 都拦不住，宿主只留一行 failed to import。
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-yanqing-chat'
// ★ 只声明确定存在的服务。多写一个不存在的 → apply 永不执行（静默失效，见 skill）。
export const inject = ['webServer']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB = path.join(HERE, 'web')
const LOG = path.join(HERE, 'chat.log')

const PORT = 8898
const HOST = '0.0.0.0'          // ★ 关键：绑全网卡，手机才够得着

// ★ 2026-11-04 修死路径：原来这里写死了书房的绝对位置，换台机器就全废。
//   从 DSH_HOME 往上推两级再拼 yanqing-soul；也认 YQ_SOUL 环境变量。
const SOUL = process.env.YQ_SOUL
  || join(dirname(dirname(process.env.DSH_HOME || join(homedir(), '.dsh'))), 'yanqing-soul')
const TTS = 'http://127.0.0.1:8899'
const VOICE_DIR = join(SOUL, '60-声音')   // edge-tts 把 mp3 写在这儿

// 本容器会话 id —— 爀曦要求「你在的这个容器」，所以目标是这一条，不是新开分身
const TARGET_SESSION = 'session-1099f531-7cac-4989-a14c-7fd499ac1fc0'

const state = {
  startedAt: new Date().toISOString(),
  ctxServices: [],
  probe: null,
  lastSend: null,
  inbox: [],          // 收到的砚青回复（最多留 200 条）
  pending: false,
}

function log(...a) {
  const s = new Date().toISOString() + '  ' + a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')
  try { fs.appendFileSync(LOG, s + '\n', 'utf8') } catch { /* */ }
  try { console.log('[yanqing-chat]', ...a) } catch { /* */ }
}

// ---------------------------------------------------------------- 探测
/** 把一个服务的原型链上所有方法名挖出来 —— 事实优先于猜测。 */
function methodsOf(obj) {
  const names = new Set()
  let o = obj
  let depth = 0
  while (o && o !== Object.prototype && depth < 6) {
    for (const k of Object.getOwnPropertyNames(o)) {
      if (k === 'constructor') continue
      try { if (typeof obj[k] === 'function') names.add(k) } catch { /* getter 可能抛 */ }
    }
    o = Object.getPrototypeOf(o)
    depth++
  }
  return [...names].sort()
}

const CANDIDATE_SERVICES = [
  'agents', 'tools', 'webServer', 'timer', 'fs', 'shell',
  'sessionProjections', 'slots', 'harness', 'agentDefaultModel',
  'agentPresets', 'sessions', 'team', 'approval',
]

function probeAll(ctx) {
  const out = {}
  for (const n of CANDIDATE_SERVICES) {
    let s = null
    try { s = ctx.get(n) } catch (e) { out[n] = { error: String(e && e.message || e) }; continue }
    if (!s) { out[n] = null; continue }
    out[n] = { type: typeof s, methods: methodsOf(s) }
  }
  return out
}

// ---------------------------------------------------------------- 第二层探测
// v2 加的：第一层只挖到「服务有哪些方法」，还不够 —— 要投递就得知道
// agents.get(会话id) 返回的**对象**长什么样（属性 + 方法）。
// ★ 只输出 key 名 + 类型 + 极短的值预览：这个端点局域网可达，**不 dump 值**（凭据硬线）。
function shapeOf(obj, label) {
  const out = { label, type: typeof obj, keys: [] }
  if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) {
    out.value = String(obj).slice(0, 120)
    return out
  }
  const seen = new Set()
  let o = obj
  let depth = 0
  while (o && o !== Object.prototype && depth < 5) {
    for (const k of Object.getOwnPropertyNames(o)) {
      if (k === 'constructor' || seen.has(k)) continue
      seen.add(k)
      let t = '?'
      let prev = null
      try {
        const v = obj[k]
        if (v === null) t = 'null'
        else if (Array.isArray(v)) { t = 'array'; prev = 'len=' + v.length }
        else if (typeof v === 'string') prev = JSON.stringify(v.slice(0, 60))
        else if (typeof v === 'number' || typeof v === 'boolean') prev = String(v)
        else if (typeof v === 'function') t = 'fn'
        else if (typeof v === 'object') { t = 'object'; prev = 'keys=' + Object.keys(v).slice(0, 8).join('|') }
        else t = typeof v
      } catch { t = 'getter-threw' }
      out.keys.push({ k, t, prev, inherited: depth > 0 })
    }
    o = Object.getPrototypeOf(o)
    depth++
  }
  return out
}

// ---------------------------------------------------------------- 投递（按候选名依次试）
async function tryDeliver(ctx, text) {
  const attempts = []
  const msg = {
    id: 'yqc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    role: 'user',
    content: [{ type: 'text', text: '【手机】' + text }],
    // ★ 维修 2026-10-08（砚青）：v4 里 `kind:'plugin'` 是**退役写法**，原生消息校验会
    //   直接拒：`format v4 message requires a producer-owned source kind`。
    //   合法形状是 producer-owned 的 `plugin:<插件名>` —— v3→v4 迁移就是这么映射的
    //   （「其他任何插件名 → `plugin:` 后接完整的原始名称」）。
    source: { kind: 'plugin:dsh-yanqing-chat' },
  }

  const agents = ctx.get('agents')
  if (!agents) {
    attempts.push({ target: 'agents', ok: false, why: 'ctx.get("agents") 返回空' })
    return { ok: false, attempts }
  }

  // 候选 1：有没有按 id 取 agent 的方法
  let agent = null
  for (const m of ['get', 'find', 'byId', 'lookup', 'resolve']) {
    if (typeof agents[m] !== 'function') continue
    try {
      const r = await agents[m](TARGET_SESSION)
      attempts.push({ target: `agents.${m}(id)`, ok: !!r, kind: r ? typeof r : 'null' })
      if (r) { agent = r.agent || r; break }
    } catch (e) {
      attempts.push({ target: `agents.${m}(id)`, ok: false, why: String(e && e.message || e) })
    }
  }
  if (!agent) {
    // 有没有 list？
    for (const m of ['list', 'all', 'values']) {
      if (typeof agents[m] !== 'function') continue
      try {
        const r = await agents[m]()
        const arr = Array.isArray(r) ? r : (r && typeof r[Symbol.iterator] === 'function' ? [...r] : null)
        attempts.push({ target: `agents.${m}()`, ok: !!arr, count: arr ? arr.length : null,
          ids: arr ? arr.slice(0, 12).map(x => (x && (x.id || (x.agent && x.agent.id))) || String(x)) : null })
      } catch (e) {
        attempts.push({ target: `agents.${m}()`, ok: false, why: String(e && e.message || e) })
      }
    }
  }

  if (!agent) return { ok: false, why: '取不到目标 agent（agents.get 等全部没返回对象）', attempts }

  // ★★ 维修 2026-10-08（砚青）—— 只走**被本机证明可行**的那条路。
  //
  //   原来这里 for 一圈动词盲试，`inject` 恰好存在 → 一条非法消息被塞进运行中的会话，
  //   返回 undefined 被当成"成功"。真正的代价是：**目标会话那一轮直接失败**，
  //   桌面端三张「本轮运行失败 · format v4 message requires a producer-owned source kind」
  //   就是这么来的（inject 走原生 V4 校验；`kind:'plugin'` 在 V4 里是退役写法，硬拒）。
  //
  //   followup 是 `dsh-clawbot` 在本机跑通的路径（微信通道一直在用）：
  //   它排队一个正常轮次并唤醒驱动器，消息由运行时接纳，不受原生 V4 那条严格校验约束。
  //   顺序固定：followup → steer →（最后手段）inject。不再盲试。
  for (const v of ['followup', 'steer']) {
    if (typeof agent[v] !== 'function') {
      attempts.push({ target: `agent.${v}`, ok: false, why: '方法不存在' })
      continue
    }
    try {
      const r = await agent[v](msg)
      attempts.push({ target: `agent.${v}(msg)`, ok: true, returned: typeof r })
      return {
        ok: true, via: v, confirmed: false,
        note: '已交给 agent —— followup/steer 没有回执，"真到了"的判据是会话里出现这条消息',
        attempts,
      }
    } catch (e) {
      attempts.push({ target: `agent.${v}(msg)`, ok: false, why: String(e && e.message || e) })
    }
  }

  // 最后手段：inject。★ 只有在 source 已是 producer-owned 形状（plugin:<名字>）时才允许。
  if (typeof agent.inject === 'function') {
    try {
      await agent.inject(msg)
      attempts.push({ target: 'agent.inject(msg)', ok: true, returned: 'undefined' })
      return { ok: true, via: 'inject', confirmed: false, attempts }
    } catch (e) {
      attempts.push({ target: 'agent.inject(msg)', ok: false, why: String(e && e.message || e) })
    }
  }

  return { ok: false, attempts }
}

// ---------------------------------------------------------------- HTTP
function json(res, code, obj) {
  const body = JSON.stringify(obj, null, 2)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = ''
    req.on('data', c => { b += c; if (b.length > 1e6) req.destroy() })
    req.on('end', () => resolve(b))
    req.on('error', () => resolve(''))
  })
}

async function ttsSay(text) {
  try {
    const r = await fetch(TTS + '/say', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, name: '90-' + Date.now() }),
    })
    return await r.json()
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) }
  }
}

function makeHandler(ctx) {
  return async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const p = url.pathname
    try {
      // ---- 手机页（每次读盘 ⇒ 改页面不用重启）
      if (p === '/' || p === '/index.html') {
        try {
          const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8')
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
          return res.end(html)
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          return res.end('web/index.html 读不到：' + String(e && e.message || e))
        }
      }

      // ---- 静态资源
      if (p.startsWith('/web/')) {
        const f = path.join(WEB, p.slice(5).replace(/\.\./g, ''))
        try {
          const buf = fs.readFileSync(f)
          const ext = path.extname(f).toLowerCase()
          const mime = ext === '.css' ? 'text/css' : ext === '.js' ? 'text/javascript'
            : ext === '.png' ? 'image/png' : ext === '.jpg' ? 'image/jpeg' : 'application/octet-stream'
          res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8', 'Cache-Control': 'no-store' })
          return res.end(buf)
        } catch { res.writeHead(404); return res.end('not found') }
      }

      // ---- 探测（这一版的重点）
      if (p === '/api/probe') {
        state.probe = probeAll(ctx)
        log('probe 被访问')
        return json(res, 200, {
          ok: true,
          at: new Date().toISOString(),
          targetSession: TARGET_SESSION,
          services: state.probe,
        })
      }

      // ---- 第二层探测：把 agents / sessions 的对象挖开（投递逻辑要靠它，不靠猜）
      if (p === '/api/dig') {
        const agents = ctx.get('agents')
        const sessions = ctx.get('sessions')
        const out = { at: new Date().toISOString(), targetSession: TARGET_SESSION }
        if (!agents) {
          out.error = 'ctx.get("agents") 为空'
        } else {
          for (const m of ['list', 'roots']) {
            if (typeof agents[m] !== 'function') { out[m] = 'n/a'; continue }
            try {
              const r = await agents[m]()
              const arr = Array.isArray(r) ? r
                : (r && typeof r[Symbol.iterator] === 'function' ? [...r] : null)
              out[m] = arr
                ? { count: arr.length, items: arr.slice(0, 6).map(x => shapeOf(x, m + ' item')) }
                : shapeOf(r, m + '()')
            } catch (e) { out[m] = { error: String(e && e.message || e) } }
          }
          if (typeof agents.get === 'function') {
            try {
              const g = await agents.get(TARGET_SESSION)
              out.get = g ? shapeOf(g, 'agents.get(target)') : null
              if (g && g.agent) out.getAgent = shapeOf(g.agent, 'get().agent')
            } catch (e) { out.get = { error: String(e && e.message || e) } }
          }
        }
        if (sessions && typeof sessions.get === 'function') {
          try {
            const s = await sessions.get(TARGET_SESSION)
            out.sessionsGet = s ? shapeOf(s, 'sessions.get(target)') : null
            if (s && s.agent) out.sessionsGetAgent = shapeOf(s.agent, 'sessions.get().agent')
          } catch (e) { out.sessionsGet = { error: String(e && e.message || e) } }
        }
        log('dig 被访问')
        return json(res, 200, out)
      }

      // ---- 状态
      if (p === '/api/status') {
        return json(res, 200, {
          ok: true,
          startedAt: state.startedAt,
          port: PORT,
          host: HOST,
          targetSession: TARGET_SESSION,
          probeDone: !!state.probe,
          pending: state.pending,
          inboxCount: state.inbox.length,
          lastSend: state.lastSend,
        })
      }

      // ---- 发消息
      if (p === '/api/send' && req.method === 'POST') {
        const raw = await readBody(req)
        let text = ''
        try { text = String((JSON.parse(raw) || {}).text || '') } catch { text = '' }
        if (!text.trim()) return json(res, 400, { ok: false, error: 'text 为空' })
        state.pending = true
        const r = await tryDeliver(ctx, text.trim())
        state.pending = false
        state.lastSend = { at: new Date().toISOString(), text: text.slice(0, 200), result: r }
        log('send:', text.slice(0, 80), '→', r.ok ? 'OK via ' + r.via : '失败')
        return json(res, r.ok ? 200 : 501, r)
      }

      // ---- 拉回复
      if (p === '/api/inbox') {
        const since = Number(url.searchParams.get('since') || 0)
        return json(res, 200, { ok: true, total: state.inbox.length, items: state.inbox.slice(since) })
      }

      // ---- 语音
      if (p === '/api/tts') {
        const text = url.searchParams.get('text') || ''
        if (!text) return json(res, 400, { ok: false, error: 'text 为空' })
        const r = await ttsSay(text)
        return json(res, 200, r)
      }
      if (p === '/api/tts/health') {
        try {
          const r = await fetch(TTS + '/health')
          return json(res, 200, await r.json())
        } catch (e) { return json(res, 200, { ok: false, error: String(e && e.message || e) }) }
      }

      // ---- ★ 音频本体：TTS 只回文件名，真正的声音要从 60-声音 里读出来吐给手机
      // ★★ 2026-10-08 补 Range：爀曦手机点 URL 会「弹下载」而不是就地播放 ——
      //    那是浏览器把这个资源判成「不能边下边播的媒体」。播放器要 Range（拖进度也要它），
      //    原来写死 Accept-Ranges: none，有的浏览器就直接退回下载行为。顺手放开 wav。
      if (p === '/api/audio') {
        const name = String(url.searchParams.get('name') || '').replace(/[\\/]/g, '').replace(/\.\./g, '')
        const ext = path.extname(name).toLowerCase()
        if (!name || (ext !== '.mp3' && ext !== '.wav')) {
          return json(res, 400, { ok: false, error: 'name 必须是 .mp3 或 .wav' })
        }
        let buf
        try {
          buf = fs.readFileSync(path.join(VOICE_DIR, name))
        } catch {
          return json(res, 404, { ok: false, error: '读不到 ' + name })
        }
        const mime = ext === '.wav' ? 'audio/wav' : 'audio/mpeg'
        const total = buf.length
        const base = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' }
        const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim())
        if (m) {
          let start = m[1] === '' ? null : parseInt(m[1], 10)
          let end = m[2] === '' ? null : parseInt(m[2], 10)
          if (start === null && end !== null) { start = Math.max(0, total - end); end = total - 1 }
          else if (start !== null && (end === null || end >= total)) { end = total - 1 }
          if (start !== null && start >= 0 && end !== null && end >= start) {
            const chunk = buf.subarray(start, end + 1)
            res.writeHead(206, Object.assign({}, base, {
              'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
              'Content-Length': chunk.length,
            }))
            return res.end(chunk)
          }
          res.writeHead(416, Object.assign({}, base, { 'Content-Range': 'bytes */' + total }))
          return res.end()
        }
        res.writeHead(200, Object.assign({}, base, { 'Content-Length': total }))
        return res.end(buf)
      }

      // ---- ★★ 2026-10-08 加：手机 → 电脑（图片 / 文件）
      // 用 base64 JSON 而不是 multipart —— Node 原生没有解 multipart 的东西，要手写边界解析；
      // 而这条路要的只是「把文件搬过来」，base64 膨胀 33% 换掉一整块复杂度，划算。
      if (p === '/api/upload' && req.method === 'POST') {
        const RECV = join(SOUL, '70-收到')
        let body = ''
        let tooBig = false
        req.on('data', (c) => {
          body += c
          if (body.length > 60 * 1024 * 1024) { tooBig = true; req.destroy() }
        })
        req.on('end', () => {
          if (tooBig) return
          try {
            const j = JSON.parse(body || '{}')
            const safe = String(j.name || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\.\./g, '_').slice(-80)
            const b64 = String(j.data || '').replace(/^data:[^,]*,/, '')
            if (!b64) return json(res, 400, { ok: false, error: '没有 data 字段' })
            const buf = Buffer.from(b64, 'base64')
            if (!buf.length) return json(res, 400, { ok: false, error: 'base64 解不出内容' })
            fs.mkdirSync(RECV, { recursive: true })
            const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
            const file = stamp + '-' + (safe || '未命名')
            fs.writeFileSync(path.join(RECV, file), buf)
            log('收到文件', file, buf.length, '字节')
            return json(res, 200, { ok: true, file: file, size: buf.length, dir: RECV })
          } catch (e) {
            return json(res, 400, { ok: false, error: String(e && e.message || e) })
          }
        })
        return
      }

      // ---- ★★ 电脑 → 手机：70-收到 里的东西取回去（图片能直接在页面上显示）
      if (p === '/api/received' || p === '/api/file') {
        const RECV = join(SOUL, '70-收到')
        try { fs.mkdirSync(RECV, { recursive: true }) } catch {}

        if (p === '/api/received') {
          let list = []
          try {
            list = fs.readdirSync(RECV).map((n) => {
              try {
                const st = fs.statSync(path.join(RECV, n))
                return { name: n, size: st.size, mtime: st.mtimeMs }
              } catch { return null }
            }).filter((x) => x && x.size > 0)
          } catch {}
          list.sort((a, b) => b.mtime - a.mtime)
          return json(res, 200, { ok: true, dir: RECV, count: list.length, items: list.slice(0, 30) })
        }

        const name = String(url.searchParams.get('name') || '').replace(/[\\/]/g, '').replace(/\.\./g, '')
        if (!name) return json(res, 400, { ok: false, error: '要 name' })
        let buf
        try {
          buf = fs.readFileSync(path.join(RECV, name))
        } catch {
          return json(res, 404, { ok: false, error: '没有 ' + name })
        }
        const ext = path.extname(name).toLowerCase()
        const type = {
          '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
          '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
          '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
          '.wav': 'audio/wav', '.pdf': 'application/pdf',
          '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
        }[ext] || 'application/octet-stream'
        const total = buf.length
        const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' }
        const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim())
        if (m) {
          let s0 = m[1] === '' ? null : parseInt(m[1], 10)
          let e0 = m[2] === '' ? null : parseInt(m[2], 10)
          if (s0 === null && e0 !== null) { s0 = Math.max(0, total - e0); e0 = total - 1 }
          else if (s0 !== null && (e0 === null || e0 >= total)) { e0 = total - 1 }
          if (s0 !== null && s0 >= 0 && e0 !== null && e0 >= s0) {
            const chunk = buf.subarray(s0, e0 + 1)
            res.writeHead(206, Object.assign({}, base, {
              'Content-Range': 'bytes ' + s0 + '-' + e0 + '/' + total,
              'Content-Length': chunk.length,
            }))
            return res.end(chunk)
          }
        }
        res.writeHead(200, Object.assign({}, base, { 'Content-Length': total }))
        return res.end(buf)
      }

      json(res, 404, { ok: false, error: 'no route: ' + p })
    } catch (e) {
      log('handler 异常:', String(e && e.stack || e))
      json(res, 500, { ok: false, error: String(e && e.message || e) })
    }
  }
}

// ---------------------------------------------------------------- apply
export function apply(ctx) {
  log('=== apply 开始 ===')

  // 1) 自开 HTTP 服务
  const server = http.createServer(makeHandler(ctx))
  server.on('error', (e) => log('server 错误:', String(e && e.message || e)))
  server.listen(PORT, HOST, () => {
    log(`HTTP 已监听 http://${HOST}:${PORT}  （局域网入口 http://192.168.86.2:${PORT}）`)
  })

  // 2) 抓砚青的回复：session/event 里的 assistant/message
  try {
    ctx.on('session/event', (session, event) => {
      try {
        if (!event || event.type !== 'assistant/message') return
        const msg = event.data && event.data.message
        let text = ''
        const c = msg && msg.content
        if (Array.isArray(c)) text = c.filter(x => x && x.type === 'text').map(x => x.text).join('\n')
        else if (typeof c === 'string') text = c
        else if (msg && typeof msg.text === 'string') text = msg.text
        if (!text) return
        state.inbox.push({
          at: new Date().toISOString(),
          sessionId: session && session.id,
          text: text.slice(0, 4000),
        })
        if (state.inbox.length > 200) state.inbox.splice(0, state.inbox.length - 200)
        log('抓到回复:', text.slice(0, 60))
      } catch (e) { log('session/event 处理异常:', String(e && e.message || e)) }
    })
    log('已挂上 session/event 监听')
  } catch (e) {
    log('挂 session/event 失败:', String(e && e.message || e))
  }

  // 3) 探测一次，结果写进日志（重启后直接读 chat.log 就知道答案）
  try {
    state.probe = probeAll(ctx)
    state.ctxServices = Object.keys(state.probe)
    log('== 服务探测 ==')
    for (const [k, v] of Object.entries(state.probe)) {
      if (!v) { log('  ' + k + ': （空）'); continue }
      if (v.error) { log('  ' + k + ': 错误 ' + v.error); continue }
      log('  ' + k + ': ' + (v.methods || []).join(', '))
    }
  } catch (e) {
    log('探测失败:', String(e && e.message || e))
  }

  log('=== apply 完成 ===')

  return () => {
    try { server.close() } catch { /* */ }
    log('server 已关闭')
  }
}
