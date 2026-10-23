// dsh-agent-splash · 宿主半
//
// 干什么：给「启动动画」设置页提供读写通道 ——
//   ① 读写配置   <DSH_HOME>/splash.json（主进程的启动画面注入代码启动时读它）
//   ② 列出可选的动画文件（某个目录里的视频/图片）
//   ③ 预览：把本地动画文件代理给浏览器（file:// 页面不能直接读别的本地文件）
//
// ★★★ 三条来自别处的教训，这里都照做了（都不是理论，是踩出来的）：
//   1. **CORS 头必须写。** 桌面端设置页的 origin 是 file:// 或 app://，
//      从那种页面 fetch 本机端口属于跨域 —— 缺这几个头就是 `Failed to fetch`，
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

import { readFileSync, writeFileSync, existsSync, statSync, createReadStream, readdirSync, mkdirSync } from 'node:fs'
import { join, extname, resolve, sep, dirname } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-agent-splash'
// webServer 是硬依赖（没有它就注册不了路由）
export const inject = ['webServer']

// ═══════════════════════════════════════════════════════════════════════════
// DSH 家目录定位 —— 2026-10-23 实机报告 E3 / E5 / E6 / E7 的同一个根
//
// 病灶：默认写成了 `homedir() + '/dsh/home'`。Windows 下 `~` 是 <用户目录>，
// 于是默认落在 `<用户目录>/dsh/home` —— 桌面端根本没有这个目录（桌面端是 `~/.dsh`）。
// 作者机器上设了 DSH_HOME 用户环境变量，这条默认分支永远走不到，所以它一直活着；
// 换台机器立刻变成「配置永远不存在 / 扫描目录全是空的」，而且不报错。
//
// 候选顺序（每一处都写清「为什么」）：
//   ① DSH_HOME        —— DSH 自己用的变量；显式给的一律采信（哪怕暂不存在，也如实报告）
//   ② SPLASH_HOME     —— 本插件专用覆盖（动画目录/配置换一台机器单独验时用）
//   ③ <home>/.dsh     —— DSH 未设 DSH_HOME 时的标准位置（E3：桌面端就是这里）
//   ④ <home>/dsh/home —— 早期安装器的旧布局；只在它真的存在时采用（E3 的旧默认值）
//
// 全都不存在时**不静默**：照旧返回 ③（最可能的标准位置），并带一句可执行的下一步。
// ═══════════════════════════════════════════════════════════════════════════
function isDir(p) {
  try { return !!p && existsSync(p) && statSync(p).isDirectory() } catch { return false }
}

function resolveDshHome(env = process.env, userHome = homedir()) {
  const tried = []
  const add = (path, source, required) => tried.push({ path, source, required: !!required, exists: isDir(path) })
  const envHome = String(env.DSH_HOME || '').trim()
  const ownHome = String(env.SPLASH_HOME || '').trim()

  if (envHome) add(envHome, 'DSH_HOME 环境变量（DSH 自己用的那个）', true)
  if (ownHome) add(ownHome, 'SPLASH_HOME 环境变量（本插件专用覆盖）', true)
  if (!envHome) {
    add(join(userHome, '.dsh'), 'DSH 未设 DSH_HOME 时的标准位置（报告 E3：桌面端就是这里）')
    add(join(userHome, 'dsh', 'home'), '早期安装器的旧布局；只在真的存在时采用（报告 E3 的旧默认值）')
  }

  for (const c of tried) {
    if (c.exists) return { home: c.path, source: c.source, tried, exists: true, hint: null }
  }
  const explicit = tried.find((c) => c.required)
  if (explicit) {
    return {
      home: explicit.path, source: explicit.source, tried, exists: false,
      hint: explicit.source + ' 指向的目录不存在：' + explicit.path + '。下一步：把环境变量改成你机器上真实的 DSH 家目录，再重启 DSH。'
    }
  }
  const fallback = tried[0]
  return {
    home: fallback.path, source: fallback.source, tried, exists: false,
    hint: '找不到 DSH 家目录（试过：' + tried.map((t) => t.path).join('；') + '）。'
      + '下一步：设 DSH_HOME 环境变量指向你的 DSH 家目录（DSH 用它，本插件也读它；'
      + '只想改动画目录而不动 DSH 的，可以设 SPLASH_HOME / SPLASH_DIR），然后重启 DSH。'
  }
}

const HOME_RES = resolveDshHome()
const HOME = HOME_RES.home

// ★ E5：配置路径不许再写死任何人的目录。
//   优先 SPLASH_CONFIG（文档里承诺过的变量），否则按「桌面端的实际布局」推断：
//     <DSH_HOME>/splash.json         —— README 与启动画面注入代码读的就是这份
//     <DSH_HOME>/state/splash.json   —— 实机报告 E5/E7 写的布局；**存在才用**，不覆盖主位置
const CFG_CANDIDATES = (() => {
  const list = []
  const explicit = String(process.env.SPLASH_CONFIG || '').trim()
  if (explicit) list.push({ path: explicit, source: 'SPLASH_CONFIG 环境变量', required: true })
  list.push({ path: join(HOME, 'splash.json'), source: 'DSH 家目录下的 splash.json（README 与启动画面注入代码的默认位置）' })
  list.push({ path: join(HOME, 'state', 'splash.json'), source: 'DSH 家目录下 state/splash.json（报告 E5/E7 的布局；存在才采信）' })
  return list
})()

function resolveConfigPath(cands = CFG_CANDIDATES) {
  const explicit = cands.find((c) => c.required)
  if (explicit) return { path: explicit.path, source: explicit.source, required: true }
  const hit = cands.find((c) => existsSync(c.path))
  if (hit) return { path: hit.path, source: hit.source }
  // 都不存在：用第一候选建 —— 它就是桌面端启动时读的位置（E7：首次打开必须能落盘）
  return { path: cands[0].path, source: cands[0].source }
}

const CFG_RES = resolveConfigPath()
const CFG_PATH = CFG_RES.path
const HOME_DIR = String(process.env.SPLASH_DIR || '').trim() || HOME

// 允许的动画扩展名 —— 不在里面的明确拒绝，不静默
const VIDEO_EXT = ['.mp4', '.webm', '.mov', '.m4v']
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif']
const ALL_EXT = VIDEO_EXT.concat(IMAGE_EXT)

// ★ E6：候选扫描目录一律从解析出来的 DSH 家目录 / 用户目录派生，**不许写死盘符**。
//   - 显式 <SPLASH_DIR> 永远优先（用户说放哪就看哪）
//   - DSH 家目录本身（作者机器的动画就放在这）
//   - 与 DSH 家目录同级的 dsh-desktop / soul（旧布局；只在目录真的存在时加入）
//   - 用户目录下的 WorkBuddy（旧习惯目录；存在才加入）
//   - 再加一个 <DSH_HOME>/splash，方便把素材单独放
const ALLOW_DIRS = (() => {
  const cands = []
  const explicit = String(process.env.SPLASH_DIR || '').trim()
  if (explicit) cands.push(explicit)
  cands.push(HOME)
  cands.push(join(HOME, 'splash'))
  // 旧布局有两种深度：<DSH_HOME>/../dsh-desktop（HOME 就是 .dsh 时），
  // 以及 <DSH_HOME>/../../dsh-desktop（HOME 是 <root>/dsh/home 时）。两种都试，存在才收。
  cands.push(join(dirname(HOME), 'dsh-desktop'))
  cands.push(join(dirname(dirname(HOME)), 'dsh-desktop'))
  cands.push(join(dirname(HOME), 'soul'))
  cands.push(join(homedir(), 'WorkBuddy'))
  const seen = new Set()
  return cands.filter((d) => {
    const key = String(d).toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return isDir(d)
  })
})()

// ★ E6：DSH 会话目录同样是派生的，不写死。
//   splash 现在没有读会话的功能；但健康检查把它列出来 —— 下一次谁要在这里扫描，
//   必须从这里取路径，而不是从某台机器的 C 盘抄一条。
const SESSION_DIRS = [
  { path: join(HOME, 'sessions'), what: 'DSH 会话日志' },
  { path: join(HOME, 'storages', 'session_projcache', 'sessions'), what: 'DSH 会话投影缓存' }
].map((x) => ({ ...x, exists: isDir(x.path) }))

// 默认动画：两个旧布局各试一次，取第一个真的存在的；都不存在就写最常见的那条
// （只是默认值，用户可在设置页改；不因为猜错就挡住面板）。
const DEFAULT_ANIMATION = (() => {
  const c = [join(dirname(HOME), 'dsh-desktop', 'splash.mp4'), join(dirname(dirname(HOME)), 'dsh-desktop', 'splash.mp4')]
  return c.find((p) => existsSync(p)) || c[0]
})()

const DEFAULTS = {
  enabled: true,
  animation: DEFAULT_ANIMATION,
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
  // ★ E8：不许写死面板/宿主端口 —— DSH 的 web 端口每次启动都可能变。
  //   0 表示「未指定」，具体端口由启动器在拉起 splash 页面时注入。
  port: 0,
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
    if (!existsSync(CFG_PATH)) {
      // ★ E7：首次打开不能只是「返回默认值」——那样能显示，却写不进去；
      //   下一次打开仍然是空的。这里把默认配置**落一次盘**，让第一屏就有真数据。
      //   失败时如实带 warning，而不是假装写成了。
      try {
        mkdirSync(dirname(CFG_PATH), { recursive: true })
        writeFileSync(CFG_PATH, JSON.stringify(DEFAULTS, null, 2) + '\n', 'utf8')
        return { ok: true, exists: false, bootstrapped: true, path: CFG_PATH, source: CFG_RES.source, config: { ...DEFAULTS } }
      } catch (e) {
        return {
          ok: true, exists: false, bootstrapped: false, path: CFG_PATH, source: CFG_RES.source, config: { ...DEFAULTS },
          warning: '配置文件不存在，而且建不出来：' + String((e && e.message) || e)
            + '。下一步：在设置页把 SPLASH_CONFIG 指向一个可写文件，或确认 DSH_HOME 目录可写。'
        }
      }
    }
    const raw = readFileSync(CFG_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    return { ok: true, exists: true, bootstrapped: false, path: CFG_PATH, source: CFG_RES.source, config: { ...DEFAULTS, ...parsed } }
  } catch (e) {
    return {
      ok: false, exists: true, path: CFG_PATH, source: CFG_RES.source, config: { ...DEFAULTS },
      message: String((e && e.message) || e)
        + '（文件存在但读不动；要改的话修好它或设 SPLASH_CONFIG 指向另一份，不要删了了事）'
    }
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
  mkdirSync(dirname(CFG_PATH), { recursive: true })
  writeFileSync(CFG_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf8')
  return merged
}

function safeLocalPath(p) {
  // 只接受绝对路径、必须在 ALLOW_DIRS 里、扩展名必须在白名单里
  if (!p || typeof p !== 'string') return null
  let full
  try { full = resolve(p.replace(/\//g, sep)) } catch { return null }
  const norm = full.replace(/\\/g, '/')
  const inAllowed = ALLOW_DIRS.some((d) => norm.toLowerCase().startsWith(d.replace(/\\/g, '/').toLowerCase() + '/') || norm.toLowerCase() === d.replace(/\\/g, '/').toLowerCase())
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
          return json(res, 200, {
            ok: true,
            cfg: CFG_PATH,
            cfgSource: CFG_RES.source,
            cfgExists: existsSync(CFG_PATH),
            allowDirs: ALLOW_DIRS,
            exts: ALL_EXT,
            // ★ E3/E5/E6/E7 的诊断：路径怎么来的、找不到时下一步做什么
            home: { path: HOME, source: HOME_RES.source, exists: HOME_RES.exists, tried: HOME_RES.tried, hint: HOME_RES.hint },
            sessionDirs: SESSION_DIRS,
            configCandidates: CFG_CANDIDATES
          })
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
              return json(res, 400, {
                ok: false,
                message: '动画路径不被接受（必须是绝对路径、在白名单目录里、且是允许的扩展名）：' + body.animation
                  + '。白名单目录：' + ALLOW_DIRS.join('；') + '。下一步：把动画放进其中一个目录，或设 SPLASH_DIR 指向你的动画目录再重启 DSH。'
              })
            }
            try {
              const saved = writeConfig(body)
              return json(res, 200, { ok: true, saved, path: CFG_PATH })
            } catch (e) {
              return json(res, 500, { ok: false, message: '写配置失败：' + String((e && e.message) || e) + '（路径：' + CFG_PATH + '）' })
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

// 导出纯函数 / 解析器，便于在不重启 DSH 的情况下写探针验两条路（有/无 DSH_HOME）
export { resolveDshHome, resolveConfigPath, readConfig, DEFAULTS, CFG_PATH, ALLOW_DIRS, SESSION_DIRS }
