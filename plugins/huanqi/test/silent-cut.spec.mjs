/**
 * 流内早杀（silent cut）—— 那个循环的回归测试。
 *
 * ## 为什么会有这条判据
 *
 * 那一步，模型在**一次调用里**写了 5140 个字符的思考，
 * 正文 0、工具调用 0，然后停住 —— 整条会话卡在那里，直到使用者手动出声。
 * 事后量了本会话全部 6737 步：
 *
 *   - 「这一轮结束时既没有正文、也没有工具调用」的步，**全史只有 4 个，
 *     而且 4 个全是循环事件** —— 正常步一次都没有。误报率约等于零。
 *   - 那 4 个的长度是 1990 / 2639 / 2901 / 5140 字符。
 *   - 而正常步的 `firstOutputAt`（第一次产出正文或工具调用时，思考已写了多少字）
 *     中位数约 900，**最长的到 22281** —— 所以**纯字符阈值分不开两者**，
 *     任何能抓到 1990 的阈值都会误杀 20% 以上的正常步。
 *   - 形态维度同样分不开：短语池去重比在正常长推理里最低到 0.12，真循环是 0.13；
 *     平均句长也一样重叠。这和 `observe` 上那段 `low-entropy` 的标定是同一个结论。
 *
 * 结论：**只剩「有没有产出」这一个维度可用**，那就用它，并且分两层落地 ——
 * 流内早杀负责"别等它自己停"，流末判定负责"短循环也要接住"。
 *
 * ## 这个文件测什么
 *
 * 1. 流内早杀真的在阈值处截断，而不是等流跑完；
 * 2. 有产出就不杀（对照组）；
 * 3. 没到阈值不杀；
 * 4. `0` 能关掉它；
 * 5. 没到阈值就自己停的短循环，仍然被流末那条接住（`reasoningOnlySteps: 1`）；
 * 6. 旧门槛（`reasoningOnlySteps: 3`）确实接不住 —— 这是这条改动的存在理由。
 *
 * `test/…` 跑的是 `lib/index.js`，所以这些断言钉的是**发出去的那个产物**。
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

/**
 * 一份不重复的中文长文本。
 *
 * 每一行都带自己的序号，所以任何"重复行/重复周期"检测器都不会误触 ——
 * 这是故意的：本文件要隔离的是「有没有产出」，不是「长得像不像循环」。
 */
function prose(chars, salt = '') {
  const verbs = ['检查', '核对', '记录', '比对', '确认', '整理', '推演', '排查']
  const out = []
  let i = 0
  while (out.join('').length < chars) {
    out.push(`${salt}${verbs[i % verbs.length]}第 ${i} 项的当前状态与预期之间的差异，并把它写进账本。\n`)
    i++
  }
  return out.join('').slice(0, chars)
}

/** 每次测试独立的账本路径 —— 绝不碰 `<DSH_HOME>/state` 里的真账本。 */
function ledgerFor(name) {
  const p = join(tmpdir(), `yq-huanqi-silent-${name}-${process.pid}.json`)
  rmSync(p, { force: true })
  return p
}

const BASE = {
  maxThinkingSteps: 3,
  minReasoningChars: 2048,
  similarityThreshold: 0.8,
  escalate: 'steer',
  maxFires: 4,
  // 可见输出的两条规则关掉：本文件只谈思考。
  maxRepeatedText: 0,
  maxRepeatedCycleChars: 0,
  // 思考重复的两条规则也关掉 —— 上面那份 prose() 本来就不重复，
  // 再关一次是为了让"截断只能来自 silent cut"这件事没有第二种解释。
  //
  // ★ 周期那条可以真正用 0 关掉：代码里有 `if (maxRepeatedReasoningCycleChars <= 0) return false`。
  maxRepeatedReasoningCycleChars: 0,
  // ★★ 行那条**不能**用 0 关 —— `pushLines` 把 0 直接当门槛传进 `pool.tripped()`，
  // "出现 0 次就算重复"于是恒真，**每个 delta 都会被判成重复并截断**。
  // 这个坑当场踩过：本文件第一版把 0 当"关闭"写，6 个用例全挂在一个 32 字就截断的流上。
  // 抬到天上才是关掉，而且不依赖"0 是特例"这个读法。
  minRepeatedReasoningLineConcentration: 9999,
  // 换气层
  maxContinuations: 4,
  normalTurnThreshold: 20,
  anomalyWindow: 10,
  warnAtCredit: 2,
  silentReasoningChars: 3000,
  reasoningOnlySteps: 1,
}

/**
 * 一个会等 `whenIdle()` 的 agent 替身。
 *
 * `resumeAgent` 那套（见 `reasoning-breaker.spec.mjs`）在这里是必要的：
 * `scheduleResume` 必须等到回合真正收尾才 `followup()`，测试要能等到那一刻。
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
    settle: () => { resolveIdle(); return new Promise((r) => setImmediate(r)) },
  }
}

/** 一个装得下 `llm/stream` 监听器的宿主，并把日志收下来。 */
function host(agent, overrides = {}) {
  const listeners = []
  let stream = null
  const warnings = []
  const ctx = {
    logger: { warn: (m) => warnings.push(m), debug: () => {}, info: () => {}, error: () => {} },
    agents: { get: () => agent },
    on(name, listener) { if (name === 'llm/stream') { listeners.push(listener); stream = listener } },
  }
  plugin.apply(ctx, { ...BASE, ...overrides })
  assert.equal(typeof stream, 'function', 'the plugin must register an llm/stream wrapper')
  return { stream, warnings }
}

/** 把一串 chunk 喂给包装器，收集它吐出来的一切。 */
async function drive(stream, chunks) {
  const options = markAgentLoopRequest({ sessionId: 's1', provider: 'p', model: 'm', messages: [] })
  const out = []
  for await (const c of stream(options, async function* source() { for (const x of chunks) yield x })) {
    out.push(c)
  }
  return out
}

/** 一条只有思考的流：一个 block-start，然后按 `size` 切块的 reasoning-delta。 */
function reasoningChunks(text, size = 32, index = 0) {
  const deltas = (text.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) || [])
    .map((t) => ({ type: 'reasoning-delta', index, text: t }))
  return [{ type: 'block-start', index, blockType: 'reasoning' }, ...deltas]
}

/**
 * ★ 交错流：思考写到第 `at` 个字符时插入一次产出。
 *
 * 这不是修辞 —— 真实模型是**边想边说的**，`text-delta` 出现在思考中间，
 * 而不是等全部思考流完再补一句。本文件第一版把产出放在流末尾，于是"有产出就不杀"
 * 的对照组全挂了：到 1000 字时产出还没出现，判据当然认为它是静默的。
 * 挂得对 —— 是测试不真实，不是判据错。
 */
function interleaved(text, at, produce, size = 32) {
  const blocks = text.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) || []
  const cut = Math.ceil(at / size)
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    ...blocks.slice(0, cut).map((t) => ({ type: 'reasoning-delta', index: 0, text: t })),
    ...produce,
    ...blocks.slice(cut).map((t) => ({ type: 'reasoning-delta', index: 0, text: t })),
  ]
}

const deltasOf = (out) => out
  .filter((c) => c.type === 'reasoning-delta')
  .reduce((n, c) => n + c.text.length, 0)

/* -------------------------------------------------------------------------- */
/* 1. 流内早杀真的在阈值处截断                                                  */
/* -------------------------------------------------------------------------- */

test('★ 流内早杀：思考到阈值还没有产出，就地截断，不等这一轮自己停', async () => {
  const agent = resumeAgent()
  const { stream, warnings } = host(agent, { silentReasoningChars: 1000, ledgerPath: ledgerFor('cut') })
  const full = prose(9000)

  const out = await drive(stream, reasoningChunks(full))

  // 关键断言：**没有把 9000 个字流完**。阈值 1000 + 32 字一块 ⇒ 大约 1024 就该停。
  const emitted = deltasOf(out)
  assert.ok(emitted >= 1000, `截断点不该早于阈值，实际 ${emitted}`)
  assert.ok(emitted < 2000, `★ 必须在阈值附近就停，实际流出了 ${emitted} / ${full.length} 个字`)

  const last = out.at(-1)
  assert.equal(last.type, 'finish')
  assert.equal(last.reason.kind, 'stop', 'stop 才合法：这是一个被关掉的调用，不是失败的调用')
  assert.ok(warnings.some((w) => w.includes('cut a silent stream')), '日志要留下这一刀')
})

test('★ 流内早杀不留下开着的块（否则 stop finish 违反流语法）', async () => {
  // `llm/invariant` 在还有块开着时拒绝 `stop` finish。把"没有块开着"直接测出来，
  // 而不是从 finish 的 kind 反推 —— 这正是原作者那次踩过的坑
  //（"finished with 1 open block(s)"）。
  const agent = resumeAgent()
  const { stream } = host(agent, { silentReasoningChars: 1000, ledgerPath: ledgerFor('open') })
  const out = await drive(stream, reasoningChunks(prose(9000)))

  const open = new Set()
  for (const c of out) {
    if (c.type === 'block-start') open.add(c.index)
    if (c.type === 'block-end') open.delete(c.index)
  }
  assert.deepEqual([...open], [], '收尾时不许有块开着')
})

test('★ 流内早杀之后，换气接着开新一轮（不是把会话丢在那里）', async () => {
  const agent = resumeAgent()
  const { stream } = host(agent, { silentReasoningChars: 1000, ledgerPath: ledgerFor('resume') })
  await drive(stream, reasoningChunks(prose(9000)))

  assert.equal(agent.followups.length, 0, '回合还没收尾，不许现在就唤醒')
  await agent.settle()

  assert.equal(agent.followups.length, 1, '收尾之后必须恰好续一轮')
  const text = agent.followups[0].content.map((b) => b.text ?? '').join('')
  assert.match(text, /〔换气〕/, '续跑要带上换气文案')
  assert.match(text, /已在流中截断/, '★ 而且要说清是"想太久没动手"，不是"预算烧光了"')
  assert.doesNotMatch(text, /复述/, '只要求继续任务，不许要求收尾')
})

/* -------------------------------------------------------------------------- */
/* 2. 对照组：有产出就不杀                                                      */
/* -------------------------------------------------------------------------- */

test('★ 对照：思考途中说了话，之后想得再久也不许截断', async () => {
  // 这条判据的全部依据就是"有没有产出"。守不住这一条，它就从"防卡死"
  // 变成"不许长思考"，那是另一件事。
  // ★ 产出插在思考**中间**（第 500 字处）—— 真实模型是边想边说的。
  const agent = resumeAgent()
  const { stream, warnings } = host(agent, { silentReasoningChars: 1000, ledgerPath: ledgerFor('ok') })
  const out = await drive(stream, interleaved(prose(9000), 500, [
    { type: 'text-delta', index: 1, text: '好，我看完了。' },
  ]))

  assert.equal(warnings.filter((w) => w.includes('cut a silent stream')).length, 0, '有产出就不许截断')
  assert.ok(out.some((c) => c.type === 'text-delta'), '那句正文要原样流出去')
  assert.equal(out.filter((c) => c.type === 'finish').length, 0, '没有截断就没有合成的 finish')
  assert.ok(deltasOf(out) > 5000, `思考应当继续流下去，实际只流了 ${deltasOf(out)}`)
})

test('★ 对照：工具调用也算产出，同样不许截断', async () => {
  const agent = resumeAgent()
  const { stream, warnings } = host(agent, { silentReasoningChars: 1000, ledgerPath: ledgerFor('tool') })
  const out = await drive(stream, interleaved(prose(9000), 500, [
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1 },
  ]))
  assert.equal(warnings.filter((w) => w.includes('cut a silent stream')).length, 0, '工具调用就是产出')
  assert.ok(deltasOf(out) > 5000, `思考应当继续流下去，实际只流了 ${deltasOf(out)}`)
})

/* -------------------------------------------------------------------------- */
/* 3. 边界                                                                     */
/* -------------------------------------------------------------------------- */

test('★ 没到阈值就自己停下来的，流内不杀（那条由流末判据接）', async () => {
  const agent = resumeAgent()
  const { stream, warnings } = host(agent, { silentReasoningChars: 3000, ledgerPath: ledgerFor('under') })
  const out = await drive(stream, reasoningChunks(prose(2500)))
  assert.equal(warnings.filter((w) => w.includes('cut a silent stream')).length, 0, '2500 < 3000，不该动刀')
  // ★ 别断言 `out.at(-1)` 是 reasoning-delta —— 流末那条判据会照样出手（正是下一个用例要证明的），
  //   于是末尾会多一个合成的 finish。真正要证明的是"思考一个字不少地流完了"。
  assert.equal(deltasOf(out), 2500, '思考应当一个字不少地流完（被砍就会短）')
})

test('★ `silentReasoningChars: 0` 关掉流内早杀，只留流末那条', async () => {
  // 关掉之后，5000 字的纯思考应当完整流完 —— 这才证明 0 真的关掉了它，
  // 而不是碰巧阈值没到。
  const agent = resumeAgent()
  const { stream, warnings } = host(agent, { silentReasoningChars: 0, reasoningOnlySteps: 0 + 1, ledgerPath: ledgerFor('off') })
  const out = await drive(stream, reasoningChunks(prose(5000)))
  assert.equal(warnings.filter((w) => w.includes('cut a silent stream')).length, 0, '关掉就是关掉')
  assert.equal(deltasOf(out), 5000, '思考应当一个字不少地流完')
})

/* -------------------------------------------------------------------------- */
/* 4. 流末那条：短循环也要接住                                                  */
/* -------------------------------------------------------------------------- */

test('★★ 流末判定：没长到阈值就自己停的循环，靠 `reasoningOnlySteps: 1` 接住', async () => {
  // 这是那次真正的病根：`observe()` 早就判对了 `reasoning-only`，
  // 但门槛停在 3 —— 而真实情况是**第一次卡住就没人管了**。
  // 实测本会话 6737 步里 `reasoning-only` 只出现 4 次，4 次全是循环，误报约等于零。
  const agent = resumeAgent()
  const { stream } = host(agent, {
    silentReasoningChars: 3000,
    reasoningOnlySteps: 1,
    ledgerPath: ledgerFor('short'),
  })
  await drive(stream, reasoningChunks(prose(2500)))
  await agent.settle()

  assert.equal(agent.followups.length, 1, '2500 字、零产出 —— 一次就该出手')
  const text = agent.followups[0].content.map((b) => b.text ?? '').join('')
  assert.match(text, /〔换气〕/)
})

test('★★ 反向对照：门槛留在 3，同样这一步就接不住（这条改动的存在理由）', async () => {
  const agent = resumeAgent()
  const { stream } = host(agent, {
    silentReasoningChars: 3000,
    reasoningOnlySteps: 3,
    ledgerPath: ledgerFor('legacy'),
  })
  await drive(stream, reasoningChunks(prose(2500)))
  await agent.settle()

  assert.equal(agent.followups.length, 0, '旧门槛下，卡一次是没人管的 —— 这正是要改掉的行为')
})

test('★ 产出了正文的正常轮，流末那条也不许动它', async () => {
  const agent = resumeAgent()
  const { stream } = host(agent, { silentReasoningChars: 3000, reasoningOnlySteps: 1, ledgerPath: ledgerFor('normal') })
  await drive(stream, [
    ...reasoningChunks(prose(2500)),
    { type: 'text-delta', index: 1, text: '做完了。' },
  ])
  await agent.settle()
  assert.equal(agent.followups.length, 0, '有正文就是正常轮')
})

/* -------------------------------------------------------------------------- */
/* 5. schema：默认值钉死                                                        */
/* -------------------------------------------------------------------------- */

test('★ 两个新参数的默认值：流内 3000 / 流末 1 次', () => {
  const resolved = plugin.Config({})
  assert.equal(resolved.silentReasoningChars, 3000, '3000 是本会话实测的折中：能掐掉 5140 那次，误杀面约 8.8%')
  assert.equal(resolved.reasoningOnlySteps, 1, '1 是实测结论：reasoning-only 全史 4 次、全是循环')
  // 边界：0 合法（关掉流内早杀），负数非法。
  assert.equal(plugin.Config({ silentReasoningChars: 0 }).silentReasoningChars, 0)
  assert.throws(() => plugin.Config({ silentReasoningChars: -1 }))
  // 边界：流末门槛最低 1（不许 0 —— 那等于把换气层关掉的一半，语义含糊）。
  assert.equal(plugin.Config({ reasoningOnlySteps: 1 }).reasoningOnlySteps, 1)
  assert.throws(() => plugin.Config({ reasoningOnlySteps: 0 }))
  assert.throws(() => plugin.Config({ reasoningOnlySteps: 11 }))
})
