/**
 * 子 agent 不参与换气判定 —— 2026-10-23 的回归测试。
 *
 * ## 为什么要有这一条
 *
 * 2026-10-22 夜，子 agent 正在干活时被换气**反复误杀**。
 * 病因不是判据算错了，是**判据被用在不该用的对象上**：
 *
 *   换气判的是「这一轮没出正文」。而子 agent 的「没出正文」**通常只是它还在读文件、
 *   跑工具、等一个长命令** —— 那不是循环，是工作。
 *   主会话和子 agent 放在同一把尺子下，被误判的那一方永远是子 agent，
 *   因为它本来就更少「说话」、更多「做事」。
 *
 * ## 判据用的是 DSH 自己的分类，不猜
 *
 *   `agent.session.meta.origin === 'subagent'`（coarse classification）
 *   或 `agent.session.meta.delegationDepth > 0`（递归深度，子 agent 至少 1）。
 *
 * ## 这个文件测什么
 *
 * 1. **子 agent**：同样的连续空转，steer / inject / cancel **一个都不许发**；
 * 2. **对照（根会话）**：同样输入，**必须**真的动了手 —— 否则「豁免」可能是
 *    「整个换气都不工作了」，那种测试会假通过。
 *
 * ★ 第 2 条是对照组，不是凑数：没有它，第 1 条在「插件根本没加载」时也会过。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import * as plugin from '../lib/index.js'

/* -------------------------------------------------------------------------- */
/* fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function ledgerFor(name) {
  const p = join(tmpdir(), `yq-huanqi-sub-${name}-${process.pid}.json`)
  rmSync(p, { force: true })
  return p
}

const BASE = {
  // 连续 3 次「只思考、零产出」就触发。
  maxThinkingSteps: 3,
  minReasoningChars: 2048,
  similarityThreshold: 0.8,
  escalate: 'steer',
  maxFires: 4,
  maxRepeatedText: 0,
  maxRepeatedCycleChars: 0,
  maxRepeatedReasoningCycleChars: 0,
  minRepeatedReasoningLineConcentration: 9999,
  maxContinuations: 0, // 换气层关掉，本文件只谈循环检测
  normalTurnThreshold: 20,
  anomalyWindow: 10,
  warnAtCredit: 2,
  silentReasoningChars: 0,
  reasoningOnlySteps: 1,
}

/** 一个记下所有介入动作的 agent 替身。 */
function spyAgent(meta) {
  const steers = []
  const injected = []
  const cancels = []
  return {
    steers,
    injected,
    cancels,
    ...(meta === undefined ? {} : { session: { id: 's1', meta } }),
    steer: (m) => steers.push(m),
    inject: (m) => injected.push(m),
    cancel: (c) => cancels.push(c),
    whenIdle: () => Promise.resolve(),
    followup: () => {},
  }
}

function host(agent, overrides = {}) {
  let stream = null
  const ctx = {
    logger: { warn: () => {}, debug: () => {}, info: () => {}, error: () => {} },
    agents: { get: () => agent },
    on(name, listener) { if (name === 'llm/stream') stream = listener },
  }
  plugin.apply(ctx, { ...BASE, ...overrides })
  assert.equal(typeof stream, 'function', 'the plugin must register an llm/stream wrapper')
  return { stream }
}

/** 把一串 chunk 喂给包装器；被中断时吞掉异常（那是「介入成功」的一种表现）。 */
async function drive(stream, chunks) {
  const options = markAgentLoopRequest({ sessionId: 's1', provider: 'p', model: 'm', messages: [] })
  const out = []
  try {
    for await (const c of stream(options, async function* source() { for (const x of chunks) yield x })) {
      out.push(c)
    }
  } catch {
    // 硬中断会从包装器里抛出来 —— 对「根会话该被管」而言这是预期内的。
  }
  return out
}

/** 一条只有 reasoning 的流，正文长度 ≥ minReasoningChars。 */
function reasoningChunks(text) {
  const deltas = (text.match(/[\s\S]{1,32}/g) || []).map((t) => ({ type: 'reasoning-delta', index: 0, text: t }))
  return [{ type: 'block-start', index: 0, blockType: 'reasoning' }, ...deltas]
}

/** 同一段思考喂四轮 —— 四 > maxThinkingSteps(3)，足够触发。 */
async function spin(stream, rounds = 4) {
  // ★ 内容完全一样，保证「相似度」这条判据一定命中，不靠运气。
  const text = '我在想这个问题该怎么拆解。'.repeat(200)
  for (let i = 0; i < rounds; i++) {
    await drive(stream, reasoningChunks(text))
  }
}

/* -------------------------------------------------------------------------- */
/* 1. 子 agent：一次都不许动                                                    */
/* -------------------------------------------------------------------------- */

test('★★ 子 agent（origin=subagent）：连续空转也不许被换气碰一下', async () => {
  const agent = spyAgent({ origin: 'subagent' })
  const { stream } = host(agent, { ledgerPath: ledgerFor('by-origin') })

  await spin(stream)

  assert.deepEqual(agent.steers, [], '★ 子 agent 不能被 steer —— 那正是 10-22 夜误杀的形状')
  assert.deepEqual(agent.injected, [], '子 agent 不该收到任何通知')
  assert.deepEqual(agent.cancels, [], '更不能被硬中断')
})

test('★★ 子 agent（delegationDepth>0）：同样豁免', async () => {
  const agent = spyAgent({ delegationDepth: 1 })
  const { stream } = host(agent, { ledgerPath: ledgerFor('by-depth') })

  await spin(stream)

  assert.deepEqual(agent.steers, [], 'delegationDepth>0 也算子 agent')
  assert.deepEqual(agent.cancels, [])
})

/* -------------------------------------------------------------------------- */
/* 2. 对照组：根会话必须真的被管                                                 */
/* -------------------------------------------------------------------------- */

test('★ 对照：根会话（无 meta）同样输入 → 必须真的介入', async () => {
  const agent = spyAgent(undefined)
  const { stream } = host(agent, { ledgerPath: ledgerFor('root') })

  await spin(stream)

  // ★ 没有这一条，上面两条在「插件根本没加载」时也会通过 —— 那是假通过。
  const acted = agent.steers.length + agent.injected.length + agent.cancels.length
  assert.ok(
    acted > 0,
    '根会话在连续空转后必须被介入，否则「豁免」就成了「整个换气不工作」',
  )
})

test('★ 对照：根会话带一个普通 meta（不是 subagent）→ 仍然要被管', async () => {
  const agent = spyAgent({ cwd: 'D:/AI/yanqing-soul' })
  const { stream } = host(agent, { ledgerPath: ledgerFor('root-meta') })

  await spin(stream)

  const acted = agent.steers.length + agent.injected.length + agent.cancels.length
  assert.ok(acted > 0, '有一个不含 origin 的 meta 不能当成子 agent')
})
