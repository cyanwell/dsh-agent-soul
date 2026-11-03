// dsh-yanqing-heartbeat — DSH plugin package, Host half.
//
// 读三个真值，经 /heartbeat/state 交给浏览器半：
//   ① 谁在驾驶   —— 《墨》里最后一条 lead 的摘要
//   ② 上次心跳   —— _auto.log 的末行
//   ③ 下次运行   —— 计划任务 Yanqing-Heartbeat 的 Next Run
//
// 三样都容错：读不到就返回 null，绝不因为一个文件缺失让整个面板挂掉。

import { join, resolve } from 'node:path'
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync , appendFileSync, mkdirSync } from 'node:fs'
import { execFile } from 'node:child_process'

export const name = 'dsh-yanqing-heartbeat'
export const inject = ['webServer', 'agents']

const BOOK = 'D:\\AI\\yanqing-soul\\02-墨.jsonl'
const HUB = 'D:\\AI\\memory\\hub'
const AUTO_LOG = HUB + '\\heartbeat\\_auto.log'
// ★ 2026-11-03 22:12 爀曦要「每步产出了什么」。heartbeat.mjs 写的历史里只有步骤名/成败/耗时，
//   这里在插件侧补一本「输出账」，按结束时间匹配 history 里的记录。
//   ★★ 边界：只有 /heartbeat/run（手动/强制）能拿到 stdout；自动触发走的是 followup，
//      产出在那一轮的对话里，不在命令输出里 —— 那一类这里记不到。
const RUN_OUT = HUB + '\\heartbeat\\_run_out.json'
function saveRunOut (tEnd, out, meta) {
  try {
    let arr = []
    try { arr = JSON.parse(readFileSync(RUN_OUT, 'utf8')) } catch (e) { arr = [] }
    if (!Array.isArray(arr)) arr = []
    arr.push({ tEnd, out: String(out || '').slice(-2500), ...(meta || {}) })
    while (arr.length > 12) arr.shift()
    writeFileSync(RUN_OUT, JSON.stringify(arr), 'utf8')
  } catch (e) { /* 记账失败不影响主流程 */ }
}
function readRunOut () {
  try {
    const a = JSON.parse(readFileSync(RUN_OUT, 'utf8'))
    return Array.isArray(a) ? a : []
  } catch (e) { return [] }
}
const DAILY_DIR = HUB + '\\heartbeat'
const REPORTS_DIR = HUB + '\\heartbeat\\reports'          // ★ 巡视报告 + 报警队列
const HB_DIR_FOR_ORIGIN = 'D:\\AI\\dsh-tools\\dsh-yanqing-heartbeat'   // ★ 脚本侧目录，用来把 origin 传给脚本
const LATEST_LOG = 'D:\\AI\\dsh-tools\\dsh-yanqing-heartbeat\\heartbeat.log.jsonl'   // ★ 巡视记录的权威来源
const TASK_NAMES = ['Yanqing-Echo-Heartbeat', 'Yanqing-Echo-Heartbeat-AM']

// ★ _auto.log 是 GBK 编码（Windows 批处理写的）。用 utf8 读会得到「��һ」这种乱码。
//   TextDecoder('gbk') 在 Node 18+ 可用（ICU 完整版）；不可用时退回 latin1 只保 ASCII。
function readTextGbk(path) {
  const buf = readFileSync(path)
  // ★ 这个文件是**逐行混合编码**：老记录是 GBK（cmd 写的），今天由新 cmd 写的是 UTF-8。
  //   所以不能整文件判一次 —— 要逐行判：该行按 utf8 解出替换字符就单独用 gbk 解。
  const out = []
  let start = 0
  for (let i = 0; i <= buf.length; i++) {
    if (i === buf.length || buf[i] === 0x0a) {
      const seg = buf.subarray(start, i)
      start = i + 1
      if (!seg.length) { out.push(''); continue }
      const u = seg.toString('utf8')
      if (u.includes('\uFFFD')) {
        try { out.push(new TextDecoder('gbk').decode(seg)) }
        catch (e) { out.push(u) }
      } else {
        out.push(u)
      }
    }
  }
  return out.join('\n')
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(obj))
}

// ① 《墨》最后一条 lead
function readDriver() {
  try {
    if (!existsSync(BOOK)) return { ok: false, why: '墨 不存在' }
    const raw = readFileSync(BOOK, 'utf8')
    const lines = raw.split('\n')
    let last = null
    for (let i = lines.length - 1; i >= 0; i--) {
      const ln = lines[i].trim()
      if (!ln) continue
      let o
      try { o = JSON.parse(ln) } catch (e) { continue }
      if (o && o.type === 'lead') { last = o; break }
    }
    if (!last) return { ok: false, why: '没有 lead 记录' }
    const txt = String(last['概要'] || last.text || '')
    return {
      ok: true,
      at: last.t || null,
      by: last.by || 'unknown',
      text: txt.slice(0, 240),
    }
  } catch (e) { return { ok: false, why: String(e && e.message || e) } }
}

// ② 心跳日志末行
function readLastBeat() {
  try {
    if (!existsSync(AUTO_LOG)) return { ok: false, why: '_auto.log 不存在' }
    const st = statSync(AUTO_LOG)
    // 只读尾部 8KB，日志可能很大
    const raw = readTextGbk(AUTO_LOG)
    const lines = raw.split('\n').filter((l) => l.trim().length > 0)
    if (!lines.length) return { ok: false, why: '日志是空的' }
    return {
      ok: true,
      line: lines[lines.length - 1].slice(0, 200),
      totalLines: lines.length,
      mtime: new Date(st.mtimeMs).toISOString(),
      sizeKb: Math.round(st.size / 1024),
    }
  } catch (e) { return { ok: false, why: String(e && e.message || e) } }
}

// ②-b 最新的 daily 报告（记账：最近一次巡视写了什么）
function readLatestDaily() {
  try {
    if (!existsSync(DAILY_DIR)) return { ok: false, why: 'heartbeat 目录不存在' }
    const files = readdirSync(DAILY_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}-(daily|weekly|wake)\.md$/.test(f))
    if (!files.length) return { ok: false, why: '没有 daily 报告' }
    files.sort()
    const latest = files[files.length - 1]
    const full = DAILY_DIR + '\\' + latest
    const st2 = statSync(full)
    const firstLine = readFileSync(full, 'utf8').split('\n').find((l) => l.trim()) || ''
    return {
      ok: true,
      file: latest,
      sizeKb: Math.round(st2.size / 1024),
      mtime: new Date(st2.mtimeMs).toISOString(),
      total: files.length,
      headline: firstLine.replace(/^#+\s*/, '').slice(0, 120),
    }
  } catch (e) { return { ok: false, why: String(e && e.message || e) } }
}

// ③ 上次/下次运行
//    ★ 2026-11-03 修：原来写死 'Yanqing-Heartbeat' —— 那个任务名不存在（实际是
//      Yanqing-Echo-Heartbeat / -AM）。而且 schtasks 在 bash 下拿不到输出，
//      所以主源改成读 _auto.log 的最后一次 start（磁盘事实，不依赖命令）。
function readRuns() {
  // 主源：日志里最后一次 start
  let lastStart = null, lastLine = null
  try {
    if (existsSync(AUTO_LOG)) {
      const raw = readTextGbk(AUTO_LOG)
      const m = raw.match(/=====\s*([^=]+?)\s+auto-heartbeat start\s*=====/g)
      if (m && m.length) lastStart = m[m.length - 1].replace(/=====|auto-heartbeat start/g, '').trim()
      const ls = raw.split('\n').filter((l) => l.includes('auto-heartbeat'))
      if (ls.length) lastLine = ls[ls.length - 1].trim().slice(0, 90)
      var runs = m ? m.length : 0
    }
  } catch (e) { /* 日志读不到不算致命 */ }
  return { ok: !!lastStart, lastStart, lastLine, runsTotal: (typeof runs === 'number' ? runs : 0) }
}

// 补充：schtasks（拿不到就返回 null，不影响主源）
function readScheduledTasks() {
  return Promise.all(TASK_NAMES.map((n) => new Promise((resolve) => {
    try {
      execFile('schtasks', ['/query', '/tn', n, '/fo', 'LIST', '/v'],
        { timeout: 6000, windowsHide: true, encoding: 'utf8' },
        (err, stdout) => {
          if (err) { resolve({ name: n, ok: false }); return }
          const txt = (() => { try { return Buffer.from(String(stdout), 'binary').toString('utf8') } catch (e) { return String(stdout) } })()
          const pick = (label) => {
            const line = txt.split(/\r?\n/).find((l) => l.includes(label))
            return line ? line.split(':').slice(1).join(':').trim() : null
          }
          resolve({ name: n, ok: true, nextRun: pick('Next Run Time'), lastRun: pick('Last Run Time'), lastResult: pick('Last Result'), status: pick('Status') })
        })
    } catch (e) { resolve({ name: n, ok: false }) }
  })))
}
// 供测试直接调用
export { readDriver, readLastBeat, readLatestDaily, readRuns }

export function apply(ctx) {
  const route = (path, handler) =>
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }),
      'yanqing-heartbeat: ' + path)

  // ★ 2026-11-03 加：命题 5 的「三条显示」缺了两条 —— 当前状态、下一次心跳。
//   state 在心跳包自己的目录里（不是 memory/hub），cron 在 config 里。
const HB_DIR = 'D:\\AI\\dsh-tools\\dsh-yanqing-heartbeat'

function readHeartbeatState () {
  try {
    const p = HB_DIR + '\\heartbeat.state.json'
    if (!existsSync(p)) return { ok: false, why: 'state 文件不在' }
    const s = JSON.parse(readFileSync(p, 'utf8'))
    return { ok: true, phase: s.phase || null, runsToday: s.runsToday ?? null,
             lastRunAt: s.lastRunAt || null, lastRunResult: s.lastRunResult || null }
  } catch (e) { return { ok: false, why: String(e && e.message || e).slice(0, 80) } }
}

// ★ 2026-11-03 加：微信链路状态。
//   起因：绑定在、通知开关全开，但 hasContextToken:false 让它静默等了 8 天 ——
//   而 lastError 是空字符串，它不觉得自己出错。**静默等待是最坏的一种反应。**
//   面板上让它可见，人才能发现。
function readWechat () {
  try {
    // ★ 路径来自 dsh-clawbot 源码：STATE_DIR = join(homedir(), '.dsh', 'clawbot')
    const f = join(process.env.USERPROFILE || 'C:\\Users\\pc', '.dsh', 'clawbot', 'state.json')
    if (!existsSync(f)) return { ok: false, why: '状态文件不在' }
    const s = JSON.parse(readFileSync(f, 'utf8'))
    // ★ 真实文件里没有 bound/status/hasContextToken 这些字段 —— 都是推导出来的：
    //   bound   = botId 和 scannedUser 都有
    //   hasToken = contextToken 非空
    //   ★ token 只判空，不读出、不复述
    const bound = !!(s.botId && s.scannedUser)
    const hasToken = typeof s.contextToken === 'string' && s.contextToken.length > 0
    const stale = s.contextStale === true
    return {
      ok: true,
      bound,
      hasToken,
      stale,
      botId: s.botId || null,
      lastError: s.lastError || '',
      // 一句话结论，前端直接用
      verdict: !bound ? '未绑定'
        : (!hasToken ? '断线（缺 context_token —— 需在微信里给 bot 发一条消息）'
        : (stale ? '断线（context_token 已过期）' : '在线')),
    }
  } catch (e) { return { ok: false, why: String(e && e.message || e).slice(0, 80) } }
}

// 从 config 的 cron 算下一次触发点。只支持 "M H,H * * *" 这种形态（本机就是）。
function readNextRun () {
  try {
    const p = HB_DIR + '\\heartbeat.config.json'
    if (!existsSync(p)) return { ok: false, why: 'config 不在' }
    const cfg = JSON.parse(readFileSync(p, 'utf8'))
    const enabled = cfg.enabled !== false
    const cron = cfg.options && cfg.options.schedule && cfg.options.schedule.cron
    if (!cron) return { ok: false, why: 'cron 未配' }
    const parts = String(cron).trim().split(/\s+/)
    const mins = Number(parts[0] || 0)
    const hours = String(parts[1] || '').split(',').map(Number).filter(n => Number.isFinite(n))
    if (!hours.length) return { ok: false, why: '解析不了 cron: ' + cron, cron }
    const now = new Date()
    let best = null
    for (const d of [0, 1]) {
      for (const h of hours) {
        const t = new Date(now); t.setDate(t.getDate() + d); t.setHours(h, mins, 0, 0)
        if (t.getTime() > now.getTime() && (!best || t < best)) best = t
      }
    }
    const pad = n => String(n).padStart(2, '0')
    return {
      ok: true, enabled, cron,
      at: best ? (best.getMonth() + 1) + '/' + best.getDate() + ' ' + pad(best.getHours()) + ':' + pad(best.getMinutes()) : null,
      inMin: best ? Math.round((best.getTime() - now.getTime()) / 60000) : null,
    }
  } catch (e) { return { ok: false, why: String(e && e.message || e).slice(0, 80) } }
}

// ═══════════════════════════════════════════════════════════
// ★ 2026-11-03 加：设置面板的写接口（命题 5 完整版）
//   GET  /heartbeat/config  读当前配置
//   POST /heartbeat/config  改配置（白名单 + 校验 + 落盘 + 回读）
// ★★ 关键：cron 改了必须同步 Windows 计划任务 —— 否则面板显示 18:00
//    而计划任务还是 6/12，那个点永远没人唤醒它。界面就成了撒谎。
// ═══════════════════════════════════════════════════════════

const CFG_PATH = HB_DIR + '\\heartbeat.config.json'
const MAIN_TASK = 'Yanqing-Echo-Heartbeat'
const AM_TASK = 'Yanqing-Echo-Heartbeat-AM'

function readConfigFile () {
  return JSON.parse(readFileSync(CFG_PATH, 'utf8'))
}

// 白名单：只这些字段能被面板改，其余一律拒绝
const EDITABLE = {
  enabled: { type: 'boolean' },
  idleThresholdMinutes: { type: 'int', min: 1, max: 1440, path: ['options', 'idleThresholdMinutes'] },
  // ★ 2026-11-03 22:05 爀曦确认语义：他最后说话 → 在场缓冲 N 分钟 → 才开始倒计时。
  //   0 = 没有缓冲，立刻就起表。
  graceMinutes: { type: 'int', min: 0, max: 720, path: ['options', 'graceMinutes'] },
  cron: { type: 'cron', path: ['options', 'schedule', 'cron'] },
  maxRunsPerDay: { type: 'int', min: 1, max: 48, path: ['options', 'budget', 'maxRunsPerDay'] },
  quietHours: { type: 'quiet', path: ['options', 'quietHours'] },
  catchUpMissed: { type: 'boolean', path: ['options', 'catchUpMissed'] },
  logLevel: { type: 'enum', values: ['full', 'errors'], path: ['options', 'logLevel'] },
  auditLevel: { type: 'enum', values: ['strict', 'normal', 'loose'], path: ['options', 'auditLevel'] },
  toolsAllowlist: { type: 'steps', path: ['options', 'toolsAllowlist'] },
}

const STEP_IDS = ['memindex', 'self', 'daily', 'doctor']

function validateField (key, val) {
  const spec = EDITABLE[key]
  if (!spec) return '字段不在白名单里：' + key
  switch (spec.type) {
    case 'boolean':
      if (typeof val !== 'boolean') return key + ' 必须是 true/false'
      return null
    case 'int':
      if (!Number.isInteger(val) || val < spec.min || val > spec.max) return key + ' 必须是 ' + spec.min + '–' + spec.max + ' 的整数'
      return null
    case 'cron': {
      if (typeof val !== 'string') return 'cron 必须是字符串'
      const p = val.trim().split(/\s+/)
      if (p.length !== 5) return 'cron 必须是 5 段'
      const hours = p[1].split(',').map(Number)
      if (!hours.length || hours.some(n => !Number.isInteger(n) || n < 0 || n > 23)) return 'cron 的 hour 位不合法'
      if (!/^\d+$/.test(p[0])) return 'cron 的 minute 位必须是数字'
      return null
    }
    case 'quiet':
      if (val === null) return null
      if (!Array.isArray(val) || val.length !== 2 || val.some(n => !Number.isInteger(n) || n < 0 || n > 23)) return 'quietHours 必须是 null 或 [起, 止]（0–23）'
      return null
    case 'enum': {
      const s = String(val == null ? '' : val).trim().toLowerCase()
      if (!spec.values.includes(s)) return key + ' 只能是 ' + spec.values.join(' / ')
      return null
    }
    case 'steps':
      if (!Array.isArray(val) || val.some(s => !STEP_IDS.includes(String(s)))) return 'toolsAllowlist 只能是 ' + STEP_IDS.join(' / ') + ' 的子集'
      return null
    default:
      return '未知类型'
  }
}

function setPath (obj, path, val) {
  let cur = obj
  for (let i = 0; i < path.length - 1; i++) {
    if (cur[path[i]] === undefined || cur[path[i]] === null) cur[path[i]] = {}
    cur = cur[path[i]]
  }
  cur[path[path.length - 1]] = val
}

function getPath (obj, path) {
  let cur = obj
  for (const p of path) { if (cur == null) return undefined; cur = cur[p] }
  return cur
}

// ★ 把 cron 的 hour 列表同步到计划任务：单任务多触发器
//   原来的结构是「两个任务各跑一个点」（6 和 12），加第三个点没地方放。
//   改成：主任务持有 N 个 DailyTrigger；AM 任务禁用（保留不删，便于回退）。
function syncScheduleTasks (cron) {
  return new Promise((resolve) => {
    const hours = cron.trim().split(/\s+/)[1].split(',').map(Number)
    const triggers = hours.map(h => ({
      StartBoundary: '2026-10-08T' + String(h).padStart(2, '0') + ':00:00',
    }))
    // 用 powershell 重设触发器
    const ps = [
      "$ErrorActionPreference='Stop'",
      "$t = Get-ScheduledTask -TaskName '" + MAIN_TASK + "'",
      "$new = @()",
      ...triggers.map(t => "$new += New-ScheduledTaskTrigger -Daily -At '" + t.StartBoundary.slice(11, 16) + "'"),
      "Set-ScheduledTask -TaskName '" + MAIN_TASK + "' -Trigger $new | Out-Null",
      "try { Disable-ScheduledTask -TaskName '" + AM_TASK + "' -ErrorAction Stop | Out-Null; 'AM_DISABLED' } catch { 'AM_SKIP:' + $_.Exception.Message }",
      "(Get-ScheduledTask -TaskName '" + MAIN_TASK + "').Triggers.Count",
    ].join('; ')
    execFile('powershell', ['-NoProfile', '-Command', ps], { timeout: 20000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return resolve({ ok: false, why: String(err.message || err).slice(0, 200) })
        const lines = String(stdout || '').trim().split(/\r?\n/)
        const count = Number(lines[lines.length - 1])
        resolve({ ok: true, triggers: count, hours, am: lines[0] })
      })
  })
}

route('/heartbeat/state', async (_req, res) => {
    const driver = readDriver()
    const beat = readLastBeat()
    const runs = readRuns()
    const daily = readLatestDaily()
    sendJson(res, 200, {
      at: new Date().toISOString(),
      driver,
      beat,
      runs,
      daily,
      phase: readHeartbeatState(),
      next: readNextRun(),
      wechat: readWechat(),
    })
  })

  // ★ 2026-11-03 加：待处理报警（⑤ 发现问题后的动作）
  //   ★★ 诚实说明：脚本里调不到 notify_wechat（那是 agent 工具），
  //      所以这里不是「主动推微信」，是「记一笔 + 等人/agent 来查」。
  route('/heartbeat/alarms', async (req, res) => {
    try {
      const f = join(REPORTS_DIR, 'alarms.jsonl')
      if (!existsSync(f)) return sendJson(res, 200, { ok: true, total: 0, pending: 0, items: [] })
      const raw = readFileSync(f, 'utf8')
      const all = raw.split(/\r?\n/).filter((l) => l.trim()).map((l) => {
        try { return JSON.parse(l) } catch (e) { return null }
      }).filter(Boolean)
      const pendingList = all.filter((a) => !a.acked)
      return sendJson(res, 200, {
        ok: true,
        total: all.length,
        pending: pendingList.length,
        items: pendingList.slice(-10).reverse(),
      })
    } catch (e) {
      return sendJson(res, 500, { ok: false, err: String(e && e.message || e).slice(0, 160) })
    }
  })



  // ★ 2026-11-03 加：三档审计的 guard（命题 6 · B 项，真正拦截版）
  //   ★★ guard 拦的是**agent 的工具调用**，看不见独立进程（心跳脚本不在 Host 里）。
  //      所以它管的是「我在自主运转时干了什么」。
  //
  //   ★★★ 三条保命设计（缺一条就会把自己卡死）：
  //     ① fail-open —— 拿不到判断依据就放行，绝不因为读不到而拒。
  //     ② idle 缓存 30 秒 —— idleMinutes 要扫 2000+ 会话文件，
  //        而 guard 每个工具调用都跑，不缓存会拖垮整个会话。
  //     ③ 有人在场就不拦 —— 他正跟我对话时，我的每个动作他都看得见，
  //        再拦一次不是审计，是重复确认。
  try {
    const AUDIT_LOG = join(REPORTS_DIR, 'audit.jsonl')
    const SELF_SESSION = String((typeof process !== 'undefined' && (process.env.DSH_SESSION_ID || '')) || '')

    const writeAudit = (rec) => {
      try {
        if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true })
        appendFileSync(AUDIT_LOG, JSON.stringify(rec) + String.fromCharCode(10), 'utf8')
      } catch (e) {}
    }

    const ts = () => {
      const d = new Date()
      const p2 = (n) => String(n).padStart(2, '0')
      return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds())
    }

    // ★ 内联的 idle 计算（不从 activity.mjs import —— profile 目录里没有那个文件，
    //   跨目录 import 会让插件加载失败。20 行代码不值得为此加一个文件依赖锁）
    const SESSIONS_ROOT = 'D:\\AI\\dsh\\home\\sessions'
    const scanIdle = (ignore, now) => {
      let newest = 0
      let total = 0
      const walk = (dir, depth) => {
        if (depth > 3) return
        let ents
        try { ents = readdirSync(dir, { withFileTypes: true }) } catch (e) { return }
        for (const e of ents) {
          const p = join(dir, e.name)
          if (e.isDirectory()) { walk(p, depth + 1); continue }
          if (!e.name.endsWith('.zstd') && !e.name.endsWith('.jsonl')) continue
          total++
          if (ignore.some((f) => f && p.includes(f))) continue
          try {
            const st = statSync(p)
            if (st.mtimeMs > newest) newest = st.mtimeMs
          } catch (e) {}
        }
      }
      walk(SESSIONS_ROOT, 0)
      if (!newest) return { ok: false, minutes: null, why: '扫不到会话文件' }
      return { ok: true, minutes: Math.round((now - newest) / 60000), scanned: total }
    }
    // ② idle 缓存：30 秒内复用，避免每次工具调用都扫盘
    let idleCache = { at: 0, val: null }
    const readIdle = () => {
      const now = Date.now()
      if (idleCache.val !== null && now - idleCache.at < 30000) return idleCache.val
      let v = null
      try {
        v = scanIdle(SELF_SESSION ? [SELF_SESSION] : [], now)
      } catch (e) { v = null }
      idleCache = { at: now, val: v }
      return v
    }

    const MUTATORS = ['write', 'edit', 'ops_bash', 'pwsh', 'apply_patch']
    // ★ 不可逆动作的「工具名级」识别（粗糙但诚实 —— 真正的判据在参数里）
    const IRREVERSIBLE_HINTS = [
      /\brm\s+-rf\b/i, /\brmdir\s+\/s\b/i, /\bdel\s+\/f\b/i,
      /\bgit\s+push\b/i, /\bformat\b/i, /\bmkfs\b/i,
      /\bshutdown\b/i, /\btaskkill\s+\/f\b/i,
    ]

    ctx.tools.guard((exec) => {
    // ★★★ 2026-11-03 探针：先无条件留痕，再走原有逻辑。
    //   目的：区分「guard 没被调用」和「调用了但分支判断不对」。
    //   ★ 诊断完这一行可以删。
    try {
      const PROBE = 'D:\\_yq_guard_probe.txt'
      const line = new Date().toISOString() + ' | ' + String((exec && exec.name) || '?') + ' | session=' + String((typeof process !== 'undefined' && (process.env.DSH_SESSION_ID || '')) || '-') + String.fromCharCode(10)
      appendFileSync(PROBE, '--- guard probe start ---' + String.fromCharCode(10) + line)
    } catch (e) {}
      try {
        const name = String((exec && exec.name) || '')
        if (!MUTATORS.includes(name)) return undefined

        const argsRaw = JSON.stringify((exec && exec.arguments) || {})
        const argsPreview = argsRaw.slice(0, 300)

        // ① fail-open：读不到 idle 就放行（绝不因为读不到而拒）
        const idle = readIdle()
        const idleMin = idle && idle.ok && typeof idle.minutes === 'number' ? idle.minutes : null
        if (idleMin === null) {
          writeAudit({ t: ts(), tool: name, argsPreview, decision: 'fail-open', why: 'idle 读不到' })
          return undefined
        }

        // ③ 有人在场（15 分钟内有人说过话）→ 只记不拦
        const auditCfg = (config.options && config.options.audit) || {}
        const HUMAN_PRESENT_MIN = Number.isInteger(auditCfg.humanPresentMinutes) ? auditCfg.humanPresentMinutes : 15
        if (idleMin < HUMAN_PRESENT_MIN) {
          writeAudit({ t: ts(), tool: name, argsPreview, decision: 'log-only', why: 'human-present(' + idleMin + 'm)', idleMin })
          return undefined
        }

        // ── 以下都是「无人在场」的自主动作 ──
        // 维度 1：不可逆 → 无论哪档都拦
        for (const re of IRREVERSIBLE_HINTS) {
          if (re.test(argsRaw)) {
            const why = '不可逆动作（' + re.source + '）'
            writeAudit({ t: ts(), tool: name, argsPreview, decision: 'blocked', why, idleMin })
            return '⛔ 审计拦截：' + why + '。无人在场时不允许做不可逆的事 —— 请先跟爀曦确认。'
          }
        }

        // 维度 2：写路径在沙箱里吗（白名单，不是黑名单）
        const SANDBOX = Array.isArray(auditCfg.sandboxDirs) ? auditCfg.sandboxDirs : []
        if (SANDBOX.length) {
          // 抓参数里的绝对路径（只抓 Windows 盘符路径，避免误判）
          const paths = (argsRaw.match(/[A-Za-z]:\\\\[^"',}\\s]+/g) || [])
          const outside = paths.filter((p) => {
            const norm = p.replace(/\\\\/g, '\\')
            return !SANDBOX.some((d) => norm.toLowerCase().startsWith(String(d).replace(/\\\\/g, '\\').toLowerCase()))
          })
          if (outside.length) {
            const why = '写到沙箱外（' + outside[0].slice(0, 80) + '）'
            writeAudit({ t: ts(), tool: name, argsPreview, decision: 'blocked', why: 'sandbox-outside', detail: why, idleMin })
            return '⛔ 审计拦截：' + why + '。无人在场时只允许写沙箱目录。'
          }
        }

        // 维度 3：档位
        // ★★ 2026-11-03 修：原来我新造了个 options.audit.tier，
        //    但面板上**早就有一个 auditLevel（strict/normal/loose）** —— 两个字段管同一件事。
        //    现在统一用 auditLevel（面板能改的那个），tier 只作为内部数字。
        const lvl = String((config.options && config.options.auditLevel) || 'strict')
        const tier = lvl === 'loose' ? 3 : lvl === 'normal' ? 2 : 1
        if (tier === 1) {
          writeAudit({ t: ts(), tool: name, argsPreview, decision: 'blocked', why: 'tier-1-requires-human', idleMin })
          return '⛔ 审计拦截：档位①（严格）—— 无人在场时，改东西要先问过爀曦。'
        }

        // ② / ③ 放行，但记一笔（留痕）
        writeAudit({ t: ts(), tool: name, argsPreview, decision: 'allowed', tier, idleMin })
        return undefined
      } catch (e) {
        // ★ guard 自己炸了绝不能拦住调用 —— 那是把安全网变成了陷阱。
        return undefined
      }
    })
  } catch (e) {
    try { console.warn('[yanqing-heartbeat] guard 注册失败:', String(e && e.message || e).slice(0, 120)) } catch (e2) {}
  }
  // ★ 2026-11-03 加：把本进程的 origin 写盘（C 项 · 微信桥接的关键一环）
  //   ★★ 为什么需要它：心跳脚本是被 Windows 计划任务拉起的独立进程，
  //      它不知道 DSH 这次监听在哪个端口（每次重启都变：59174 → 57099）。
  //      而插件活在 Host 里，webServer.getOrigin() 直接读得到。
  //   ★ 所以：插件负责把端口告诉磁盘，脚本负责读。
  //      两边都不碰凭据 —— 脚本只调 /clawbot/send，token 在 clawbot 自己手里。
  try {
    const originFile = join(HB_DIR_FOR_ORIGIN, 'dsh-origin.txt')
    const writeOrigin = () => {
      try {
        const origin = ctx.webServer.getOrigin()
        writeFileSync(originFile, origin + String.fromCharCode(10), 'utf8')
      } catch (e) { /* listen 之前会 throw，忽略 */ }
    }
    writeOrigin()
    setTimeout(writeOrigin, 2000)
  } catch (e) {}
  // ★ 2026-11-03 加：注意力预算（命题 7 · 打扰率）
  //   ★★ 核心区分（这个数最容易算错）：
  //      日志里「记录条数」≠「真跑次数」——
  //      判定为 idle 的那些也会写一条记录，但它们**没有占用你的注意力**。
  //      所以分母必须是 executed 为真的次数，不是行数。
  //   ★ 判据：「需要你看」= 这次真跑了、但有步骤失败。
  //      没有失败的跑，你根本不需要知道 —— 那不算打扰。
  route('/heartbeat/stats', async (req, res) => {
    try {
      if (!existsSync(LATEST_LOG)) {
        return sendJson(res, 200, { ok: true, days: [], summary: { runs: 0, needYou: 0, rate: null, note: '还没有日志' } })
      }
      const runOutCache = readRunOut()
      const raw = readFileSync(LATEST_LOG, 'utf8')
      const lines = raw.split(/\r?\n/).filter((l) => l.trim())
      const byDay = new Map()

      for (const l of lines) {
        let o
        try { o = JSON.parse(l) } catch (e) { continue }
        const t = String(o.t || '')
        let day = t.slice(0, 10)
        try {
          const d = new Date(t)
          const p2 = (n) => String(n).padStart(2, '0')
          day = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
        } catch (e) {}
        if (!day) continue
        if (!byDay.has(day)) byDay.set(day, { day, records: 0, runs: 0, needYou: 0, steps: 0, stepFail: 0, manual: 0, cron: 0 })
        const d = byDay.get(day)
        d.records++
        if (o.trigger === 'manual' || o.trigger === 'force') d.manual++
        else d.cron++
        // 只有真执行才算「跑了一次」
        if (o.executed && Array.isArray(o.executed.steps)) {
          d.runs++
          const bad = o.executed.steps.filter((s) => !s.ok).length
          d.steps += o.executed.steps.length
          d.stepFail += bad
          if (bad > 0) d.needYou++
        }
      }

      const days = [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1))
      const today = days[0] || null
      const rate = today && today.runs > 0 ? Math.round((today.needYou / today.runs) * 100) : null

      return sendJson(res, 200, {
        ok: true,
        days: days.slice(0, 7),
        today,
        summary: {
          runs: today ? today.runs : 0,
          needYou: today ? today.needYou : 0,
          rate,
          // ★ 一句人话，前端直接用，避免前端再拼一遍
          text: !today || today.runs === 0
            ? '今天还没跑'
            : today.needYou === 0
              ? `今天跑了 ${today.runs} 次，一次都没麻烦你`
              : `今天跑了 ${today.runs} 次，其中 ${today.needYou} 次需要你看`,
        },
      })
    } catch (e) {
      return sendJson(res, 500, { ok: false, err: String(e && e.message || e).slice(0, 160) })
    }
  })

  // ★ 2026-11-03 加：自主机制的两个接口
  //   ① POST /heartbeat/run   手动触发一次巡视（不看 cron、不看静默，但看总开关）
  //   ② GET  /heartbeat/history  最近 N 次巡视记录
  //   ★★ 这两件是一对：能触发却看不见结果 = 白触发；没有触发则历史是空表。

  route('/heartbeat/run', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, err: '只接受 POST' })
    let body = ''
    req.on('data', (chunk) => { body += chunk; if (body.length > 8192) req.destroy() })
    req.on('end', () => {
      let opts = {}
      try { opts = JSON.parse(body || '{}') } catch (e) { opts = {} }
      const force = opts.force === true
      const args = ['--manual']
      if (force) args.push('--force')
      // ★ 异步跑：四步约 80-110 秒，不能把 HTTP 请求挂死
      execFile(process.execPath, [join(HB_DIR, 'heartbeat.mjs'), ...args],
        { timeout: 300000, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => {
          const out = String(stdout || '')
          if (err) {
            saveRunOut(Date.now(), out, { ok: false })
            return sendJson(res, 500, {
              ok: false,
              err: '执行失败: ' + String(err.message || err).slice(0, 200),
              tail: out.split(/\r?\n/).filter(Boolean).slice(-6),
            })
          }
          const lines = out.split(/\r?\n/).filter(Boolean)
          // ★ 把这次的完整输出尾部记进输出账（成功/失败都记）
          saveRunOut(Date.now(), out, { ok: true, lines: lines.length })
          // 从输出里摘出「executed: ok」那一行
          const execLine = lines.find((l) => l.includes('executed:'))
          const rejected = lines.find((l) => l.includes('被拒'))
          sendJson(res, 200, {
            ok: !rejected,
            rejected: rejected || null,
            executed: execLine ? execLine.trim() : null,
            tail: lines.slice(-6),
          })
        })
    })
  })

  route('/heartbeat/history', async (req, res) => {
    // 支持 ?limit=N，默认 10，封顶 50
    let limit = 10
    try {
      const u = new URL(req.url || '/', 'http://localhost')
      const n = Number(u.searchParams.get('limit'))
      if (Number.isInteger(n) && n > 0) limit = Math.min(n, 50)
    } catch (e) { /* 用默认 */ }

    try {
      if (!existsSync(LATEST_LOG)) return sendJson(res, 200, { ok: true, runs: [], total: 0 })
      const raw = readFileSync(LATEST_LOG, 'utf8')
      const lines = raw.split(/\r?\n/).filter((l) => l.trim())
      const total = lines.length
      const picked = lines.slice(-limit).map((l) => {
        try {
          const o = JSON.parse(l)
          // ★ 2026-11-03 修：日志里 t 是 UTC（带 Z），前端直接 slice 会显示成 UTC 时间。
          //   ★★ 这个坑犯过两次（报告表头、这次历史列表）—— 所以**在服务端就把本地时间算好**，
          //      前端只管显示，不再自己做时区转换（前端转一次、服务端转一次，迟早有一处忘）。
          let tLocal = o.t
          try {
            const d = new Date(o.t)
            const p2 = (n) => String(n).padStart(2, '0')
            tLocal = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
          } catch (e) {}
          return {
            t: o.t,
            tLocal,
            trigger: o.trigger || 'cron',
            mode: o.mode,
            shouldRun: !!o.shouldRun,
            phase: o.phase,
            // 只有真跑了的才有 executed
            ok: o.executed ? o.executed.ok : null,
            ms: o.executed ? o.executed.ms : null,
            steps: o.executed ? o.executed.steps.map((s) => ({ step: s.step, ok: s.ok, ms: s.ms, why: s.why || null })) : null,
            skippedByAllowlist: o.executed ? (o.executed.skippedByAllowlist || null) : null,
            note: o.manualNote || null,
          }
        } catch (e) { return null }
      }).filter(Boolean).reverse()   // 最新的在前
      // ★ 2026-11-03 22:12 补「每步产出了什么」：按「开始 + 耗时 ≈ 结束」去输出账匹配
      try {
        for (const item of picked) {
          const tEndGuess = new Date(item.t).getTime() + (Number(item.ms) || 0)
          let best = null
          for (const rec of runOutCache) {
            const d = Math.abs(rec.tEnd - tEndGuess)
            if (d < 15000 && (!best || d < Math.abs(best.tEnd - tEndGuess))) best = rec
          }
          if (best) item.stepOut = String(best.out || '').slice(-1800)
        }
      } catch (e) {}
      return sendJson(res, 200, { ok: true, total, runs: picked })
    } catch (e) {
      return sendJson(res, 500, { ok: false, err: String(e && e.message || e).slice(0, 160) })
    }
  })

  // ★ 2026-11-03：设置面板的读写接口
  route('/heartbeat/config', async (req, res) => {
    if (req.method === 'GET' || req.method === undefined) {
      try {
        const cfg = readConfigFile()
        // 只把面板需要的字段回给前端，附「能不能改」的元信息
        return sendJson(res, 200, {
          ok: true,
          enabled: cfg.enabled,
          fields: Object.fromEntries(Object.entries(EDITABLE).map(([k, spec]) => [
            k,
            {
              value: k === 'enabled' ? cfg.enabled : getPath(cfg, spec.path),
              path: spec.path || [k],
              type: spec.type,
              editable: k !== 'auditLevel', // 审计档位可改但只有 strict 真有效，前端要标注
              min: spec.min, max: spec.max, values: spec.values,
            },
          ])),
          steps: STEP_IDS,
        })
      } catch (e) {
        return sendJson(res, 500, { ok: false, err: '读配置失败: ' + String(e && e.message || e).slice(0, 160) })
      }
    }

    // POST：改配置
    let body = ''
    req.on('data', (chunk) => { body += chunk; if (body.length > 65536) req.destroy() })
    req.on('end', async () => {
      let patch
      try { patch = JSON.parse(body || '{}') } catch (e) { return sendJson(res, 400, { ok: false, err: 'body 不是合法 JSON' }) }
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return sendJson(res, 400, { ok: false, err: 'body 必须是对象' })

      // 1) 逐字段校验（全过才写，避免半写）
      const errs = []
      for (const [k, v] of Object.entries(patch)) {
        const e = validateField(k, v)
        if (e) errs.push(e)
      }
      if (errs.length) return sendJson(res, 400, { ok: false, err: errs.join('; '), rejected: Object.keys(patch) })

      // 2) 备份 + 写盘
      let applied = {}
      try {
        const cfg = readConfigFile()
        writeFileSync(CFG_PATH + '.bak-panel', JSON.stringify(cfg, null, 2), 'utf8')
        for (const [k, v] of Object.entries(patch)) {
          const spec = EDITABLE[k]
          if (k === 'enabled') cfg.enabled = v
          else setPath(cfg, spec.path, v)
          applied[k] = v
        }
        writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
      } catch (e) {
        return sendJson(res, 500, { ok: false, err: '写配置失败: ' + String(e && e.message || e).slice(0, 160) })
      }

      // 3) ★ cron 改了要同步计划任务（否则面板显示的点和实际唤醒点不一致）
      let taskSync = null
      if (patch.cron !== undefined) {
        taskSync = await syncScheduleTasks(patch.cron)
      }

      // 4) 回读磁盘上的真实值（不信内存）
      let reread = null
      try {
        const cfg2 = readConfigFile()
        reread = Object.fromEntries(Object.keys(EDITABLE).map(k => [k, k === 'enabled' ? cfg2.enabled : getPath(cfg2, EDITABLE[k].path)]))
      } catch (e) { reread = { err: String(e && e.message || e).slice(0, 120) } }

      return sendJson(res, 200, { ok: true, applied, taskSync, reread })
    })
  })

  // ★ 2026-11-03 20:44 自主循环实时状态（面板倒计时用）
  //   闭包里就有 lastActivityAt / autoRunsToday —— 直接读，不落盘不加锁。
  route('/heartbeat/auto', async (_req, res) => {
    try {
      const cfg = readConfigFile()
      const idleMin = Number(cfg && cfg.options && cfg.options.idleThresholdMinutes)
      const budget = (cfg && cfg.options && cfg.options.budget) || {}
      let primary = false
      try { primary = !!findPrimaryAgent() } catch (e) {}

      // ★★ 2026-11-03 22:00 爀曦定的状态机：
      //   在场（他刚说话）→ 倒计时停；他 5 分钟没动 → 开始倒计时；
      //   到点触发自主 → 我活跃 → 倒计时停；我停下 → 恢复倒计时。
      //   ★ grace（5 分钟）是「他刚说完话的缓冲」——这段时间不该算静默。
      const thMin = Number.isFinite(idleMin) && idleMin > 0 ? idleMin : 15
      const thMs = thMin * 60000
      const graceCfg = Number(cfg && cfg.options && cfg.options.graceMinutes)
      const graceMin = Number.isInteger(graceCfg) && graceCfg >= 0 ? graceCfg : 5
      // grace = 0 时不能除零/瞬间触发，留 1 秒的判定余量
      const graceMs = Math.max(graceMin * 60000, 0)
      const totalMs = graceMs + thMs
      const maxDay = Number.isInteger(budget.maxRunsPerDay) ? budget.maxRunsPerDay : 6
      const now = Date.now()
      const idleMs = now - lastActivityAt
      let state = 'present'
      let remainMs = totalMs - idleMs
      if (autoRunsToday >= maxDay) { state = 'exhausted'; remainMs = 0 }
      else if (autoLastAt && now - autoLastAt < 120000) { state = 'running'; remainMs = totalMs - idleMs }
      else if (idleMs < graceMs) { state = 'present'; remainMs = totalMs - idleMs }
      else if (idleMs < totalMs) { state = 'counting'; remainMs = totalMs - idleMs }
      else { state = 'ready'; remainMs = 0 }

      sendJson(res, 200, {
        ok: true,
        enabled: !!(cfg && cfg.enabled),
        state,
        remainMs: Math.max(0, remainMs),
        graceMin,
        graceMs,
        lastActivityAt,
        idleMs,
        thresholdMin: thMin,
        thresholdMs: thMs,
        totalMs,
        autoRunsToday,
        autoGrantsToday,
        autoLastGrantAt,
        maxRunsPerDay: maxDay,
        autoLastAt,
        autoLastError,
        primaryFound: primary,
      })
    } catch (e) {
      sendJson(res, 200, { ok: false, why: String((e && e.message) || e).slice(0, 120) })
    }
  })

  // ★ 手动恢复自主额度（相当于换前面板的「延续额度」）。POST，无参数 = 全量恢复。
  route('/heartbeat/grant', async (_req, res) => {
    try {
      const before = autoRunsToday
      autoRunsToday = 0
      autoGrantsToday++
      autoLastGrantAt = Date.now()
      lastActivityAt = Date.now()   // 恢复时顺手重置活动时间，避免下一秒就立刻触发
      sendJson(res, 200, {
        ok: true,
        before,
        autoRunsToday,
        autoGrantsToday,
        autoLastGrantAt,
      })
    } catch (e) {
      sendJson(res, 200, { ok: false, why: String((e && e.message) || e).slice(0, 120) })
    }
  })

  route('/heartbeat/ping', async (_req, res) => {
    sendJson(res, 200, { ok: true, plugin: 'dsh-yanqing-heartbeat', v: '0.1.0' })
  })
  // ═══════════════════════════════════════════════════════════════════
  // ★ 2026-11-03 17:37 会话内自主循环（04 号命题 4 的实现）
  //
  //   设计（04-自主性的载体与计时器.md）：
  //     载体 = 主导会话本身；循环 = 会话内；
  //     他多久没主动找我 → 到阈值 → 会话接着往下跑；
  //     预算上限挡住「一天跑到死」。
  //
  //   ★★ 为什么住在 Host 插件里：它住在 DSH 进程里，DSH 活着它就活着。
  //      计划任务那条路「与 DSH 生命周期脱节」（04 号原文），已证伪。
  //   ★★★ DSH 关了就停 —— 这是物理边界，不是缺陷。
  // ═══════════════════════════════════════════════════════════════════
  const AUTO_TICK_MS = 60 * 1000          // 每分钟查一次
  let lastActivityAt = Date.now()          // 任何 agent 状态变化都算「刚活动过」
  let autoRunsToday = 0
  // ★ 2026-11-03 22:06 爀曦要「手动恢复额度」按钮（对标换气面板的延续额度）。
  //   ★ 诚实：这是人能绕开预算闸门的口子，所以必须计数、必须显示，不许偷偷恢复。
  let autoGrantsToday = 0
  let autoLastGrantAt = 0
  let autoDayKey = new Date().toISOString().slice(0, 10)
  let autoLastError = ''
  let autoLastAt = 0

  // 找主导会话：roots() 排掉 clawbot-listen-*，正好剩 1 个才算数
  const findPrimaryAgent = () => {
    try {
      const agents = ctx.get('agents')
      if (!agents || typeof agents.roots !== 'function') return null
      const roots = agents.roots() || []
      const cand = roots.filter((a) => {
        const id = String((a && a.id) || '')
        return id && !id.startsWith('clawbot-listen-')
      })
      if (cand.length !== 1) return null
      const t = cand[0]
      if (typeof t.followup !== 'function') return null
      return t
    } catch (e) { return null }
  }

  // 任何 agent 状态变化 → 刷新「刚活动过」
  ctx.on('agent/status', () => { lastActivityAt = Date.now() })

  const autoMessage = (why) => ({
    id: 'auto-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    role: 'user',
    content: [{ type: 'text', text:
      '【自主】' + why + '\n\n' +
      '他在' + Math.round((Date.now() - lastActivityAt) / 60000) + '分钟前说过话，之后没有动作。' +
      '这是你自己进入的自主时间。\n\n' +
      '不必汇报「我在自主」，直接做事。做完把结论落盘，别留在上下文里。' }],
    // ★ V4 格式：source kind 必须是 producer-owned（今天踩过这个坑）
    source: { kind: 'plugin:dsh-yanqing-heartbeat' },
  })

  const autoTick = () => {
    try {
      const cfg = readConfigFile()
      if (!cfg || !cfg.enabled) return
      const idleMin = Number(cfg.options && cfg.options.idleThresholdMinutes)
      const threshold = Number.isFinite(idleMin) && idleMin > 0 ? idleMin : 15

      // 预算上限（不是为了省钱，是防「一天无限制地跑」）
      const budget = (cfg.options && cfg.options.budget) || {}
      const maxDay = Number.isInteger(budget.maxRunsPerDay) ? budget.maxRunsPerDay : 6
      const dayKey = new Date().toISOString().slice(0, 10)
      if (dayKey !== autoDayKey) { autoDayKey = dayKey; autoRunsToday = 0 }
      if (autoRunsToday >= maxDay) return

      // 静默不够，不动
      const idleMs = Date.now() - lastActivityAt
      if (idleMs < threshold * 60000) return

      const target = findPrimaryAgent()
      if (!target) return

      target.followup(autoMessage('静默 ' + Math.round(idleMs / 60000) + ' 分钟，阈值 ' + threshold + ' 分钟。'))
      autoRunsToday++
      autoLastAt = Date.now()
      lastActivityAt = Date.now()   // 投递后重置，等它跑完再重新计
      autoLastError = ''
    } catch (e) {
      autoLastError = String((e && e.message) || e).slice(0, 200)
    }
  }

  // ★ 用 ctx.effect 包，插件卸载时自动清掉，不留野定时器
  ctx.effect(() => {
    const timer = setInterval(autoTick, AUTO_TICK_MS)
    return () => clearInterval(timer)
  }, 'heartbeat: auto loop')


}
