// dsh-yanqing-voice —— 宿主半（Host half）· v0.2
//
// 两件事：
//   ① /yanqing-voice 路由：把 60-声音\ 下的音频暴露给浏览器（v0.1 已有）
//   ② 自动朗读：监听本会话的 assistant 流，按句送本地 TTS，音频由 TTS 落盘供前端播放
//
// ★ 为什么第②件事必须放在宿主半：
//   合成如果挂在模型身上，每轮都要多一次工具调用 —— 吃掉上下文，而且慢。
//   宿主半监听到文本、自己投递、自己收尾，**模型侧零成本**。这就是豆包那套的形状。
//
// ★ 为什么不在这里写音频文件：
//   `fs` 服务的契约里只有 writeText / editText，**没有写二进制的方法**。
//   而 TTS 服务本来就要产出音频，所以让它直接落到 60-声音\ —— 宿主半只传文本和文件名。
//
// ★ 前端怎么知道"有新的了"：
//   靠文件名变化轮询。自动朗读的文件统一用 90-<HHMMSSmmm> 前缀，
//   字符串序天然排在音色样本（10-32）之前，前端取列表第一项就是最新一条。

export const name = 'dsh-yanqing-voice'

// webServer 是硬依赖：没有它就注册不了路由。
// fs 走 ctx.get 而不是 inject —— 软取 + 判空，缺了也不该让整个插件卡在 waiting。
export const inject = ['webServer']

const DIR = 'D:\\AI\\yanqing-soul\\60-声音'
const AUDIO = /\.(mp3|wav)$/i

// 本地 TTS 服务（CosyVoice2）。接口约定：
//   POST /say  { text, name, ref }  ->  { ok, file, ms }
//   TTS 自己把音频写到 DIR\<name>.wav
const TTS_URL = 'http://127.0.0.1:8899/say'

// 零样本克隆的参考音频（爀曦 2026-09-26 选定的声线：晓伊 +30Hz）
const REF_VOICE = '21-晓伊-升30.mp3'

const AUTO_PREFIX = '90-'

// 当前页面正在看哪条会话 —— 由客户端半通过 /yanqing-voice/_focus 上报。
// 只有这条会话的回复会被念出来；不然 QQ 会话、子会话的声音会一起冒出来。
let focusSessionId = null

// 逐会话的未成句尾巴
const tails = new Map()

// 串行投递链 —— TTS 是 GPU 活儿，并发几句会互相拖慢，也会让播放顺序乱掉
let chain = Promise.resolve()

const pad = (n, w) => String(n).padStart(w || 2, '0')

function stampName() {
  const d = new Date()
  return AUTO_PREFIX + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + pad(d.getMilliseconds(), 3)
}

// 按句末标点切分。返回能立刻送出去的整句，和还不完整的尾巴。
const ENDERS = '。！？!?；;…\n'
function takeSentences(buf) {
  const done = []
  let start = 0
  for (let i = 0; i < buf.length; i++) {
    if (ENDERS.indexOf(buf[i]) >= 0) {
      const s = buf.slice(start, i + 1).trim()
      if (s) done.push(s)
      start = i + 1
    }
  }
  return { done, rest: buf.slice(start) }
}

async function say(text, sid) {
  // 投递前再确认一次：聚焦会话可能已经换了，旧句子不该再出声
  if (!focusSessionId || focusSessionId !== sid) return null
  const name = stampName()
  const res = await fetch(TTS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, name, ref: REF_VOICE }),
  })
  if (!res.ok) throw new Error('TTS HTTP ' + res.status)
  return res.json()
}

function enqueue(text, sid) {
  if (!text || text.trim().length < 2) return
  chain = chain.then(() => say(text, sid)).catch(() => { /* 一句失败不该拖垮后面的 */ })
}

export function apply(ctx) {
  const webServer = ctx.webServer

  // 文件名倒序 = 新的在前。fs.listDir 只保证 name 稳定序，没有 mtime 字段。
  const listNames = async function () {
    const fs = ctx.get('fs')
    if (fs === undefined) return []
    const dir = await fs.resolve(DIR)
    const entries = await fs.listDir(dir)
    const names = []
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      if (e && e.type === 'file' && AUDIO.test(e.name)) names.push(e.name)
    }
    names.sort(function (a, b) { return a < b ? 1 : (a > b ? -1 : 0) })
    return names
  }

  const json = function (res, code, obj) {
    const body = JSON.stringify(obj)
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(body)),
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  const text = function (res, code, s) {
    res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(s)
  }

  // ---------- ① 音频与列表路由 ----------
  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: '/yanqing-voice',
    handler: async function (req, res) {
      try {
        const fs = ctx.get('fs')
        if (fs === undefined) { text(res, 500, 'fs unavailable'); return }

        const raw = String(req.url || '/')
        const qi = raw.indexOf('?')
        const pathOnly = qi >= 0 ? raw.slice(0, qi) : raw
        const query = qi >= 0 ? raw.slice(qi + 1) : ''
        const asked = decodeURIComponent(pathOnly.replace(/^\/yanqing-voice\/?/, ''))

        // 列表
        if (asked === '_list') {
          json(res, 200, { items: await listNames() })
          return
        }

        // 客户端上报"我在看哪条会话" —— 自动朗读只念这一条
        if (asked === '_focus') {
          const m = /(?:^|&)sid=([^&]*)/.exec(query)
          const sid = m ? decodeURIComponent(m[1]) : ''
          focusSessionId = sid || null
          json(res, 200, { ok: true, focus: focusSessionId })
          return
        }

        // 目录穿越与非音频一律拒掉
        if (asked.indexOf('..') >= 0 || (asked !== '' && !AUDIO.test(asked))) {
          text(res, 400, 'bad name')
          return
        }

        let use = asked
        if (use === '') {
          const names = await listNames()
          use = names.length > 0 ? names[0] : ''
        }
        if (use === '') { text(res, 404, 'empty'); return }

        const target = await fs.resolve(DIR + '\\' + use)
        const bytes = await fs.readBytes(target, undefined, 16 * 1024 * 1024)
        res.writeHead(200, {
          'content-type': /\.wav$/i.test(use) ? 'audio/wav' : 'audio/mpeg',
          'content-length': String(bytes.length),
          'cache-control': 'no-store',
        })
        res.end(bytes)
      } catch (e) {
        try { text(res, 404, 'not found') } catch (e2) { /* 响应已发 */ }
      }
    },
  }), 'yanqing-voice: /yanqing-voice')

  // ---------- ② 自动朗读：监听 assistant 流 ----------
  ctx.on('agent/assistant-stream', function (payload) {
    try {
      if (!payload || !payload.agent || !payload.frame) return
      const sid = String(payload.agent.id)
      if (!focusSessionId || sid !== focusSessionId) return

      const frame = payload.frame
      if (frame.type === 'chunk') {
        const c = frame.chunk
        // ★ 只取正文。reasoning-delta 是思考过程，念出来就完蛋了。
        if (!c || c.type !== 'text-delta') return
        const buf = (tails.get(sid) || '') + (c.text || '')
        const r = takeSentences(buf)
        tails.set(sid, r.rest)
        for (let i = 0; i < r.done.length; i++) enqueue(r.done[i], sid)
      } else if (frame.type === 'end') {
        const rest = (tails.get(sid) || '').trim()
        tails.set(sid, '')
        if (rest) enqueue(rest, sid)
      }
    } catch (e) {
      // 朗读是附加功能，任何异常都不该影响会话主流程
    }
  })
}
