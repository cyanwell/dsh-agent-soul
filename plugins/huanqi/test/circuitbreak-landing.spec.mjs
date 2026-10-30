/**
 * 2026-10-23 换气升级的两条回归测试。
 *
 * ## 背景（作者当天提的两个需求）
 *
 * ① **子 agent 不参与换气判定。** 前一晚（10-22）子 agent 正在干活时被反复误杀 ——
 *    换气判的是「这一轮没出正文」，而子 agent 的「没出正文」通常只是它还在读文件、
 *    跑工具、等一个长命令。那不是循环，是工作。
 *
 * ② **熔断后要求 agent 自己落盘。** 这里的「熔断」是**延续额度耗尽**那一档
 *    （不是 `react()` 的循环检测 —— 两者容易混，作者当天专门纠正过）。
 *    原来那两处只 `inject` 一条通知（**给人看**），agent 不一定会去做任何事；
 *    现在补一条 `steer`（会进下一轮、被模型读到并执行），要它落盘、记账、喊手动压缩。
 *
 * ## 这个文件测什么
 *
 * 1. 熔断时**真的**发了一条 steer，而且文案里三件事都在（落盘 / 索引指针 / 手动压缩）；
 * 2. 熔断后**再**熔断，**不会**再发一次 —— 否则熔断→steer→再熔断→再 steer 是无限循环
 *    （额度已经是 0，每推一轮都烧一次钱，却永远不让人介入）；
 * 3. 首轮熔断仍然保留 `inject`（那条还负责「让 assistant 消息不为空」，
 *    空消息会让整条会话从那一刻起永久不可用）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../lib/index.js'

/* -------------------------------------------------------------------------- */
/* fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** 每次测试独立的账本路径 —— 绝不碰 `<DSH_HOME>/state` 里的真账本。 */
function ledgerFor(name) {
  const p = join(tmpdir(), `yq-huanqi-cb-${name}-${process.pid}.json`)
  rmSync(p, { force: true })
  return p
}

const BASE = {
  maxThinkingSteps: 3,
  minReasoningChars: 2048,
  similarityThreshold: 0.8,
  escalate: 'steer',
  maxFires: 4,
  maxRepeatedText: 0,
  maxRepeatedCycleChars: 0,
  maxRepeatedReasoningCycleChars: 0,
  minRepeatedReasoningLineConcentration: 9999,
  // 换气层：额度只给 1，方便两轮之内走到熔断。
  maxContinuations: 1,
  normalTurnThreshold: 20,
  anomalyWindow: 10,
  warnAtCredit: 2,
  // 只谈熔断：把流内早杀关掉，免得别的判据插手。
  silentReasoningChars: 0,
  reasoningOnlySteps: 1,
}

/**
 * 一个会记录 `steer` 的 agent 替身。
 *
 * ★ 和 `empty-turn.spec.mjs` 的 `resumeAgent()` 有一处关键不同：
 * 那个的 `steer` 是空实现（它只关心 `followup`），而这里要**数 steer 发了几次**。
 */
function steerAgent() {
  let resolveIdle = null
  const idle = new Promise((r) => { resolveIdle = r })
  const followups = []
  const injected = []
  const steers = []
  return {
    followups,
    injected,
    steers,
    steer: (m) => steers.push(m),
    inject: (m) => injected.push(m),
    cancel: () => {},
    whenIdle: () => idle,
    followup: (m) => followups.push(m),
    settle: async () => { resolveIdle(); await new Promise((r) => setImmediate(r)) },
  }
}

/** 宿主替身：收下 `session/event` 监听器，暴露一个 `emit()` 手动投递。 */
function host(agent, overrides = {}) {
  const session = []
  const warnings = []
  const ctx = {
    logger: {
      warn: (m) => warnings.push(m),
      debug: () => {},
      info: () => {},
      error: () => {},
    },
    agents: { get: () => agent },
    on(name, listener) {
      if (name === 'session/event') session.push(listener)
    },
  }
  plugin.apply(ctx, { ...BASE, ...overrides })

  const emit = (sid, type, data) => {
    for (const fn of session) fn({ id: sid }, { type, data })
  }
  return { session, warnings, emit }
}

/** 一条只有 reasoning 的 assistant 消息（= 这轮没产出 → 空回合）。 */
const emptyTurn = {
  message: { content: [{ type: 'reasoning', text: '想了很久……' }] },
}

/** 走完一次完整的空回合：start → 无产出 → end。 */
function runEmptyTurn(emit, sid) {
  emit(sid, 'turn/start')
  emit(sid, 'assistant/message', emptyTurn)
  emit(sid, 'turn/end', { reason: { kind: 'completed' } })
}

/* -------------------------------------------------------------------------- */
/* 1. 熔断时真的发了一条 steer，三件事都在                                      */
/* -------------------------------------------------------------------------- */

test('★ 熔断：发一条 steer，要它落盘 / 记索引 / 喊手动压缩', async () => {
  const agent = steerAgent()
  const { emit } = host(agent, { ledgerPath: ledgerFor('first') })

  // 额度 1：第一轮空回合用掉续跑，第二轮就该熔断。
  runEmptyTurn(emit, 's1')
  await agent.settle()
  runEmptyTurn(emit, 's1')
  await agent.settle()

  assert.equal(agent.steers.length, 1, '★ 熔断必须发一条 steer 落盘指令（而不是只 inject 给人看）')

  const text = JSON.stringify(agent.steers[0])
  assert.match(text, /落盘/, '要求它把进度落盘')
  assert.match(text, /索引/, '要求在账本里加索引')
  assert.match(text, /手动压缩/, '要求它提示用户手动压缩')
  // ★ 指针纪律：拿不到精确 seq 时要写检索词，不许猜。
  assert.match(text, /不许猜|绝不许猜|不要猜/i, '必须写明「拿不到精确 seq 不许猜」')
})

test('★ 熔断时仍然保留 inject（它负责让 assistant 消息不为空）', async () => {
  const agent = steerAgent()
  const { emit } = host(agent, { ledgerPath: ledgerFor('inject') })

  runEmptyTurn(emit, 's1')
  await agent.settle()
  runEmptyTurn(emit, 's1')
  await agent.settle()

  assert.ok(
    agent.injected.some((m) => JSON.stringify(m).includes('熔断')),
    '★ 熔断的 inject 不能删 —— 空消息会让整条会话永久不可用',
  )
})

/* -------------------------------------------------------------------------- */
/* 2. 只发一次（防无限循环）                                                    */
/* -------------------------------------------------------------------------- */

test('★★ 熔断后继续空转：steer 只发一次，不会再推它（防无限循环）', async () => {
  const agent = steerAgent()
  const { emit } = host(agent, { ledgerPath: ledgerFor('once') })

  // 跑五轮空回合：第一轮续跑、第二轮熔断并 steer；第三轮起额度仍是 0，会一再熔断。
  for (let i = 0; i < 5; i++) {
    runEmptyTurn(emit, 's1')
    await agent.settle()
  }

  // ★ 这条断言就是防「熔断 → steer → 再熔断 → 再 steer」的无限循环：
  //   额度已经是 0，每推一轮都烧一次钱，却永远不让人介入。
  assert.equal(
    agent.steers.length,
    1,
    `steer 必须只发一次，实际发了 ${agent.steers.length} 次 —— 超过 1 次就是无限循环`,
  )
  assert.equal(
    agent.followups.length,
    1,
    '额度耗尽后不能再自动续跑（那会让熔断失去意义）',
  )
})
