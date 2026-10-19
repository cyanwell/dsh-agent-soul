/**
 * 空回合（empty turn）—— 2026-10-19 从 `dsh-stalled-turn-continue` 吸收的那条判据的回归测试。
 *
 * ## 它是什么
 *
 * 前三条判据（流内早杀 / 流末判定 / 输出重复）全挂在 `llm/stream` 上 ——
 * 也就是说，**它们只在「有一次模型调用」时才有机会看一眼**。
 *
 * 而有一种失败是「调用了，但什么都没留下」：只发 reasoning 块，然后直接 end-of-turn，
 * 没有 text、没有 tool-call。引擎认为这一轮正常结束（`finish_reason: stop`，零工具调用），
 * 于是 auto-continue 不管它，会话就停在那儿等人手打「继续」。
 *
 * ## 为什么必须挂在 session/event 上
 *
 * 一次回合可能有好几次模型调用。中间某次没产出是正常的（它在读文件、在调工具），
 * **整轮都没产出才是病**。而「整轮结束」这件事只有 `turn/end` 知道 ——
 * 流只知道「这次调用结束了」。
 *
 * ## 这个文件测什么
 *
 * 1. 空回合 → 真的调了 `followup`（续一轮），而且额度 −1；
 * 2. 有产出的回合 → 不续（对照组）；
 * 3. 额度耗尽 → 不再续，改成熔断（`inject` 一条能认出来的话）；
 * 4. `emptyTurnContinue: false` → 整条判据关掉；
 * 5. 非正常结束（`error` / `interrupted`）→ 不归它管（那是 auto-continue 的地盘）；
 * 6. 同一轮里「先空转后产出」→ 不续（产出由 `assistant/message` 记账）。
 *
 * ★ 这个测试**是补出来的**，不是原来就有 —— 因为 `silent-cut.spec.mjs` 里的 `host()`
 * 只注册 `llm/stream`，于是新加的 `session/event` 监听在整套测试里一次都没被触发过。
 * 「185 个测试全过」当时并不包含这一条。
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
  const p = join(tmpdir(), `yq-huanqi-empty-${name}-${process.pid}.json`)
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
  // 换气层
  maxContinuations: 4,
  normalTurnThreshold: 20,
  anomalyWindow: 10,
  warnAtCredit: 2,
  // 本文件只谈空回合：把流内早杀关掉，免得别的判据插手。
  silentReasoningChars: 0,
  reasoningOnlySteps: 1,
}

/**
 * 一个会等 `whenIdle()` 的 agent 替身。
 *
 * `scheduleResume` 必须等到回合真正收尾才 `followup()`，所以测试要能等到那一刻。
 */
function resumeAgent() {
  let resolveIdle = null
  const idle = new Promise((r) => { resolveIdle = r })
  const followups = []
  const injected = []
  return {
    followups,
    injected,
    steer: () => {},
    inject: (m) => injected.push(m),
    cancel: () => {},
    whenIdle: () => idle,
    followup: (m) => followups.push(m),
    settle: async () => { resolveIdle(); await new Promise((r) => setImmediate(r)) },
  }
}

/**
 * 宿主替身：**同时**收下 `llm/stream` 和 `session/event` 两种监听器。
 *
 * ★ 和 `silent-cut.spec.mjs` 的 `host()` 有一处关键不同：那个只收 `llm/stream`，
 * 所以用它测不到空回合。这里把两种都存下来，再暴露一个 `emit()` 手动投递事件。
 */
function host(agent, overrides = {}) {
  const llm = []
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
      if (name === 'llm/stream') llm.push(listener)
      else if (name === 'session/event') session.push(listener)
    },
  }
  plugin.apply(ctx, { ...BASE, ...overrides })

  /** 投递一个 session 事件给所有注册过的监听器。 */
  const emit = (sid, type, data) => {
    for (const fn of session) fn({ id: sid }, { type, data })
  }

  return { llm, session, warnings, emit }
}

/** 一条带 text 的 assistant 消息（= 这轮有产出）。 */
const textMessage = {
  message: { content: [{ type: 'text', text: '做完了' }] },
}

/** 一条只有 reasoning 的 assistant 消息（= 这轮没产出）。 */
const reasoningOnlyMessage = {
  message: { content: [{ type: 'reasoning', text: '想了很久……' }] },
}

/* -------------------------------------------------------------------------- */
/* 1. 空回合 → 续一轮，额度 −1                                                 */
/* -------------------------------------------------------------------------- */

test('★ 空回合：turn/end 且全程无产出 → 调 followup 续一轮', async () => {
  const agent = resumeAgent()
  const { emit, session, warnings } = host(agent, { ledgerPath: ledgerFor('basic') })

  assert.equal(session.length, 1, '插件必须注册一个 session/event 监听')

  emit('s1', 'turn/start')
  // 只发 reasoning，不发 text / tool-call
  emit('s1', 'assistant/message', reasoningOnlyMessage)
  emit('s1', 'turn/end', { reason: { kind: 'completed' } })

  await agent.settle()

  assert.equal(agent.followups.length, 1, '★ 空回合必须续一轮')
  assert.equal(agent.followups[0].role, 'user', '续跑消息是 user 角色')
  assert.match(
    JSON.stringify(agent.followups[0]),
    /换气|huanqi/i,
    '续跑文案要能认出是换气发的',
  )
  assert.ok(
    warnings.some((w) => w.includes('turn ended with no visible output')),
    '日志要留下这一笔',
  )
})

test('★ 空回合也认 `no-visible-output` 这个 kind', async () => {
  const agent = resumeAgent()
  const { emit } = host(agent, { ledgerPath: ledgerFor('novisible') })

  emit('s1', 'turn/start')
  emit('s1', 'turn/end', { reason: { kind: 'no-visible-output' } })

  await agent.settle()
  assert.equal(agent.followups.length, 1, '两种 kind 都要认')
})

/* -------------------------------------------------------------------------- */
/* 2. 有产出的回合 → 不续（对照组）                                             */
/* -------------------------------------------------------------------------- */

test('★ 有产出的回合：turn/end 但出过 text → 不许续', async () => {
  const agent = resumeAgent()
  const { emit } = host(agent, { ledgerPath: ledgerFor('has-output') })

  emit('s1', 'turn/start')
  emit('s1', 'assistant/message', textMessage)
  emit('s1', 'turn/end', { reason: { kind: 'completed' } })

  await agent.settle()
  assert.equal(agent.followups.length, 0, '★ 出了正文就是真进展，不是空回合')
})

test('★ 有产出的回合：出过 tool-call 也算产出', async () => {
  const agent = resumeAgent()
  const { emit } = host(agent, { ledgerPath: ledgerFor('tool-call') })

  emit('s1', 'turn/start')
  emit('s1', 'assistant/message', {
    message: { content: [{ type: 'tool-call', name: 'read', arguments: '{}' }] },
  })
  emit('s1', 'turn/end', { reason: { kind: 'completed' } })

  await agent.settle()
  assert.equal(agent.followups.length, 0, '工具调用也是产出')
})

test('★ 同一轮里先空转后产出 → 不续', async () => {
  const agent = resumeAgent()
  const { emit } = host(agent, { ledgerPath: ledgerFor('mixed') })

  emit('s1', 'turn/start')
  emit('s1', 'assistant/message', reasoningOnlyMessage) // 第一次调用没产出
  emit('s1', 'assistant/message', textMessage)          // 第二次调用产出了
  emit('s1', 'turn/end', { reason: { kind: 'completed' } })

  await agent.settle()
  assert.equal(agent.followups.length, 0, '★ 一轮里有任何一次产出，就不算空回合')
})

test('★ turn/start 会清零：上一轮的产出不算到这一轮头上', async () => {
  const agent = resumeAgent()
  const { emit } = host(agent, { ledgerPath: ledgerFor('reset') })

  // 第一轮：有产出
  emit('s1', 'turn/start')
  emit('s1', 'assistant/message', textMessage)
  emit('s1', 'turn/end', { reason: { kind: 'completed' } })

  // 第二轮：空转
  emit('s1', 'turn/start')
  emit('s1', 'turn/end', { reason: { kind: 'completed' } })

  await agent.settle()
  assert.equal(agent.followups.length, 1, '★ 第二轮自己没产出，必须续')
})

/* -------------------------------------------------------------------------- */
/* 3. 非正常结束 → 不归它管                                                     */
/* -------------------------------------------------------------------------- */

test('★ error / interrupted / max-tokens → 不归空回合管', async () => {
  for (const kind of ['error', 'interrupted', 'max-tokens', 'aborted', 'blocked']) {
    const agent = resumeAgent()
    const { emit } = host(agent, { ledgerPath: ledgerFor('kind-' + kind) })

    emit('s1', 'turn/start')
    emit('s1', 'turn/end', { reason: { kind } })

    await agent.settle()
    assert.equal(agent.followups.length, 0, `kind=${kind} 应该归 auto-continue，不是空回合`)
  }
})

/* -------------------------------------------------------------------------- */
/* 4. 额度耗尽 → 熔断                                                           */
/* -------------------------------------------------------------------------- */

test('★ 额度耗尽：不再续，改成熔断（塞一条能认出来的话）', async () => {
  const agent = resumeAgent()
  const { emit } = host(agent, {
    ledgerPath: ledgerFor('exhausted'),
    maxContinuations: 1, // 只给一次机会
  })

  // 第一次空回合：用掉唯一那点额度
  emit('s1', 'turn/start')
  emit('s1', 'turn/end', { reason: { kind: 'completed' } })
  await agent.settle()
  assert.equal(agent.followups.length, 1, '第一次应该续')

  // 第二次空回合：额度没了
  emit('s1', 'turn/start')
  emit('s1', 'turn/end', { reason: { kind: 'completed' } })
  await agent.settle()

  assert.equal(agent.followups.length, 1, '★ 额度耗尽后不许再续')
  assert.ok(agent.injected.length >= 1, '★ 必须留下一条可见的消息（空消息会让会话永久不可用）')
  const said = JSON.stringify(agent.injected.at(-1))
  assert.match(said, /熔断|circuit/i, '熔断文案要能认出来')
})

/* -------------------------------------------------------------------------- */
/* 5. 配置能单独关掉                                                           */
/* -------------------------------------------------------------------------- */

test('★ emptyTurnContinue: false → 整条判据关掉', async () => {
  const agent = resumeAgent()
  const { emit, session } = host(agent, {
    ledgerPath: ledgerFor('disabled'),
    emptyTurnContinue: false,
  })

  assert.equal(session.length, 0, '关掉之后连监听都不该注册')

  emit('s1', 'turn/start')
  emit('s1', 'turn/end', { reason: { kind: 'completed' } })
  await agent.settle()

  assert.equal(agent.followups.length, 0, '★ 关掉就是关掉')
})

test('★ maxContinuations: 0 → 连监听都不注册', async () => {
  const agent = resumeAgent()
  const { session } = host(agent, {
    ledgerPath: ledgerFor('zero-max'),
    maxContinuations: 0,
  })
  assert.equal(session.length, 0, '额度为 0 时整层关掉，空回合也不注册')
})

/* -------------------------------------------------------------------------- */
/* 6. 账本落盘                                                                 */
/* -------------------------------------------------------------------------- */

test('★ 续过之后账本真的落盘了，额度比上限少', async () => {
  const { readFileSync, existsSync } = await import('node:fs')
  const path = ledgerFor('persist')
  const agent = resumeAgent()
  const { emit } = host(agent, { ledgerPath: path, maxContinuations: 4 })

  emit('s1', 'turn/start')
  emit('s1', 'turn/end', { reason: { kind: 'completed' } })
  await agent.settle()

  assert.ok(existsSync(path), '★ 账本要落盘 —— 不落盘的话重启一次就回满额')
  const ledger = JSON.parse(readFileSync(path, 'utf8'))
  assert.ok(ledger.credit < ledger.creditMax, `额度该降了，实际 ${ledger.credit}/${ledger.creditMax}`)
  assert.equal(ledger.creditMax, 4)
})
