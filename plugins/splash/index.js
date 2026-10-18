// dsh-agent-splash · 宿主半
//
// 干什么：给「启动动画」设置页提供读写通道 ——
//   ① 读写配置   <你的工作区>/dsh/home/splash.json（主进程的启动画面注入代码启动时读它）
//   ② 列出可选的动画文件（某个目录里的视频/图片）
//   ③ 预览：把本地动画文件代理给浏览器（file:// 页面不能直接读别的本地文件）
//
// ★★★ 三条来自别处的教训，这里都照做了（都不是理论，是踩出来的）：
//   1. **CORS 头必须写。** 桌面端设置页的 origin 是 file:// 或 app://，
//      从那种页面 fetch http://127.0.0.1:19387 属于跨域 —— 缺这几个头就是 `Failed to fetch`，
//      而界面只会显示「载入中」，一个错都不吐。（dsh-agent-riji 和另一个插件各踩过一次）
//   2. **`export const inject = ['webServer']` 必须写**，否则 apply 永不执行。
//   3. 配置读写**永远不让异常冒出去** —— 读失败给默认值，写失败给出人能看懂的话。
//
// 路由（全部挂在 /agent-splash 前缀下）：
//   GET  /agent-splash/api/config          读配置
//   POST /agent-splash/api/config          写配置（body 是完整 JSON）
//   GET  /agent-splash/api/files           列出候选动画文件
//   GET  /agent-splash/api/preview?p=...   预览（代理本地文件，带 Range 支持以便视频拖动）
//   GET  /agent-splash/api/health          自检（路由活着吗）

import { readFileSync, writeFileSync, existsSync, statSync, createReadStream, readdirSync } from 'node:fs'
import { join, extname, resolve, sep } from 'node:path'

export const name = 'dsh-agent-splash'
// webServer 是硬依赖（没有它就注册不了路由）
export const inject = ['webServer']

const CFG_PATH = '<你的工作区>/dsh/home/splash.json'
const HOME_DIR = '<你的工作区>/dsh/home'

// 允许的动画扩展名 —— 不在里面的明确拒绝，不静默
const VIDEO_EXT = ['.mp4', '.webm', '.mov', '.m4v']
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif']
const ALL_EXT = VIDEO_EXT.concat(IMAGE_EXT)

// 允许预览/列出的根目录（文件代理只在这几个目录里找，避免变成任意文件读取）
const ALLOW_DIRS = [
  '<你的工作区>/dsh-desktop',
  '<你的工作区>/dsh/home',
  '<你的工作区>/soul',
  '<user>/WorkBuddy'
]

const DEFAULTS = {
  enabled: true,
  animation: '<你的工作区>/dsh-desktop/splash.mp4',
  type: 'auto',
  fadeInMs: 1000,
  fadeOutMs: 1000,
  minVisibleMs: 1800,
  width: 1280,
  height: 720,
  showHud: true,
  showProgress: true,
  stages: ['正在启动', '正在唤醒记忆', '正在装载插件面板'],
  readyText: '就绪',
  port: 19387,
  fit: 'cover'
}

function json(res, code, obj) {
  const body = JSON.stringify(obj)
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(body))
  res.end(body)
}

function cors(res) {
  // ★ 见文件头第 1 条 —— 少这几行，界面只会显示「载入中」
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
}

function readConfig() {
  try {
    if (!existsSync(CFG_PATH)) return { ok: true, exists: false, path: CFG_PATH, config: { ...DEFAULTS } }
    const raw = readFileSync(CFG_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    return { ok: true, exists: true, path: CFG_PATH, config: { ...DEFAULTS, ...parsed } }
  } catch (e) {
    return { ok: false, exists: true, path: CFG_PATH, config: { ...DEFAULTS }, message: String((e && e.message) || e) }
  }
}

function writeConfig(next) {
  // ★★★  修掉一个真 bug（靠"读回真配置"的验证抓到，不是靠想）：
  //   原来是「keep(只留 _说明/_版本/_预设) + next」，于是**没在这次请求里出现的字段被整个丢掉**，
  //   再被下面的 `!!merged[k]` 把 undefined 变成 false。
  //   实测症状：自检 POST 一个 {fadeInMs:"1500"}，回来 enabled / showHud / showProgress 全成了 false
  //   —— 也就是说**在设置页点一下开关，别的设置会被清空**。
  //   现在改成以**当前配置为底**做 merge：只覆盖这次真的传上来的键。
  const cur = readConfig()
  const base = (cur && cur.config) ? { ...cur.config } : { ...DEFAULTS }
  const merged = { ...base, ...next }
  // 数值兜底（设置页传上来的可能是字符串）
  for (const k of ['fadeInMs', 'fadeOutMs', 'minVisibleMs', 'width', 'height', 'port']) {
    const v = Number(merged[k])
    merged[k] = isFinite(v) ? v : DEFAULTS[k]
  }
  // 布尔：这次显式传了、或者底里本来就有真值，才规范化 —— 不让 undefined 变成 false
  for (const k of ['enabled', 'showHud', 'showProgress']) {
    if (k in next || typeof base[k] === 'boolean') merged[k] = !!merged[k]
    else merged[k] = DEFAULTS[k]
  }
  writeFileSync(CFG_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf8')
  return merged
}

function safeLocalPath(p) {
  // 只接受绝对路径、必须在 ALLOW_DIRS 里、扩展名必须在白名单里
  if (!p || typeof p !== 'string') return null
  let full
  try { full = resolve(p.replace(/\//g, sep)) } catch { return null }
  const norm = full.replace(/\\/g, '/')
  const inAllowed = ALLOW_DIRS.some((d) => norm.toLowerCase().startsWith(d.toLowerCase() + '/') || norm.toLowerCase() === d.toLowerCase())
  if (!inAllowed) return null
  if (!ALL_EXT.includes(extname(norm).toLowerCase())) return null
  return full
}

function listFiles() {
  const out = []
  for (const dir of ALLOW_DIRS) {
    if (!existsSync(dir)) continue
    let names = []
    try { names = readdirSync(dir) } catch { continue }
    for (const n of names) {
      const ext = extname(n).toLowerCase()
      if (!ALL_EXT.includes(ext)) continue
      const full = join(dir, n)
      try {
        const st = statSync(full)
        if (!st.isFile()) continue
        out.push({
          path: full.replace(/\\/g, '/'),
          name: n,
          kind: VIDEO_EXT.includes(ext) ? 'video' : 'image',
          bytes: st.size,
          mtime: st.mtimeMs
        })
      } catch { /* 单个读不了就跳过 */ }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

export function apply(ctx) {
  ctx.webServer.register({
    kind: 'prefix',
    path: '/agent-splash',
    handler: async (req, res) => {
      cors(res)
      if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end() }

      let url
      try { url = new URL(req.url, 'http://127.0.0.1') } catch { return json(res, 400, { ok: false, message: 'URL 不合法' }) }
      const p = url.pathname.replace(/^\/agent-splash/, '') || '/'

      try {
        if (p === '/api/health') {
          return json(res, 200, { ok: true, cfg: CFG_PATH, cfgExists: existsSync(CFG_PATH), allowDirs: ALLOW_DIRS, exts: ALL_EXT })
        }

        if (p === '/api/config') {
          if (req.method === 'GET') return json(res, 200, readConfig())
          if (req.method === 'POST') {
            const chunks = []
            for await (const c of req) chunks.push(c)
            const text = Buffer.concat(chunks).toString('utf8')
            let body
            try { body = JSON.parse(text) } catch (e) {
              return json(res, 400, { ok: false, message: '发上来的不是合法 JSON：' + String((e && e.message) || e) })
            }
            // 动画路径要合法（不合法就明确拒绝，不静默）
            if (body.animation !== undefined && !safeLocalPath(body.animation)) {
              return json(res, 400, { ok: false, message: '动画路径不被接受（必须是绝对路径、在白名单目录里、且是允许的扩展名）：' + body.animation })
            }
            try {
              const saved = writeConfig(body)
              return json(res, 200, { ok: true, saved, path: CFG_PATH })
            } catch (e) {
              return json(res, 500, { ok: false, message: '写配置失败：' + String((e && e.message) || e) })
            }
          }
          return json(res, 405, { ok: false, message: '只支持 GET / POST' })
        }

        if (p === '/api/files') {
          return json(res, 200, { ok: true, dirs: ALLOW_DIRS, files: listFiles() })
        }

        if (p === '/api/preview') {
          const full = safeLocalPath(url.searchParams.get('p'))
          if (!full) return json(res, 400, { ok: false, message: '这个路径不能预览（不在白名单目录里，或扩展名不允许）' })
          if (!existsSync(full)) return json(res, 404, { ok: false, message: '文件不存在：' + full })
          const st = statSync(full)
          const ext = extname(full).toLowerCase()
          const mime = {
            '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
            '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
            '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif'
          }[ext] || 'application/octet-stream'
          res.setHeader('Content-Type', mime)
          res.setHeader('Accept-Ranges', 'bytes')
          // 视频预览要能拖 —— 支持 Range，否则大文件播不动
          const range = req.headers.range
          if (range) {
            const m = /bytes=(\d*)-(\d*)/.exec(range)
            const start = m && m[1] ? parseInt(m[1], 10) : 0
            const end = m && m[2] ? parseInt(m[2], 10) : st.size - 1
            if (start >= st.size) { res.statusCode = 416; res.setHeader('Content-Range', `bytes */${st.size}`); return res.end() }
            res.statusCode = 206
            res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`)
            res.setHeader('Content-Length', end - start + 1)
            return createReadStream(full, { start, end }).pipe(res)
          }
          res.statusCode = 200
          res.setHeader('Content-Length', st.size)
          return createReadStream(full).pipe(res)
        }

        return json(res, 404, { ok: false, message: '没有这条路由：' + p })
      } catch (e) {
        // 兜底：任何异常都变成能读懂的 JSON，不吐栈、也不静默
        try { return json(res, 500, { ok: false, message: String((e && e.message) || e) }) } catch { return res.end() }
      }
    }
  })

  ctx.logger?.info?.('[dsh-agent-splash] 路由已挂：/agent-splash/api/{health,config,files,preview}')
}
