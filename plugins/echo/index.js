// dsh-agent-echo —— 宿主半 v2（仪表盘版）
// ============================================================================
// v1 能体检，但每次要 10-20 秒，面板打开就是干等。
// v2（爀曦 2026-10-08 04:42 要求）：像任务管理器那样实时，并且分四级轮询：
//     1 级 = 5 分钟 ｜ 2 级 = 10 分钟 ｜ 3 级 = 30 分钟（默认）｜ 4 级 = 只手动
//
// ★★★ 架构（「实时感」的来源）：
//     **面板读缓存，后台按等级体检。** 客户端 2 秒拉一次 /api/status 只是读内存（微秒级），
//     永远不会等体检；体检由插件自己的定时器在后台做，做完替换缓存。
//     · 快检（约 0.9s）：不解日志 —— 会话日志/索引/SELF/心跳/《墨》/热记忆/漂移/身份
//     · 深检（约 9.5s）：解一次日志 —— 门牌实测 + 压缩统计
//     合并后交给面板：深度项用深检结果覆盖，其余用快检结果，各自带时间戳。
//
// ★★ 两条纪律，一条都没省：
//   ① **体检跑在子进程里** —— 绝不在 DSH 主进程同步解 74MB 日志，那会把所有会话一起卡住。
//   ② **体检逻辑只有一份**（D:\AI\memory\hub\echo-doctor.mjs），命令行与面板共用。
// ============================================================================

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-agent-echo'
// ★ 只声明真正用到的服务。多写一个不存在的服务名 → 一直等 → apply 永不执行（静默失效）。
export const inject = ['webServer']

// ★★★ 路径：全部可由环境变量覆盖，默认值来自 DSH_HOME（2026-10-22 全面验证报告 P1-3）。
//
//   ★ 顺序要紧：DSH_HOME 必须定义在 NODE/HUB **之前** —— 原来它在下面十几行，
//   而 HUB 现在要用它。这和 install.js 那个 scan bug 是同一个形状：
//   **注释、变量名、类型都对，只有先后顺序错**，读的时候眼睛会顺着往下走、不回头。
//
//   ★★ 兜底不能写作者机器（2026-10-23 全库扫出来的）：原来这里是 `: 'D:/AI/dsh/home'`。
//   作者机器上 DSH_HOME 设在 User 环境变量里，所以这一行**从来没被执行过** ——
//   它只在**别人的机器**上生效，而那里这个目录根本不存在：
//   HUB 会跟着推成 `不存在的地方/hub`，doctor 报 spawn ENOENT、版本漂移报「一个脚本都没扫到」。
//   ★ 用一个「作者机器上永远走不到、别人机器上一定走错」的常量当兜底，比没有兜底更坏 ——
//   因为本机测不出来。
//   DSH 的标准位置是 `~/.dsh`（本机实测 `C:\Users\pc\.dsh` 也存在），所以兜底用它。
const DSH_HOME = (process.env.DSH_HOME || process.env.ECHO_DSH_HOME || '').trim()
  || path.join(os.homedir(), '.dsh')

/**
 * ★★ NODE —— 2026-10-23 实机验收 E1：**Electron 里 `process.execPath` 不是 node。**
 *
 * 桌面端跑插件时 `process.execPath` 是 `DeepSeek Harness.exe`。拿它去 spawn
 * `echo-doctor.mjs`，**不会报错** —— 只会永远收到空 stdout。面板上看到的症状是
 * 「体检一项都不出」，而不是「子进程起不来」，所以查起来会往错的方向走。
 *
 * 判据：`process.versions.electron` 存在 ⇒ 我们在 Electron 里，execPath 是宿主 exe。
 * 那时先按已知布局试 DSH 自带的 node，再退到一次**限深度**的浅扫描。
 * 实在找不到就返回 execPath（保留旧行为）—— **让 spawn 报 ENOENT 也比静默空好**。
 */
function resolveNode() {
  const override = (process.env.ECHO_NODE || '').trim()
  if (override !== '') return override
  if (process.versions.electron === undefined) return process.execPath

  const root = path.dirname(process.execPath)
  // 已知布局（实机验收报告 E1 给出的路径形状），先直接试，省掉一次扫描
  const guesses = [
    path.join(root, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
    path.join(root, 'resources', 'runtime', 'bin', 'node.exe'),
  ]
  for (const g of guesses) {
    try { if (fs.statSync(g).isFile()) return g } catch { /* 没有就下一个 */ }
  }

  // 布局变了就浅扫一次：只走 resources 下面，深度 <= 6，跳过明显的非运行时目录
  const found = []
  const walk = (dir, depth) => {
    if (depth > 6 || found.length > 0) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isFile() && /^node(\.exe)?$/i.test(e.name)) { found.push(full); return }
      if (e.isDirectory() && !/^(node_modules|cache|Cache|logs|GPUCache)$/i.test(e.name)) walk(full, depth + 1)
    }
  }
  walk(path.join(root, 'resources'), 0)
  return found.length > 0 ? found[0] : process.execPath
}

/**
 * ★★ HUB —— 2026-10-23 实机验收 E2：`$DSH_HOME/hub` 在别人机器上不存在。
 *
 * 安装时 `kit/echo/*.mjs` 被复制进「记忆中枢/hub」，而那和 DSH_HOME **没有固定关系**
 * （作者机器上一个在 `dsh/home`、一个在 `memory/hub`，压根不在同一棵树里）。
 * 原来直接拼 `$DSH_HOME/hub`，于是 doctor 路径指向空气：spawn 报 ENOENT、
 * 版本漂移报「一个脚本都没扫到」——**两个症状都是「空」，不是「错」**。
 *
 * 现在的判据反过来：**不猜目录，先确认 `echo-doctor.mjs` 真的在那儿。**
 * 候选依次是 ECHO_HUB、$DSH_HOME/hub、~/.dsh/hub，以及 echo.config.json 里的 memory/hub。
 */
function resolveHub() {
  const cands = []
  const push = (v) => {
    const s = (v === undefined || v === null) ? '' : String(v).trim()
    if (s !== '' && !cands.includes(s)) cands.push(s)
  }
  push(process.env.ECHO_HUB)
  push(path.join(DSH_HOME, 'hub'))
  push(path.join(os.homedir(), '.dsh', 'hub'))
  // echo.config.json —— 和 echo-config.mjs 共用同一个约定（放在 hub 目录里）
  for (const c of cands.slice()) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(c, 'echo.config.json'), 'utf8'))
      if (cfg.memory) push(path.join(String(cfg.memory), 'hub'))
    } catch { /* 没配就是没配 */ }
  }
  for (const c of cands) {
    try { if (fs.statSync(path.join(c, 'echo-doctor.mjs')).isFile()) return c } catch { /* 下一个 */ }
  }
  // 全都不在：保留旧行为（让上层的 spawn 去报可见的错误），启动日志会把它喊出来
  return cands[0] || path.join(DSH_HOME, 'hub')
}

// ★ NODE —— 见 resolveNode()（Electron 下不能直接用 execPath）
const NODE = resolveNode()
// ★ HUB —— 见 resolveHub()（先确认 echo-doctor.mjs 存在，不猜目录）
const HUB = resolveHub()
const DOCTOR = path.join(HUB, 'echo-doctor.mjs')
const MEMINDEX = path.join(HUB, 'memindex.mjs')
const SELFMJS = path.join(HUB, 'self.mjs')
const CFG = path.join(HUB, 'echo-panel.json')

/**
 * ★★ 换气检测层（2026-10-19 加）
 *
 * 换气插件每一轮结束往 `state/huanqi-turns.jsonl` 写一条判词，这里只负责读。
 * 两边的契约就是一个 JSONL：换气不认识回声，回声也不需要换气的任何内部状态。
 *
 * 为什么不让换气直接暴露 HTTP 路由、由面板去拉？
 *   · 换气是「守卫」，它越少依赖别人越好 —— 守卫不该为了被看见而引入 web 依赖
 *   · 落盘还有个额外好处：**进程重启、面板没开的时候，那段历史也还在**
 */
const HUANQI_STATE = path.join(DSH_HOME, 'state')
const HUANQI_TURNS = path.join(HUANQI_STATE, 'huanqi-turns.jsonl')
const HUANQI_LEDGER = path.join(HUANQI_STATE, 'dsh-huanqi.json')
/** 面板两秒拉一次 status，别每次都把整个 JSONL 读一遍。 */
const HUANQI_CACHE_MS = 2000
let huanqiCache = { at: 0, key: '', value: null }

/**
 * 读换气账本 + 最近若干轮判词。
 *
 * ★ 返回的 `turns` 是**最新的在前** —— 面板要的是「刚才那一轮发生了什么」，
 *   不是「最早那一轮」。
 * ★ 坏行直接跳过：JSONL 的价值就在于一行坏了不牵连别人。
 */
function readHuanqi(limit) {
  const key = String(limit)
  const now = Date.now()
  if (huanqiCache.value !== null && huanqiCache.key === key && now - huanqiCache.at < HUANQI_CACHE_MS) {
    return huanqiCache.value
  }

  const out = {
    turnsPath: HUANQI_TURNS,
    ledgerPath: HUANQI_LEDGER,
    exists: false,
    total: 0,
    turns: [],
    byVerdict: {},
    lastHour: 0,
    firstAt: null,
    lastAt: null,
    ledger: null,
    ledgerAgeMs: null,
  }

  try {
    const raw = fs.readFileSync(HUANQI_TURNS, 'utf8')
    out.exists = true
    const all = []
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try { all.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
    }
    out.total = all.length
    out.turns = all.slice(-limit).reverse()
    for (const t of all) {
      const head = String(t && t.verdict ? t.verdict : '?').split(':')[0]
      out.byVerdict[head] = (out.byVerdict[head] || 0) + 1
    }
    if (all.length > 0) {
      out.firstAt = all[0].t ?? null
      out.lastAt = all[all.length - 1].t ?? null
    }
    const cutoff = now - 3600_000
    out.lastHour = all.filter((t) => Date.parse(t && t.t ? t.t : '') >= cutoff).length
  } catch {
    // 文件还不存在 —— 换气一次都还没跑过，或还没重启加载新版
  }

  try {
    const st = fs.statSync(HUANQI_LEDGER)
    out.ledgerAgeMs = now - st.mtimeMs
    out.ledger = JSON.parse(fs.readFileSync(HUANQI_LEDGER, 'utf8'))
  } catch { /* 账本还没有也正常 */ }

  huanqiCache = { at: now, key, value: out }
  return out
}

/** 四级：分钟数。0 = 不自动跑（只手动）。默认 3 级。 */
const LEVEL_MIN = { 1: 5, 2: 10, 3: 30, 4: 0 }
const DEEP_FACTOR = 2          // 深检间隔 = 快检间隔 × 2
const TICK_MS = 5000

const state = {
  level: 3,
  fast: null, fastAt: 0,
  deep: null, deepAt: 0,
  history: [],
  busy: false,
}

function loadCfg() {
  try {
    const j = JSON.parse(fs.readFileSync(CFG, 'utf8'))
    if (LEVEL_MIN[j.level] !== undefined) state.level = j.level
  } catch { /* 第一次跑没有这个文件，正常 */ }
}
function saveCfg() {
  try { fs.writeFileSync(CFG, JSON.stringify({ level: state.level, updatedAt: new Date().toISOString() }, null, 2), 'utf8') } catch { /* */ }
}

/** 起子进程跑一个 node 脚本，输出走**文件**（不用管道 —— 本机踩过受限环境管道 EPERM 的坑）。 */
function runNode(script, args, timeoutMs) {
  return new Promise((resolve) => {
    const tag = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const out = path.join(os.tmpdir(), `yq-echo-${tag}.txt`)
    // ★★ 2026-10-23：stderr 也必须接住，而且同样走文件。
    //
    //   原来这里是 stdio: ['ignore', fd, 'ignore'] —— stderr 直接丢。
    //   后果实测：把新版 echo-doctor 换上去、但没换它 import 的 echo-config.mjs 时，
    //   doctor 在**模块加载阶段**就崩了（ERR_MODULE_NOT_FOUND），
    //   什么都还没来得及往 stdout 写。面板那侧只能看到「输出是空的」，
    //   于是报「输出不是 JSON：Unexpected end of JSON input」——**真正的原因一个字都没露**。
    //
    //   ★ 同时还漏了 exit code：原来的 on('exit') 不管退出码是多少都判 ok。
    //   于是「进程崩了」和「跑完了但没输出」看起来一模一样。
    //   这两处一起修，判据才立得住：**非零退出码就是失败，并把 stderr 原样报出来。**
    const errFile = path.join(os.tmpdir(), `yq-echo-err-${tag}.txt`)
    let fd, fdErr
    try {
      fd = fs.openSync(out, 'w')
      fdErr = fs.openSync(errFile, 'w')
    } catch (e) {
      try { if (fd !== undefined) fs.closeSync(fd) } catch { /* */ }
      return resolve({ ok: false, error: 'open tmp: ' + e.message, text: '', stderr: '' })
    }
    let done = false
    const finish = (r) => {
      if (done) return
      done = true
      try { fs.closeSync(fd) } catch { /* */ }
      try { fs.closeSync(fdErr) } catch { /* */ }
      let txt = ''
      let errTxt = ''
      try { txt = fs.readFileSync(out, 'utf8') } catch { /* */ }
      try { errTxt = fs.readFileSync(errFile, 'utf8') } catch { /* */ }
      try { fs.unlinkSync(out) } catch { /* */ }
      try { fs.unlinkSync(errFile) } catch { /* */ }
      resolve(Object.assign(r, { text: txt, stderr: errTxt }))
    }
    let child
    try {
      child = spawn(NODE, [script, ...args], { stdio: ['ignore', fd, fdErr], windowsHide: true })
    } catch (e) { return finish({ ok: false, error: 'spawn: ' + e.message }) }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* */ }
      finish({ ok: false, error: `超时（${timeoutMs}ms）` })
    }, timeoutMs)
    child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, error: 'spawn error: ' + e.message }) })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) return finish({ ok: true })
      finish({ ok: false, error: `退出码 ${code}${signal ? ' (signal ' + signal + ')' : ''}` })
    })
  })
}

function parseReport(r, mode) {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
  // ★ stderr 只留尾巴 —— 它是给人看「为什么起不来」的，不是日志
  const errTail = String(r.stderr || '').trim().slice(-800)
  if (!r.ok) {
    return {
      at: stamp, mode, overall: 'error', counts: { error: 1, warn: 0, ok: 0, pending: 0 }, ms: 0,
      checks: [{
        id: 'doctor', label: '体检器本身', status: 'error',
        detail: '跑不起来：' + r.error + (errTail ? ' ｜ stderr：' + errTail.split('\n').pop() : ''),
        evidence: { script: DOCTOR, stderr: errTail || null, stdout: String(r.text || '').slice(0, 300) || null },
      }],
    }
  }
  try { return JSON.parse(r.text) } catch (e) {
    return {
      at: stamp, mode, overall: 'error', counts: { error: 1, warn: 0, ok: 0, pending: 0 }, ms: 0,
      checks: [{
        id: 'doctor', label: '体检器本身', status: 'error',
        detail: '输出不是 JSON：' + e.message + (errTail ? ' ｜ stderr：' + errTail.split('\n').pop() : ''),
        evidence: { head: String(r.text).slice(0, 300), stderr: errTail || null },
      }],
    }
  }
}

/** 快检：约 0.9 秒。 */
async function runFast(reason) {
  const rep = parseReport(await runNode(DOCTOR, ['--json', '--fast'], 60_000), 'fast')
  state.fast = rep
  state.fastAt = Date.now()
  state.history.push({ t: rep.at, error: rep.counts.error, warn: rep.counts.warn, ok: rep.counts.ok, ms: rep.ms, why: reason })
  if (state.history.length > 60) state.history.shift()
  return rep
}

/** 深检：约 9.5 秒。 */
async function runDeep(reason) {
  const rep = parseReport(await runNode(DOCTOR, ['--json'], 180_000), 'deep')
  state.deep = rep
  state.deepAt = Date.now()
  state.deepReason = reason
  return rep
}

/** 合并：深度项用深检结果覆盖，其余保留快检结果。 */
function merged() {
  if (!state.fast) {
    return {
      at: null, mode: 'warming', overall: 'info', counts: { error: 0, warn: 0, ok: 0, pending: 10 },
      checks: [], warming: true, level: state.level, levelMin: LEVEL_MIN[state.level],
      history: state.history, fastAgeMs: null, deepAgeMs: null, busy: state.busy,
    }
  }
  const base = JSON.parse(JSON.stringify(state.fast))
  if (state.deep) {
    for (const d of state.deep.checks) {
      const i = base.checks.findIndex((c) => c.id === d.id)
      if (i >= 0) base.checks[i] = d
    }
  }
  const order = { error: 0, warn: 1, ok: 2, info: 3 }
  const judged = base.checks.filter((c) => c.status !== 'info')
  base.overall = judged.reduce((a, c) => (order[c.status] < order[a] ? c.status : a), 'ok')
  base.counts = {
    error: judged.filter((c) => c.status === 'error').length,
    warn: judged.filter((c) => c.status === 'warn').length,
    ok: judged.filter((c) => c.status === 'ok').length,
    pending: base.checks.filter((c) => c.status === 'info').length,
  }
  const iv = LEVEL_MIN[state.level]
  base.mode = state.deep ? 'merged' : 'fast-only'
  base.level = state.level
  base.levelMin = iv
  base.history = state.history
  base.busy = state.busy
  base.fastAgeMs = Date.now() - state.fastAt
  base.deepAgeMs = state.deepAt ? Date.now() - state.deepAt : null
  base.nextFastInMs = iv ? Math.max(0, iv * 60000 - (Date.now() - state.fastAt)) : null
  base.nextDeepInMs = iv ? Math.max(0, iv * 60000 * DEEP_FACTOR - (state.deepAt ? Date.now() - state.deepAt : 0)) : null
  return base
}

/** 后台节拍：按等级决定该不该跑。 */
async function tick() {
  if (state.busy) return
  const iv = LEVEL_MIN[state.level]
  if (!iv) return                                   // 4 级：只手动
  const fastMs = iv * 60000
  const deepMs = fastMs * DEEP_FACTOR
  const needFast = Date.now() - state.fastAt >= fastMs
  const needDeep = Date.now() - state.deepAt >= deepMs
  if (!needFast && !needDeep) return
  state.busy = true
  try {
    if (needFast) await runFast('auto')
    if (needDeep) await runDeep('auto')
  } finally { state.busy = false }
}

/** 手动：快检 + 深检各一次。 */
async function scanNow() {
  if (state.busy) return { ok: false, busy: true }
  state.busy = true
  try {
    await runFast('manual')
    await runDeep('manual')
    return { ok: true }
  } finally { state.busy = false }
}

/** 重建索引 + 装配 SELF（要有显式动作才跑）。 */
async function rebuild() {
  const steps = []
  const t0 = Date.now()
  const a = await runNode(MEMINDEX, ['build'], 600_000)
  steps.push({ step: 'memindex build', ok: a.ok, tail: a.ok ? String(a.text).trim().split('\n').slice(-3).join(' ｜ ') : a.error })
  const b = await runNode(SELFMJS, [], 120_000)
  steps.push({ step: 'self.mjs 装配', ok: b.ok, tail: b.ok ? String(b.text).trim().split('\n').slice(-2).join(' ｜ ') : b.error })
  state.fastAt = 0; state.deepAt = 0          // 让下一拍重新体检
  return { ok: steps.every((s) => s.ok), ms: Date.now() - t0, steps }
}

const json = (res, code, obj) => {
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(obj))
}

export function apply(ctx) {
  loadCfg()

  // ★ 后台节拍：插件活着就一直跑。
  const timer = setInterval(() => { tick().catch(() => { /* */ }) }, TICK_MS)
  if (typeof timer.unref === 'function') timer.unref()
  // 起来先跑一次快检 —— 面板第一次打开就有东西看，不用等
  setTimeout(() => { runFast('boot').catch(() => { /* */ }) }, 300)

  ctx.webServer.register({
    kind: 'prefix',
    path: '/yanqing-echo',
    handler: async (req, res) => {
      // 桌面端（Electron）页面 origin 是 file:// 或 app://，必须放行跨域。
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'content-type')
      if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end() }

      let url
      try { url = new URL(req.url, 'http://127.0.0.1:19387') } catch { return json(res, 400, { error: 'bad url' }) }
      const p = url.pathname.replace(/^\/yanqing-echo/, '') || '/'

      try {
        if (p === '/api/status' || p === '/') return json(res, 200, merged())

        if (p === '/api/level' && req.method === 'POST') {
          const n = Number(url.searchParams.get('n'))
          if (LEVEL_MIN[n] === undefined) return json(res, 400, { error: 'level must be 1..4' })
          state.level = n
          saveCfg()
          return json(res, 200, { ok: true, level: n, everyMin: LEVEL_MIN[n], note: n === 4 ? '手动模式：不再自动体检' : null })
        }

        if (p === '/api/scan' && req.method === 'POST') {
          const r = await scanNow()
          return json(res, 200, Object.assign(r, { snapshot: merged() }))
        }

        if (p === '/api/rebuild' && req.method === 'POST') return json(res, 200, await rebuild())

        if (p === '/api/huanqi') {
          const n = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 60))
          return json(res, 200, readHuanqi(n))
        }

        if (p === '/api/health') {
          return json(res, 200, {
            ok: true, doctor: fs.existsSync(DOCTOR), node: NODE,
            level: state.level, levelMin: LEVEL_MIN[state.level],
            fastAgeMs: state.fastAt ? Date.now() - state.fastAt : null,
            deepAgeMs: state.deepAt ? Date.now() - state.deepAt : null,
            busy: state.busy, historyLen: state.history.length,
          })
        }
        return json(res, 404, { error: 'no such route: ' + p })
      } catch (e) {
        return json(res, 500, { error: String((e && e.message) || e) })
      }
    },
  })
}
