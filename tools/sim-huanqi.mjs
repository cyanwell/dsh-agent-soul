/**
 * 换气治疗层 · 离线仿真测试
 * ==========================
 *
 * 目的：不碰真实会话、不碰真实账本，直接调用插件的 `apply()`，
 * 手动 dispatch `session/event` 制造「空回合」，验证两条治疗路径：
 *   ① 累计截断到阈值 → 范围压缩（compactRegion）
 *   ② 额度耗尽 → 熔断 + 全量压缩（compactNow）
 *
 * ★ 所有落盘都指向临时 DSH_HOME，跑完删掉。
 */

import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

// ── 临时 HOME（必须在 import 插件前设，apply 里会读它算 stateDir）────────
const SIM_HOME = mkdtempSync(join(tmpdir(), 'huanqi-sim-'))
process.env.DSH_HOME = SIM_HOME

// ★ Windows 下动态 import 必须用 file:// URL，不能直接给盘符路径
//   （ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'd:'）
const LIB = new URL('../plugins/huanqi/lib/index.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '')
const mod = await import(pathToFileURL(LIB).href)

// ── 采集器 ────────────────────────────────────────────────────────────
const handlers = {}
const compactionCalls = []
const sent = []
const logs = []

const SIM_SID = 'sim-session-001'

const session = {
  id: SIM_SID,
  meta: {},                                  // 无 parentSession → 不是子 agent
  surface: { nodes: [1, 2, 3, 4, 5, 6] },     // ≥3 个 seq，pickRegion 才不早退
  eventAt(seq) { return { type: 'user/message' } },  // 不是 system/message → firstIdx = 0
}

const agent = {
  session,
  options: {},
  whenIdle: async () => {},
  followup: (msg) => sent.push({ via: 'followup', msg }),
  inject: (msg) => sent.push({ via: 'inject', msg }),
  steer: (msg) => sent.push({ via: 'steer', msg }),
  cancel: () => {},
  runMaintenance: async (task) => task(new AbortController().signal),
}

const compaction = {
  async compactRegion(start, end, actx) {
    compactionCalls.push({ fn: 'compactRegion', start, end, hasSession: !!actx?.session })
    return { ok: true }
  },
  async compactNow(actx, signal) {
    compactionCalls.push({ fn: 'compactNow', hasRunMaintenance: typeof actx?.runMaintenance === 'function' })
    return { ok: true }
  },
  async compactIfNeeded() { return null },
}

const ctx = {
  on(name, fn) { handlers[name] = fn },
  agents: { get: () => agent },
  get(name) { return name === 'compaction' ? compaction : undefined },
  logger: {
    debug: (m) => logs.push(['debug', m]),
    warn: (m) => logs.push(['warn', m]),
    info: (m) => logs.push(['info', m]),
    error: (m) => logs.push(['error', m]),
  },
}

// ── 配置：把阈值压到最小，几轮就能跑完全程 ──────────────────────────
// ★ 不用 mod.Config.parse —— 这里的 z 来自 @deepseek-ai/schemastery，不是 zod，没有 .parse。
//   apply() 只读 config 的字段，所以直接给一个完整对象即可（字段名照抄 Config 定义）。
const config = {
  // ── 换气层（本测试关心的）──
  maxContinuations: 2,        // 只给 2 次额度 → 第 3 次必熔断
  regionCompactAfterCuts: 2,  // 第 2 次续跑时就触发范围压缩
  fullCompactOnBreaker: true,
  postCompactRecallHint: true,
  compactionService: '',      // 留空 = 'compaction'
  emptyTurnContinue: true,
  subagentPolicy: 'strict',
  sessionCacheDir: '',
  ledgerPath: join(SIM_HOME, 'state', 'ledger.json'),
  normalTurnThreshold: 20,
  anomalyWindow: 10,
  warnAtCredit: 2,
  // ── 流内判据（本测试不触发，但给了防止 NaN 比较）──
  maxThinkingSteps: 3,
  minReasoningChars: 2048,
  similarityThreshold: 0.8,
  escalate: 'steer',
  maxFires: 4,
  cancelCause: 'thinking-loop',
  silentReasoningChars: 0,
  reasoningOnlySteps: 1,
  maxRepeatedText: 0,
  maxRepeatedCycleChars: 0,
  minRepeatedCycleChars: 0,
  maxRepeatedReasoningCycleChars: 0,
  minRepeatedReasoningCycleChars: 0,
  maxRepeatedReasoningLineChars: 0,
  minRepeatedReasoningLineCoverage: 0,
  minRepeatedReasoningLineConcentration: 0,
  maxRepeatedTextLineChars: 0,
  minRepeatedTextLineCoverage: 0,
  minRepeatedTextLineConcentration: 0,
  breakCode: 'loop-guard',
  breakCorrection: '',
  resumeAfterBreak: true,
}

console.log('=== 0. apply() ===')
const t0 = Date.now()
mod.apply(ctx, config)
console.log('  ✓ apply 返回，耗时 ' + (Date.now() - t0) + 'ms')
console.log('  注册的 handler: ' + Object.keys(handlers).join(', '))

const turnEnd = handlers['session/event']
if (typeof turnEnd !== 'function') {
  console.error('  ✗ 没有 session/event handler，测试终止')
  process.exit(1)
}

// ── 模拟一个「空回合」：turn/start → 无 assistant/message → turn/end(completed) ──
async function emptyTurn(tag) {
  const before = { sent: sent.length, calls: compactionCalls.length }
  turnEnd(session, { type: 'turn/start' })
  turnEnd(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  // 内部是 `void (async () => {...})()`，给它时间跑完
  await new Promise((r) => setTimeout(r, 80))
  const newSent = sent.slice(before.sent)
  const newCalls = compactionCalls.slice(before.calls)
  console.log(`\n=== ${tag} ===`)
  console.log('  发出的消息 (' + newSent.length + '):')
  for (const s of newSent) {
    const text = s.msg?.content?.[0]?.text ?? s.msg?.text ?? JSON.stringify(s.msg).slice(0, 90)
    console.log('    [' + s.via + '] ' + String(text).replace(/\n/g, ' ⏎ ').slice(0, 150))
  }
  console.log('  压缩调用 (' + newCalls.length + '): ' + JSON.stringify(newCalls))
  return { newSent, newCalls }
}

console.log('\n########## 开始模拟空回合 ##########')

const r1 = await emptyTurn('第 1 次空回合（cuts→1，未到阈值 2）')
const r2 = await emptyTurn('第 2 次空回合（cuts→2 = 阈值，应触发范围压缩）')
const r3 = await emptyTurn('第 3 次空回合（额度耗尽 → 熔断 + 全量压缩）')
const r4 = await emptyTurn('第 4 次空回合（熔断后再来一次，看是否重复触发）')

// ── 判定 ──────────────────────────────────────────────────────────────
console.log('\n########## 判定 ##########')
const allCalls = compactionCalls.map((c) => c.fn)
const hasRegion = allCalls.includes('compactRegion')
const hasFull = allCalls.includes('compactNow')

const allText = sent.map((s) => String(s.msg?.content?.[0]?.text ?? s.msg?.text ?? '')).join('\n')
const hasRecallHint = /取回|一手原文|memq open|不要依赖摘要/.test(allText)
const hasCircuitNotice = /全量压缩|不再延续|思考退化熔断/.test(allText)

const checks = [
  ['① 第 1 次续跑（额度未耗尽）', r1.newSent.length > 0 && r1.newCalls.length === 0],
  ['② 第 2 次触发范围压缩 compactRegion', r2.newCalls.some((c) => c.fn === 'compactRegion')],
  ['③ 范围压缩后注入「取回指引」', hasRecallHint],
  ['④ 第 3 次熔断并调用 compactNow', r3.newCalls.some((c) => c.fn === 'compactNow')],
  ['⑤ 熔断告知写清「全量压缩 / 不再延续」', hasCircuitNotice],
  ['⑥ compactRegion 拿到了 session', compactionCalls.some((c) => c.fn === 'compactRegion' && c.hasSession)],
  ['⑦ compactNow 的 ctx 带 runMaintenance', compactionCalls.some((c) => c.fn === 'compactNow' && c.hasRunMaintenance)],
]
let pass = 0
for (const [name, ok] of checks) {
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name)
  if (ok) pass++
}

// ── 判词文件 ──────────────────────────────────────────────────────────
const turnsPath = join(SIM_HOME, 'state', 'huanqi-turns.jsonl')
console.log('\n########## 判词文件 ##########')
if (existsSync(turnsPath)) {
  const lines = readFileSync(turnsPath, 'utf8').trim().split('\n').filter(Boolean)
  console.log('  ' + lines.length + ' 条记录')
  for (const l of lines) {
    try {
      const o = JSON.parse(l)
      console.log('    verdict=' + o.verdict + '  credit=' + o.credit + '/' + o.creditMax +
        '  有compact=' + ('compact' in o))
    } catch { console.log('    (解析失败)') }
  }
} else {
  console.log('  ★ 判词文件不存在')
}

console.log('\n########## 结果 ##########')
console.log('  ' + pass + '/' + checks.length + ' 项通过')
console.log('  压缩调用总序列: ' + JSON.stringify(allCalls))

// 清理临时目录
rmSync(SIM_HOME, { recursive: true, force: true })
process.exit(pass === checks.length ? 0 : 1)
