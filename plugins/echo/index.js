// dsh-yanqing-echo —— 宿主半 v2（仪表盘版）
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

export const name = 'dsh-yanqing-echo'
// ★ 只声明真正用到的服务。多写一个不存在的服务名 → 一直等 → apply 永不执行（静默失效）。
export const inject = ['webServer']

const NODE = 'C:/Users/pc/.workbuddy/binaries/node/versions/22.22.2-3/node.exe'
const HUB = 'D:/AI/memory/hub'
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
const DSH_HOME = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
  ? process.env.DSH_HOME
  : 'D:/AI/dsh/home'
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
    const out = path.join(os.tmpdir(), `yq-echo-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
    let fd
    try { fd = fs.openSync(out, 'w') } catch (e) { return resolve({ ok: false, error: 'open tmp: ' + e.message }) }
    let done = false
    const finish = (r) => {
      if (done) return
      done = true
      try { fs.closeSync(fd) } catch { /* */ }
      let txt = ''
      try { txt = fs.readFileSync(out, 'utf8') } catch { /* */ }
      try { fs.unlinkSync(out) } catch { /* */ }
      resolve(Object.assign(r, { text: txt }))
    }
    let child
    try {
      child = spawn(NODE, [script, ...args], { stdio: ['ignore', fd, 'ignore'], windowsHide: true })
    } catch (e) { return finish({ ok: false, error: 'spawn: ' + e.message }) }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* */ }
      finish({ ok: false, error: `超时（${timeoutMs}ms）` })
    }, timeoutMs)
    child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, error: 'spawn error: ' + e.message }) })
    child.on('exit', () => { clearTimeout(timer); finish({ ok: true }) })
  })
}

function parseReport(r, mode) {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
  if (!r.ok) {
    return {
      at: stamp, mode, overall: 'error', counts: { error: 1, warn: 0, ok: 0, pending: 0 }, ms: 0,
      checks: [{ id: 'doctor', label: '体检器本身', status: 'error', detail: '跑不起来：' + r.error, evidence: { script: DOCTOR } }],
    }
  }
  try { return JSON.parse(r.text) } catch (e) {
    return {
      at: stamp, mode, overall: 'error', counts: { error: 1, warn: 0, ok: 0, pending: 0 }, ms: 0,
      checks: [{ id: 'doctor', label: '体检器本身', status: 'error', detail: '输出不是 JSON：' + e.message, evidence: { head: String(r.text).slice(0, 300) } }],
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
