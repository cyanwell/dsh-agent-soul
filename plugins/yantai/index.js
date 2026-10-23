// dsh-agent-yantai —— 宿主半（砚台）
//
// 砚台是 DSH 右栏的一块工作台：把「我现在是什么状态」摊开。
//   · 水位（服务商口径 —— 唯一准的那把尺子）
//   · 未结的活（账本里的 promise / shelved）
//   · 最近的账本
//   · 几扇门（点一下就复制命令）
//
// 为什么数据在宿主半而不是浏览器半：
//   浏览器半碰不到文件系统。而且 client.js 是【每次加载都要解析】的启动期资源 ——
//   数据进去就固化了，改一次要重启一次。
//
// 浏览器半只画界面，通过 /yantai/api/* 跟这里说话。
//
// ★ 宿主半只在 DSH 进程启动时加载一次 —— 改完必须重启 DSH 才生效。

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, hostname } from 'node:os'
import { spawn, execFileSync } from 'node:child_process'

export const name = 'dsh-agent-yantai'
export const inject = ['webServer']

// ── 本机配置：全部来自环境变量 / 本机探测，不含任何人的机器实值 ──────────
// ★★ E9/E10 修的就是这一段。原来这里写死了 5 条绝对路径（作者机器的盘符、用户名、
//   Node 版本号全进来了）。换一台机器，插件**照样加载成功、界面也在**，只是每一格是空的 ——
//   「静默变空」比报错更难查，这是这批 bug 的共同形状。
//
// ★ 规则（三选一，按顺序，每一处回退都在下面写明为什么是这个候选）：
//   ① 使用者显式配的环境变量（README 的「可配项」）
//   ② 本机一定能探测到的东西（当前进程、插件自己所在目录、系统 API）
//   ③ 都没有 → 这一格显示「未配置 + 怎么配」，**绝不退回某个人的路径去猜**
const ENV = (k) => String(process.env[k] || '').trim()
const HERE = dirname(fileURLToPath(import.meta.url))   // 插件自己所在目录，换机器自动跟着走

// 数据源 · 工作区（账本所在的那个根）
// 候选理由：① YANTAI_SOUL 是本插件自己的约定名，装了就知道要配它；
//   ② 不拿 HERE 的上级去猜 —— 插件装在 profile 的 node_modules 里，上级不是使用者的工作区；
//   ③ 没配 = 空串 = 「不猜」，下面每一格各自报未配置。
const SOUL = ENV('YANTAI_SOUL')

// 数据源 · 账本（只追加的 jsonl）
// 候选理由：① YANTAI_LEDGER 直接给完整文件路径，README 已列为可配项，最精确；
//   ② 只配了 SOUL 时取 02-墨.jsonl —— 这是账本的真名。
//      （历史沿革：早先代码里误写成 02-ledger.jsonl，于是「最近的账本」永远是空的，见 E9 报告。）
//   ③ 都没配 → 空串，readLedger 明确报「未配置」。
const LEDGER = ENV('YANTAI_LEDGER') || (SOUL ? join(SOUL, '02-墨.jsonl') : '')

// DSH 家目录（水位要读的投影缓存就在它下面）
// 候选理由：① DSH_HOME —— DSH 自己的家目录变量，显式配置最可靠，优先；
//   ② ~/.dsh/home —— DSH 的每用户默认位置（没设 DSH_HOME 的机器通常在这里）；
//   ③ ~/.dsh —— 老版本 / 手工安装常见的扁平布局。
//   取第一个真实存在的目录；一个都不在 → 空串，readWater 明说「请设 DSH_HOME」。
function firstExistingDir(cands) {
  for (const c of cands) { if (c && existsSync(c)) return c }
  return ''
}
const DSH_HOME = firstExistingDir([ENV('DSH_HOME'), join(homedir(), '.dsh', 'home'), join(homedir(), '.dsh')])
const PROJCACHE = DSH_HOME ? join(DSH_HOME, 'storages', 'session_projcache', 'sessions') : ''

// 记忆工具（搜全库 / 取原文 / 看主导）—— 这是使用者自己的工作区工具，不是插件自带的，
// 所以只能靠配置；找不到就空着，门牌命令里显示「请设 …」，不拼假路径。
// 候选理由：① YANTAI_MEMORY —— 记忆目录（README 可配项），按两种常见布局探脚本：
//      hub/memq.mjs、memq.mjs（检索）；tools/mo.mjs、tools/ledger.mjs（账本 CLI）；
//   ② YANTAI_QUERY —— 检索脚本完整路径，直接覆盖 ① 探出来的检索脚本；
//   ③ YANTAI_MO —— 账本 CLI 完整路径（同样的显式覆盖思路）；
//   ④ 一个都找不到 → 空串。
function firstExistingFile(cands) {
  for (const c of cands) { if (c && existsSync(c)) return c }
  return ''
}
const MEMORY_DIR = ENV('YANTAI_MEMORY')
const MEMQ = ENV('YANTAI_QUERY') || firstExistingFile([
  MEMORY_DIR ? join(MEMORY_DIR, 'hub', 'memq.mjs') : '',
  MEMORY_DIR ? join(MEMORY_DIR, 'memq.mjs') : '',
  MEMORY_DIR ? join(MEMORY_DIR, 'hub', 'memory-query.mjs') : '',
])
const MO = firstExistingFile([
  ENV('YANTAI_MO'),
  MEMORY_DIR ? join(MEMORY_DIR, 'tools', 'mo.mjs') : '',
  MEMORY_DIR ? join(MEMORY_DIR, 'tools', 'ledger.mjs') : '',
])

// Node 可执行文件（只用来拼「几扇门」里可复制的命令，不在这里 fork）
// 候选理由：① YANTAI_NODE —— 显式指定，最优先（版本管理器 / 便携节点用得上）；
//   ② process.execPath —— 当前跑 DSH 的这个 Node 进程自己，一定是个能用的 Node；
//      只在 basename 真是 node(.exe) 时采用（DSH 桌面端可能是 Electron，那时 execPath 是 app 的 exe，跳过）；
//   ③ 字面量 'node' —— 交给使用者机器的 PATH。不在 PATH 时复制出来的命令会明确报
//      「不是内部或外部命令」，而不是悄悄指向别人的绝对路径。
const NODE = ENV('YANTAI_NODE')
  || (/^node(\.exe)?$/i.test(basename(process.execPath || '')) ? process.execPath : '')
  || 'node'

// 机器名（hello 里带的桌面标识）：用系统报的，不写死。
// 候选理由：① YANTAI_HOST —— 主机名含中文/怪字符时使用者可以覆盖它；
//   ② os.hostname() —— 系统自己报的名字，换机器自动正确；
//   ③ 'pc' —— 只是给 hello 一个可用标识，不含任何人的信息。
const HOST_NAME = ENV('YANTAI_HOST') || hostname() || 'pc'


// ── 算力节点（手机）·  使用者要的那一格 ────────────────────
// 他的原话：「做一个进程，专门用来检查手机算力节点是否在线……可以看到它的状态，
//            然后我可以通过这里手动唤醒它，那这个界面就叫做算力节点吧。」
//
// ★★ 为什么探测一定放在宿主半、不能让浏览器半直接打手机：
//    砚台在 127.0.0.1:19387，手机服务在 127.0.0.1:18766 —— 不同端口就是跨源，
//    浏览器会拦（而手机那边的 CORS 是我们**故意不加**的）。宿主半是 Node，没有这回事。
//    所以链路是：面板(client) → /yantai/api/node/* → 宿主半 → 手机。
//
// ★★ 为什么不需要密码就能知道「在不在」：手机那边 `/api/link/hello` 是免鉴权的
//    （契约 §1 唯一的免鉴权写操作，理由是不让 PC 侧工具持有口令）。
//    只有要看温度/内存/唤醒时才需要令牌 —— 那时使用者在砚台里输一次，**只存在这个进程的内存里**，
//    不落盘、不进任何留底。DSH 一重启就要重连一次，这是故意的。
// ★★ E10：手机地址是本机网络位置，**必须来自配置**。原来这里写死了作者的
//   http://127.0.0.1:18766 —— 别人机器上那个端口没有东西在听，界面只会显示「连不上」，
//   没人知道其实是没配。现在没配 = configured:false，界面直接说「未配置 + 怎么配」。
// ★ 没有回退候选：猜一个端口等于把作者的机器又搬回来。
const NODE_ORIGIN = ENV('YANTAI_NODE_ORIGIN').replace(/\/+$/, '')
const NODE_PROBE_MS = 15000                    // 探测间隔（纯 HTTP，不花 token）
const NODE_STALE_MS = 45000                     // 与手机端 link_timeout_s 对齐

let nodeToken = null            // ★ 只活在这个进程的内存里
let nodeProbeTimer = null
const nodeState = {
  origin: NODE_ORIGIN,
  configured: !!NODE_ORIGIN,    // ★ E10：没配地址就不假装在探
  reachable: false,             // 手机服务在不在
  loggedIn: false,              // 有没有令牌
  lastPingAt: 0,                // 上一次探测的时刻（ms）
  lastPingMs: null,             // 上次探测耗时
  lastError: null,
  pings: 0,
  link: null,                   // hello/status 回来的 link 段
  status: null,                 // 摘要：核数/内存/温度/电池/uptime
  models: null,
  tasks: null,
}

// 水位四段 —— 与工作区 AGENTS.md 的水位节一致：
// 600K 起施压 / 680K 我的硬纪律 / 800K ACP 红灯 / 880K 兜底强制（1M 窗口）
const BANDS = [0.60, 0.68, 0.80, 0.88]

function json(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8')
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': buf.length,
  })
  res.end(buf)
}

// ── 账本：只追加的账本，整读之后按行 parse ──────────────────
function readLedger(limit) {
  try {
    if (!LEDGER) {
      return { ok: false, rows: [], open: [], total: 0,
        message: '未配置账本：请设 YANTAI_LEDGER = 账本文件完整路径，'
          + '或设 YANTAI_SOUL = 工作区根目录（账本取 <它>/02-墨.jsonl）' }
    }
    if (!existsSync(LEDGER)) {
      return { ok: false, message: '账本不在：' + LEDGER, rows: [], open: [], total: 0 }
    }
    const lines = readFileSync(LEDGER, 'utf8').split('\n')
    const rows = []
    for (const line of lines) {
      const s = line.trim()
      if (!s) continue
      // 半行 / 坏行就跳过 —— 不让一行坏了把整块拖死
      try { rows.push(JSON.parse(s)) } catch (e) { /* skip */ }
    }
    // ★ ：墨的字段分家了 —— 正文从 text 改名「概要」，另加一个可选的 feel（一手感受）。
    //   历史那 348 行仍然是 text。两个都认，别只认一个，否则新行在界面上是一片空白。
    const pick = (r) => ({
      t: r.t, type: r.type, by: r.by,
      text: r['概要'] ?? r.text ?? '',
      feel: r.feel ?? null,
      ref: r.ref,
    })
    const open = rows
      .filter((r) => r.type === 'promise' || r.type === 'shelved')
      .slice(-9).reverse().map(pick)
    const tail = rows.slice(-limit).reverse().map(pick)
    return { ok: true, total: rows.length, rows: tail, open }
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e), rows: [], open: [], total: 0 }
  }
}

// ── 水位 ────────────────────────────────────────────────────
// 判据：pressureTokens = 服务商口径（inputTokens + cacheReadTokens），唯一能当尺子用的数。
// 目录里 mtime 最新的那份 = 正在写的那条会话。
// 引擎实际读的是外推值：projected = pressure + surface − sampledSurface
//   （与 dsh-token-meter 同式；它是派生字段，不落盘，所以这里自己算）
function readWater() {
  try {
    if (!PROJCACHE) {
      return { ok: false, message: '未配置 DSH 家目录：请设环境变量 DSH_HOME 指向你的 DSH 家目录'
        + '（默认候选 ~/.dsh/home、~/.dsh 都没探到）' }
    }
    if (!existsSync(PROJCACHE)) {
      return { ok: false, message: '投影缓存不在：' + PROJCACHE
        + '（若你的 DSH_HOME 在别处，请设环境变量 DSH_HOME）' }
    }
    const files = readdirSync(PROJCACHE).filter((f) => f.endsWith('.json'))
    if (!files.length) return { ok: false, message: '投影缓存是空的' }
    let newest = null
    for (const f of files) {
      let m = 0
      try { m = statSync(join(PROJCACHE, f)).mtimeMs } catch (e) { continue }
      if (!newest || m > newest.m) newest = { f, m }
    }
    if (!newest) return { ok: false, message: '读不到任何投影文件' }
    const j = JSON.parse(readFileSync(join(PROJCACHE, newest.f), 'utf8'))
    const cp = (j && j.record && j.record.rows && j.record.rows.contextPressure
      && j.record.rows.contextPressure.val) || {}
    const win = cp.contextWindow || 1000000
    const pressure = typeof cp.pressureTokens === 'number' ? cp.pressureTokens : null
    const surface = typeof cp.surfaceTokens === 'number' ? cp.surfaceTokens : null
    const sampled = typeof cp.sampledSurfaceTokens === 'number' ? cp.sampledSurfaceTokens : null
    const projected = (pressure === null || surface === null || sampled === null)
      ? null
      : Math.max(0, pressure + surface - sampled)
    return {
      ok: true,
      session: newest.f.replace(/\.json$/, ''),
      ageMs: Date.now() - newest.m,
      contextWindow: win,
      pressureTokens: pressure,
      surfaceTokens: surface,
      sampledSurfaceTokens: sampled,
      projectedTokens: projected,
      pct: pressure === null ? null : pressure / win,
      bands: BANDS,
    }
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) }
  }
}

// ── 算力节点：干活的三个函数 ─────────────────────────────────
// 一律走 fetch（Node 22 自带），不引任何依赖。
async function nodeHttp(path, { method = 'GET', body, ms = 6000 } = {}) {
  // 没配地址就别发请求 —— 否则报出来的是「连不上某个陌生端口」，误导排查方向
  if (!NODE_ORIGIN) throw new Error('未配置手机地址（YANTAI_NODE_ORIGIN）')
  const headers = { 'content-type': 'application/json' }
  if (nodeToken) headers.authorization = 'Bearer ' + nodeToken
  const r = await fetch(NODE_ORIGIN + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(ms),
  })
  const text = await r.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { parsed = { raw: text.slice(0, 200) } }
  return { code: r.status, body: parsed }
}

// 探一次。不需要令牌的部分（hello）就足以回答「在不在」——
// 这正是当初把 hello 做成免鉴权的原因。
async function nodeProbe() {
  const t0 = Date.now()
  if (!NODE_ORIGIN) {
    nodeState.reachable = false
    nodeState.loggedIn = false
    nodeState.lastError = '未配置：请设环境变量 YANTAI_NODE_ORIGIN = 手机服务经 adb forward 后的本机地址'
      + '（例 http://127.0.0.1:8766），改完重启 DSH'
    return nodeState
  }
  try {
    const h = await nodeHttp('/api/link/hello', {
      method: 'POST',
      body: { client: 'pc', host: HOST_NAME + '-desktop', version: '1.0' },
    })
    nodeState.pings++
    nodeState.lastPingAt = Date.now()
    nodeState.lastPingMs = Date.now() - t0
    if (h.code !== 200) {
      nodeState.reachable = false
      nodeState.lastError = 'hello 回了 HTTP ' + h.code
      return nodeState
    }
    nodeState.reachable = true
    nodeState.lastError = null

    // 有令牌就顺手把全量状态拉回来（没令牌只更新「在不在」）
    if (nodeToken) {
      const s = await nodeHttp('/api/status')
      if (s.code === 200 && s.body && s.body.ok) {
        nodeState.link = s.body.link || null
        nodeState.status = {
          uptime_s: s.body.node && s.body.node.uptime_s,
          cores: s.body.cpu && s.body.cpu.cores,
          freq_khz: s.body.cpu && s.body.cpu.freq_khz,
          mem_total_kb: s.body.mem && s.body.mem.total_kb,
          mem_avail_kb: s.body.mem && s.body.mem.avail_kb,
          mem_used_pct: s.body.mem && s.body.mem.used_pct,
          max_c: s.body.thermal && s.body.thermal.max_c,
          zones_total: s.body.thermal && s.body.thermal.zones_total,
          zones_skipped: s.body.thermal && s.body.thermal.zones_skipped,
          batt_temp_c: s.body.battery && s.body.battery.temp_c,
          batt_status: s.body.battery && s.body.battery.status,
          services: s.body.services || [],
        }
      } else if (s.code === 401) {
        nodeToken = null           // 令牌过期就丢掉，界面会提示重新连接
        nodeState.loggedIn = false
      }
      const m = await nodeHttp('/api/models')
      if (m.code === 200 && m.body && m.body.ok) nodeState.models = m.body.models || []
      const t = await nodeHttp('/api/tasks?limit=5')
      if (t.code === 200 && t.body && t.body.ok) nodeState.tasks = t.body.tasks || []
    }
  } catch (e) {
    nodeState.reachable = false
    const c = (e && e.cause && e.cause.code) || ''
    nodeState.lastError = c || (e && e.name === 'TimeoutError' ? '超时' : String((e && e.message) || e))
    nodeState.lastPingAt = Date.now()
    nodeState.lastPingMs = Date.now() - t0
  }
  return nodeState
}

async function nodeLogin(password) {
  const r = await nodeHttp('/api/login', { method: 'POST', body: { password }, ms: 8000 })
  if (r.code !== 200 || !r.body || !r.body.ok) {
    return { ok: false, message: (r.body && r.body.error) || ('HTTP ' + r.code) }
  }
  nodeToken = r.body.token            // ★ 只在内存里
  nodeState.loggedIn = true
  await nodeProbe()
  return { ok: true, expires_in: r.body.expires_in }
}

async function nodeWake(id) {
  if (!nodeToken) return { ok: false, message: '还没连接（唤醒要令牌）' }
  const r = await nodeHttp('/api/wake', { method: 'POST', body: { id, args: {} }, ms: 10000 })
  if (r.code === 401) { nodeToken = null; nodeState.loggedIn = false; return { ok: false, message: '令牌过期了，请重新连接' } }
  return { ok: !!(r.body && r.body.ok), ...(r.body || {}), http: r.code }
}

function nodeStartProbe() {
  nodeProbe()
  // 没配手机地址就不开循环：每 15 s 打一个不存在的端口，只是白烧 CPU 和日志
  if (!NODE_ORIGIN) return
  nodeProbeTimer = setInterval(() => { nodeProbe() }, NODE_PROBE_MS)
  if (nodeProbeTimer.unref) nodeProbeTimer.unref()   // 别让它吊住进程退出
}

// ── 几扇门（静态清单，界面上点一下就复制命令）────────────────
// ── 能力架 ──────────────────────────────────────────────────
// 使用者  要的：把agent常用的能力摆成小图标，"像摆放自己喜欢的东西一样"。
// ★ 故意放宿主半：改这张清单不用重启 DSH（客户端半是启动期资源，改一次得重启一次）。
// state: 'live' 现在就能用 / 'need' 要先拉起某个服务 / 'todo' 还没接。
const ABILITIES = [
  { emoji: '🦊', name: '火狐', what: '接管你真实的火狐：只读浏览、读页面', state: 'live',
    how: 'fb.js（BiDi，9222）' },
  { emoji: '⌨️', name: '浏览器', what: '另开一个受管窗口：读写页面、调它、验 UI', state: 'live',
    how: 'browser_session / inspect / interact' },
  { emoji: '🎨', name: '生图', what: '出图。本机三线：Z-Image / SDXL / animagine', state: 'need',
    how: 'generate_image(provider: comfyui) —— 先 comfyui_control start' },
  { emoji: '🖼️', name: '改图', what: '拿参考图改：换衣服、换场景、保身份', state: 'live',
    how: 'edit_image(prompt, source_*)' },
  { emoji: '🔊', name: '声音', what: '说话。VoxCPM 本地 + edge-tts 兜底', state: 'live',
    how: '插件 dsh-agent-voice' },
  { emoji: '🐋', name: '宠物', what: '桌角那只，会切表情', state: 'live',
    how: '插件 dsh-agent-pet' },
  { emoji: '🖥️', name: 'ComfyUI', what: '本机出图引擎的开关与状态', state: 'live',
    how: 'comfyui_control(start / stop / status)' },
  { emoji: '📓', name: '记忆', what: '几扇门：搜全库 / 取一手原文 / 看时间线', state: 'live',
    how: (MEMQ ? basename(MEMQ) : '（未配置 YANTAI_QUERY）') + ' now | <词> | open <指针> | timeline' },
  { emoji: '🧩', name: '技能', what: 'Office 三件套、材料总览、CAD 对 BOM、打包规范…', state: 'live',
    how: 'skill（清单随会话注入）' },
  { emoji: '🎯', name: '看板', what: '任务看板：建卡、派活、定时', state: 'live',
    how: 'task_board_*' },
  { emoji: '⏰', name: '计划', what: '定时任务（心跳、日检就是这么跑的）', state: 'live',
    how: 'task_board_schedule（5 段 cron）' },
  { emoji: '💬', name: '微信', what: '给你手机发消息', state: 'need',
    how: 'notify_wechat —— 需你先在微信里给 bot 发一条解锁' },
  { emoji: '🐧', name: 'QQ', what: '群里的那个我（SnowLuma OneBot 网关）', state: 'need',
    how: '网关 3001 / 3100；插件 dsh-clawbot' },
  { emoji: '🔗', name: '算力节点', what: '手机那个节点：在不在线、多热、剩多少内存、一键唤醒', state: 'live',
    how: NODE_ORIGIN ? 'HTTP 心跳 ' + NODE_ORIGIN + '（不花 token）'
      : '未配置：请设 YANTAI_NODE_ORIGIN（心跳照常显示，只读状态）' },
  { emoji: '🎬', name: '视频', what: '你提过；本机还没接 —— 要的话我们一起挑模型', state: 'todo',
    how: '（空着等我们填）' },
]

// ── 速达：扫出来的程序清单 ──────────────────────────────────
// 由同目录的 scan-apps.ps1 生成（那个脚本是纯 ASCII、写 JSON 不带 BOM —— 见它的头部说明）。
// ★ E10：原来写的是相对当前工作目录的 `'\\apps'` —— 而 DSH 进程的 cwd 通常是安装目录，
//   不是插件目录，于是清单永远读不到（界面空白，也不报错）。
// 候选理由：① YANTAI_APPS_DIR —— 给「清单放在别处」的人留的口子；
//   ② 默认锚在插件自己的目录（HERE/apps），换机器自动跟着走，和 README 里 apps/ 的约定一致。
const APPS_DIR = ENV('YANTAI_APPS_DIR') || join(HERE, 'apps')
const APPS_JSON = join(APPS_DIR, 'apps.json')
const ICON_DIR = join(APPS_DIR, 'icons')

// ── 速达：分类规则 ──────────────────────────────────────────
// ★ 分类放在宿主半、用关键词匹配，而不是写进 apps.json ——
//   这样改分类只要重启一次 DSH，不用重跑扫描脚本（那要再起一个 PowerShell，慢）。
//   顺序有意义：先匹配到的赢。最后一个 other 兜底。
const CATS = [
  { id: 'dev', label: '开发', color: '#57a6ff',
    kw: ['vscode', 'visual studio', 'code', 'zed', 'cursor', 'sublime', 'github', 'docker',
         'python', 'idle', 'opencode', 'zcode', 'navop', 'x-hub', 'workbuddy', 'kite',
         'loop', 'sourcetree', 'git', 'postman', 'xshell', 'putty'] },
  { id: 'tool', label: '工具', color: '#3ec46d',
    kw: ['zip', 'bandizip', '360', 'lightroom', 'autocad', 'layout', 'sketchup', 'everything',
         'obsidian', 'paster', 'adobe', 'office', 'wps', 'excel', 'word', 'acrobat',
         'character', 'nvidia', 'intel', 'msi', 'afterburner'] },
  { id: 'media', label: '影音', color: '#b98cf0',
    kw: ['obs', 'potplayer', 'vlc', '3dmark', 'furmark', 'frameview', 'gpuview', 'rivatuner',
         'desktop overlay', '剪辑', 'photoshop'] },
  { id: 'social', label: '社交', color: '#e5a84b',
    kw: ['微信', 'weixin', 'wechat', 'qq', '钉钉', 'dingtalk', '飞书', 'feishu', 'lark',
         '抖音', '小红书', '豆包', 'doubao', 'todesk', 'teamviewer', 'sunlogin', '向日葵',
         '腾讯会议', '腾讯视频', '会议'] },
  { id: 'other', label: '其他', color: '#9aa0a6', kw: [] },
]

function classify(name, target) {
  const s = (String(name || '') + ' ' + String(target || '')).toLowerCase()
  for (const c of CATS) {
    if (!c.kw.length) continue
    for (const k of c.kw) if (s.indexOf(k) >= 0) return c.id
  }
  return 'other'
}

// ── 速达：点过几次（决定"常用"怎么排）───────────────────────
const USAGE_JSON = join(APPS_DIR, 'usage.json')

function readUsage() {
  try {
    if (!existsSync(USAGE_JSON)) return {}
    return JSON.parse(readFileSync(USAGE_JSON, 'utf8').replace(/^\uFEFF/, '')) || {}
  } catch (e) {
    return {}
  }
}

function bumpUsage(key) {
  const u = readUsage()
  u[key] = (u[key] || 0) + 1
  try { writeFileSync(USAGE_JSON, JSON.stringify(u, null, 2), 'utf8') } catch (e) { /* 计数失败不影响启动 */ }
  return u
}

// 前台激活：在跑就唤窗口，不在才启动（思路抄 x-hub —— 它这点最省事）
const FOCUS_SCRIPT = join(APPS_DIR, '..', 'focus-app.ps1')

function tryFocus(exePath) {
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', FOCUS_SCRIPT, '-ExePath', exePath,
    ], { timeout: 8000, encoding: 'utf8' })
    return String(out || '').trim()
  } catch (e) {
    return ''
  }
}

function readApps() {
  try {
    if (!existsSync(APPS_JSON)) {
      return { ok: false, message: '还没扫过：' + APPS_JSON, items: [], total: 0, at: 0, cats: CATS }
    }
    // 顺手剥掉可能存在的 BOM —— Node 的 JSON.parse 不认它
    const raw = readFileSync(APPS_JSON, 'utf8').replace(/^\uFEFF/, '')
    const list = JSON.parse(raw)
    const usage = readUsage()
    const items = (Array.isArray(list) ? list : []).map((a) => Object.assign({}, a, {
      cat: classify(a.name, a.target),
      used: usage[a.target] || 0,
    }))
    return {
      ok: true,
      at: statSync(APPS_JSON).mtimeMs,
      total: items.length,
      items,
      cats: CATS.map((c) => ({ id: c.id, label: c.label, color: c.color })),
    }
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e), items: [], total: 0, at: 0, cats: CATS }
  }
}

// ── 砚台自己的三块：便签 / 待办 / 项目 ──────────────────────
// ★ 数据放书房，不放插件目录 —— 插件是可以重装的，东西不能跟着陪葬。
const DESK_DIR = join(SOUL, '30-状态', '砚台')
const DESK_FILES = {
  notes: join(DESK_DIR, 'notes.json'),
  todos: join(DESK_DIR, 'todos.json'),
  projects: join(DESK_DIR, 'projects.json'),
}

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch (e) {
    return fallback
  }
}

function writeJson(file, value) {
  try {
    if (!existsSync(DESK_DIR)) mkdirSync(DESK_DIR, { recursive: true })
    writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
    return true
  } catch (e) {
    return false
  }
}

function readDesk() {
  const arr = (x) => (Array.isArray(x) ? x : [])
  return {
    ok: true,
    dir: DESK_DIR,
    notes: arr(readJson(DESK_FILES.notes, [])),
    todos: arr(readJson(DESK_FILES.todos, [])),
    projects: arr(readJson(DESK_FILES.projects, [])),
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8')
      if (!s) return resolve({})
      try { resolve(JSON.parse(s)) } catch (e) { reject(new Error('body 不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

// ★ 门牌命令：路径没配时给的是「请设 …」，不是一条看着像真的假命令
const NODE_Q = '"' + NODE + '"'
const MEMQ_Q = MEMQ || '<请设 YANTAI_QUERY = 检索脚本完整路径>'
const MO_Q = MO || '<请设 YANTAI_MO = 账本 CLI 完整路径>'

const GATES = [
  { id: 'now', label: '现在', hint: '时钟 / 距上轮 / 当前主导 / 未结',
    cmd: NODE_Q + ' ' + MEMQ_Q + ' now' },
  { id: 'find', label: '搜一件事', hint: '一扇门搜全库，只回指针 + 逐字片段',
    cmd: NODE_Q + ' ' + MEMQ_Q + ' <关键词>' },
  { id: 'open', label: '从门牌取原文', hint: 'log:session-…#seq=N → 一手原文',
    cmd: NODE_Q + ' ' + MEMQ_Q + ' open <指针>' },
  { id: 'timeline', label: '时间线', hint: '某个时刻之后发生了什么',
    cmd: NODE_Q + ' ' + MEMQ_Q + ' timeline --since <ISO>' },
  { id: 'lead', label: '谁是主导', hint: '账本里最后一条 lead 的署名者',
    cmd: NODE_Q + ' ' + MO_Q + ' list --type lead --limit 3' },
]

// ── 插件主体 ────────────────────────────────────────────────
export function apply(ctx) {
  const route = ctx.webServer.register({
    kind: 'prefix',
    path: '/yantai',
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const p = url.pathname.replace(/^\/yantai/, '') || '/'
      try {
        // 一次给全 —— 界面开局只要一个请求
        if (p === '/api/state') {
          const raw = Number(url.searchParams.get('n') || 12)
          const n = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 60) : 12
          return json(res, 200, {
            ok: true,
            builtAt: new Date().toISOString(),
            water: readWater(),
            ledger: readLedger(n),
            gates: GATES,
            abilities: ABILITIES,
            apps: readApps(),
            desk: readDesk(),
            node: nodeState,
            paths: {
              soul: SOUL, ledger: LEDGER, projcache: PROJCACHE, dshHome: DSH_HOME,
              memoryDir: MEMORY_DIR, memq: MEMQ, mo: MO, node: NODE,
              appsDir: APPS_DIR, nodeOrigin: NODE_ORIGIN, host: HOST_NAME,
            },
          })
        }
        // 速达三件事：清单 / 图标 / 启动
        if (p === '/api/apps') return json(res, 200, readApps())
        if (p === '/api/icon') {
          const f = String(url.searchParams.get('f') || '').replace(/[^A-Za-z0-9.]/g, '')
          const full = join(ICON_DIR, f)
          if (!f || !existsSync(full)) { res.writeHead(404); return res.end('no icon') }
          const buf = readFileSync(full)
          res.writeHead(200, {
            'content-type': 'image/png',
            // ★★  agent：原来是 'no-store' —— 那是「滚轮一动整个界面闪」的根因。
            //   速达页一次最多渲染 300 个图标（client.js 的 view = shown.slice(0, 300)），
            //   no-store 让浏览器**每次重绘都重新拉一遍**，几十上百个并发请求 + 图片解码
            //   把主线程塞满，界面就跟着闪。使用者自己看出来的（「有很多小图标刷新」）。
            //   ★ 为什么可以永久缓存：图标文件名就是内容哈希（00b5df5a94b5.png），
            //     内容变了名字就变，所以不存在"换了图还看旧的"这个问题。
            'cache-control': 'public, max-age=31536000, immutable',
            'content-length': buf.length,
          })
          return res.end(buf)
        }
        if (p === '/api/launch') {
          // ★ 只认清单里的第 i 项 —— 不接受任意路径。
          //   界面能启的，就是 scan-apps.ps1 扫出来的那些，别的一律进不来。
          const i = Number(url.searchParams.get('i'))
          const a = readApps()
          const item = a.ok && Number.isInteger(i) && i >= 0 && i < a.items.length ? a.items[i] : null
          if (!item || !item.target) return json(res, 200, { ok: false, message: '索引不对' })

          const usage = bumpUsage(item.target)

          // ★ 先问一句：它是不是已经在跑？在跑就把窗口唤到前台，不再开一个。
          //   （x-hub 最实用的一条：收进托盘、最小化的都能唤出来。）
          const focus = tryFocus(item.target)
          if (focus.indexOf('OK') === 0) {
            return json(res, 200, { ok: true, focused: item.name, target: item.target,
              note: '本来就在跑，已经把窗口唤到前台', used: usage[item.target] })
          }

          try {
            const child = spawn(item.target, [], {
              detached: true,
              stdio: 'ignore',
              cwd: join(item.target, '..'),
            })
            child.unref()
            return json(res, 200, { ok: true, launched: item.name, target: item.target,
              used: usage[item.target],
              note: focus.indexOf('ALIVE') === 0 ? '进程活着但唤不到窗口，已再启一个' : '' })
          } catch (e) {
            return json(res, 200, { ok: false, message: String((e && e.message) || e) })
          }
        }
        // 砚台自己的三块
        if (p === '/api/desk') return json(res, 200, readDesk())

        if (p === '/api/note' && req.method === 'POST') {
          const body = await readBody(req)
          const list = readDesk().notes
          const id = String(body.id || ('n' + Date.now()))
          const item = { id, text: String(body.text || ''), updatedAt: new Date().toISOString() }
          const i = list.findIndex((x) => x && x.id === id)
          if (i >= 0) list[i] = item
          else list.push(item)
          return json(res, 200, { ok: writeJson(DESK_FILES.notes, list), item, total: list.length })
        }

        if (p === '/api/todo' && req.method === 'POST') {
          const body = await readBody(req)
          const list = readDesk().todos
          if (body.op === 'add') {
            const item = { id: 't' + Date.now(), text: String(body.text || ''), done: false,
                           prio: 0, due: String(body.due || ''), createdAt: new Date().toISOString() }
            list.push(item)
            return json(res, 200, { ok: writeJson(DESK_FILES.todos, list), item, total: list.length })
          }
          const id = String(body.id || '')
          const i = list.findIndex((x) => x && x.id === id)
          if (i < 0) return json(res, 200, { ok: false, message: '没有这一条' })
          if (body.op === 'del') list.splice(i, 1)
          else {
            const it = list[i]
            if (body.text !== undefined) it.text = String(body.text)
            if (body.done !== undefined) it.done = !!body.done
            if (body.prio !== undefined) it.prio = Number(body.prio) || 0
            if (body.due !== undefined) it.due = String(body.due)
            it.updatedAt = new Date().toISOString()
          }
          return json(res, 200, { ok: writeJson(DESK_FILES.todos, list), total: list.length })
        }

        if (p === '/api/project' && req.method === 'POST') {
          const body = await readBody(req)
          const list = readDesk().projects
          if (body.op === 'add') {
            const item = { id: 'p' + Date.now(), name: String(body.name || '新项目'),
                           start: String(body.start || ''), end: String(body.end || ''),
                           progress: Number(body.progress) || 0, note: String(body.note || '') }
            list.push(item)
            return json(res, 200, { ok: writeJson(DESK_FILES.projects, list), item, total: list.length })
          }
          const id = String(body.id || '')
          const i = list.findIndex((x) => x && x.id === id)
          if (i < 0) return json(res, 200, { ok: false, message: '没有这一个' })
          if (body.op === 'del') list.splice(i, 1)
          else {
            const it = list[i]
            if (body.name !== undefined) it.name = String(body.name)
            if (body.start !== undefined) it.start = String(body.start)
            if (body.end !== undefined) it.end = String(body.end)
            if (body.progress !== undefined) it.progress = Math.max(0, Math.min(100, Number(body.progress) || 0))
            if (body.note !== undefined) it.note = String(body.note)
          }
          return json(res, 200, { ok: writeJson(DESK_FILES.projects, list), total: list.length })
        }

        // ── 算力节点（手机）──────────────────────────────
        // 面板只跟这三四个口说话，探测本身在宿主半按 15 s 跑（纯 HTTP，不花 token）。
        if (p === '/api/node') return json(res, 200, { ok: true, node: nodeState })

        if (p === '/api/node/ping') return json(res, 200, { ok: true, node: await nodeProbe() })

        if (p === '/api/node/login' && req.method === 'POST') {
          // ★ password 只在这一个请求里存在：转发给手机换 token，然后随请求一起消失。
          const body = await readBody(req)
          const r = await nodeLogin(String(body.password || ''))
          return json(res, 200, { ...r, node: nodeState })
        }

        if (p === '/api/node/logout' && req.method === 'POST') {
          nodeToken = null
          nodeState.loggedIn = false
          nodeState.status = null
          nodeState.models = null
          return json(res, 200, { ok: true, node: nodeState })
        }

        if (p === '/api/node/wake' && req.method === 'POST') {
          const body = await readBody(req)
          const r = await nodeWake(String(body.id || ''))
          return json(res, 200, { ...r, node: nodeState })
        }

        if (p === '/api/ledger') return json(res, 200, readLedger(30))
        if (p === '/api/water') return json(res, 200, readWater())
        if (p === '/api/gates') return json(res, 200, { ok: true, gates: GATES })
        return json(res, 404, { ok: false, message: '没有这个路由：' + p })
      } catch (e) {
        return json(res, 500, { ok: false, message: String((e && e.message) || e) })
      }
    },
  })
  ctx.effect(() => route, 'dsh-agent-yantai: routes')

  // 算力节点的探测循环。★ 它是一条独立的 effect，因为要能单独收拾干净：
  // 没有它，DSH 每次重载插件都会多留一个 setInterval（这就是常驻的"那个进程"）。
  ctx.effect(() => {
    nodeStartProbe()
    return () => {
      if (nodeProbeTimer) { clearInterval(nodeProbeTimer); nodeProbeTimer = null }
    }
  }, 'dsh-agent-yantai: 算力节点探测')
}
