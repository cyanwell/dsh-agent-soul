/**
 * Mid-stream repetition breaker — the issue #2848 shape.
 *
 * #2848 is a single model call that repeated one sentence for ~420,000
 * characters over ten minutes (~2825 text chunks). Every detector that judges a
 * call *after* it ends is structurally too late for that, so v0.1.6 ends the
 * stream from inside the `llm/stream` wrapper.
 *
 * The load-bearing assertions are the ones that exercise `apply()` rather than
 * the pure helper: a breaker that counts correctly but never emits its terminal
 * `finish` would still leave the call running, and that is exactly the failure a
 * helper-only test cannot see. `test/…` runs on the built `lib/index.js`, so
 * these also pin the shipped artifact.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import * as plugin from '../lib/index.js'
import { TextRepetitionDetector, countRepeatedText } from '../lib/index.js'

const CONFIG = {
  maxThinkingSteps: 3,
  minReasoningChars: 2048,
  similarityThreshold: 0.8,
  escalate: 'steer',
  maxFires: 4,
  cancelCause: 'thinking-loop',
  maxRepeatedText: 4,
  breakCode: 'REPETITIVE_OUTPUT',
  breakCorrection: true,
  // The cycle rule (discussion #7043) is on by default in the shipped schema;
  // every assertion above is about the *chunk* rule, so it is switched off here
  // explicitly rather than left to be undefined. The cycle suite below opts in.
  maxRepeatedCycleChars: 0,
  minRepeatedCycleChars: 512,
}

/* -------------------------------------------------------------------------- */
/* the primitives                                                             */
/* -------------------------------------------------------------------------- */

test('countRepeatedText measures the trailing identical run after trimming', () => {
  assert.equal(countRepeatedText([]), 0)
  assert.equal(countRepeatedText(['a', 'b', 'c']), 1)
  assert.equal(countRepeatedText(['a', 'tick', 'tick', 'tick']), 3)
  assert.equal(countRepeatedText(['same ', ' same', 'same']), 3, 'whitespace-only differences are not differences')
})

test('countRepeatedText anchors at the tail, not at any run in the call', () => {
  // An early burst of repeats must not trip a breaker that is watching the
  // stream's CURRENT behaviour — the model resumed working after it.
  assert.equal(countRepeatedText(['x', 'x', 'x', 'progress continues here']), 1)
})

test('countRepeatedText counts blank-only output as repetition', () => {
  assert.equal(countRepeatedText(['\n', '  ', '\n\n']), 3)
})

test('the detector trips exactly once, on the delta that completes the run', () => {
  const d = new TextRepetitionDetector({ ...CONFIG, maxRepeatedText: 3 })
  assert.equal(d.push('tick'), false)
  assert.equal(d.push('tick'), false)
  assert.equal(d.push('tick'), true, 'the third identical delta completes the run')
  assert.equal(d.push('tick'), false, 'a tripped breaker must not report again')
  assert.equal(d.tripped, true)
})

test('the detector ignores repeated bursts shorter than the threshold', () => {
  const d = new TextRepetitionDetector({ ...CONFIG, maxRepeatedText: 10 })
  for (let i = 0; i < 25; i++) assert.equal(d.push(i % 2 === 0 ? 'left' : 'right'), false)
  assert.equal(d.tripped, false)
})

test('the detector tracks emitted characters for the break report', () => {
  const d = new TextRepetitionDetector({ ...CONFIG, maxRepeatedText: 3 })
  d.push('abc')
  d.push('de')
  assert.equal(d.emittedChars, 5)
})

test('`maxRepeatedText: 0` disables the breaker', () => {
  const d = new TextRepetitionDetector({ ...CONFIG, maxRepeatedText: 0 })
  for (let i = 0; i < 500; i++) assert.equal(d.push('tick'), false)
  assert.equal(d.tripped, false)
})

/* -------------------------------------------------------------------------- */
/* through `apply()` — the assertions that can actually fail                  */
/* -------------------------------------------------------------------------- */

/** A minimal Cordis-shaped context capturing the `llm/stream` listener. */
function fakeContext(agent) {
  const listeners = []
  return {
    on(name, listener) {
      if (name === 'llm/stream') listeners.push(listener)
    },
    logger: { warn() {}, debug() {} },
    agents: { get: () => agent },
    fire(options, next) {
      assert.equal(listeners.length, 1, 'apply() must register exactly one llm/stream listener')
      return listeners[0](options, next)
    },
  }
}

/** A guard-able agent stand-in recording the reactions it receives. */
function fakeAgent() {
  const steered = []
  const injected = []
  let cancelled = 0
  return {
    steered,
    injected,
    get cancelled() { return cancelled },
    steer: m => steered.push(m),
    inject: m => injected.push(m),
    cancel: () => { cancelled++ },
  }
}

/**
 * A provider stream that emits `count` identical visible-output deltas.
 *
 * Only `text-delta` chunks are produced — the reported loop emitted text and
 * nothing else, so reasoning deltas and a provider finish would only make the
 * fixture less faithful.
 *
 * @param count - how many identical deltas to emit.
 * @param text - the repeated payload.
 * @param terminal - the chunk the adapter would have finished with.
 */
async function* textStream(count, text = 'The `register` API matches. ', terminal = null) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  for (let i = 0; i < count; i++) yield { type: 'text-delta', index: 0, text }
  if (terminal !== null) yield terminal
}

/** Run one stream through the installed listener and collect every chunk. */
async function collect(agent, count, config = CONFIG, text) {
  const ctx = fakeContext(agent)
  plugin.apply(ctx, { ...CONFIG, ...config })
  const options = markAgentLoopRequest({ sessionId: 's1', provider: 'p', model: 'm', messages: [] })
  const out = []
  for await (const chunk of ctx.fire(options, () => textStream(count, text))) out.push(chunk)
  return out
}

test('a repetitive single call is cut short by closing its block', async () => {
  const agent = fakeAgent()
  const out = await collect(agent, 50)
  const deltas = out.filter(c => c.type === 'text-delta')
  const finish = out.at(-1)

  assert.equal(deltas.length, 4, 'the stream must stop at the threshold, not run to the model max_tokens')
  assert.equal(finish.type, 'finish', 'the last chunk must be terminal — a bare return violates the llm invariant')
  // A closed call, not a failed one: `error` would settle as an `assistant/attempt`
  // with no `assistant/message`, which the conversation renderer cannot draw, and
  // `turn()` would throw before it could claim the queued correction.
  assert.equal(finish.reason.kind, 'stop')
  assert.equal(finish.reason.failure, undefined)
  assert.ok(out.some(c => c.type === 'block-end'), 'the open text block must be closed before the finish')
})

test('the terminal finish is the last chunk: nothing follows it', async () => {
  const out = await collect(fakeAgent(), 50)
  const at = out.findIndex(c => c.type === 'finish')
  assert.ok(at > 0, 'a finish must be emitted')
  assert.equal(at, out.length - 1, 'the invariant rejects any chunk after terminal finish')
})

test('the pending deltas after the break are dropped, not flushed', async () => {
  // The fixture's adapter would keep going to 50; the breaker must abandon the
  // upstream iteration rather than drain it into the durable log.
  const out = await collect(fakeAgent(), 5000)
  assert.equal(out.filter(c => c.type === 'text-delta').length, 4)
})

test('the break steers the agent with the observed size of the repetition', async () => {
  const agent = fakeAgent()
  await collect(agent, 50)
  assert.equal(agent.steered.length, 1, 'the correction must be queued before the finish')
  const text = agent.steered[0].content.map(b => b.text).join('')
  // The wording is localized (Chinese by default), so this asserts the observed
  // size and the localized noun rather than an English phrase.
  assert.match(text, /可见输出/)
  assert.match(text, /\d+/)
})

test('`breakCorrection: false` still breaks but says nothing', async () => {
  const agent = fakeAgent()
  const out = await collect(agent, 50, { breakCorrection: false })
  assert.equal(out.at(-1).reason.kind, 'stop')
  assert.equal(agent.steered.length, 0)
})

/**
 * A Cordis-shaped context whose `llm/stream` listeners form the real chain.
 *
 * `prepend` listeners are called first (the shipped invariant registers that
 * way), so the array order here IS the wrapper nesting the llm service builds.
 */
function chainContext(agent) {
  const listeners = []
  const ctx = {
    on(name, listener, options) {
      if (name !== 'llm/stream') return
      if (options?.prepend) listeners.unshift(listener)
      else listeners.push(listener)
    },
    logger: { warn() {}, debug() {} },
    agents: { get: () => agent },
    get: () => undefined,
  }
  return { ctx, listeners }
}

/** Install the shipped dsh-llm invariant, returning the failures it records. */
async function installInvariant(context) {
  const { apply } = await import('@deepseek-ai/dsh-llm/invariant')
  const failures = []
  const fail = m => failures.push(m)
  const inner = new Proxy(context, { get: (t, k) => (k === 'on' ? t.on.bind(t) : t[k]) })
  await apply(
    { ...inner, invariants: { register: (_name, installer) => installer(inner, fail) } },
    fail,
  )
  return failures
}

/** Drive one raw stream through the whole installed chain. */
async function runChain(listeners, options, source) {
  const out = []
  const step = i => (i >= listeners.length
    ? source()
    : listeners[i](options, () => step(i + 1)))
  for await (const chunk of step(0)) out.push(chunk)
  return out
}

test('the break finish is protocol-legal: the shipped llm invariant accepts it', async () => {
  // The breaker fires with the call's text block still OPEN. The invariant fails
  // a `stop` finish while any block is open, so the break closes the block first;
  // this runs the wrapper's own output through the real validator instead of
  // trusting a reading of the source — an earlier bare `stop` got exactly this
  // wrong ("finished with 1 open block(s)").
  const { ctx, listeners } = chainContext(fakeAgent())
  const failures = await installInvariant(ctx)
  plugin.apply(ctx, CONFIG)
  assert.equal(listeners.length, 2, 'the chain must be invariant -> plugin')

  const options = markAgentLoopRequest({ sessionId: 's1', provider: 'p', model: 'm', messages: [] })
  const seen = await runChain(listeners, options, () => textStream(50))

  assert.deepEqual(failures, [], 'the synthesized finish must not violate the stream grammar')
  assert.equal(seen.at(-1).type, 'finish')
  assert.equal(seen.at(-1).reason.kind, 'stop')
})

test('an UNBROKEN repetitive call would have failed only at the provider ceiling', async () => {
  // Control for the test above: the same fixture WITHOUT the plugin ends at the
  // adapter's own terminal chunk. It proves the chain harness itself is sound,
  // so the two tests differ only by the breaker.
  const raw = await (async () => {
    const out = []
    for await (const c of textStream(50, undefined, { type: 'finish', reason: { kind: 'stop' } })) out.push(c)
    return out
  })()
  assert.equal(raw.filter(c => c.type === 'text-delta').length, 50, 'without the breaker all 50 deltas flow')
  assert.deepEqual(raw.at(-1).reason, { kind: 'stop' })
})

test('a call inside the threshold is left completely alone', async () => {
  const agent = fakeAgent()
  // 3 identical deltas against a threshold of 4 — a legitimately repeated short
  // line (a header row, a log prefix) must not be treated as degeneration.
  const out = await collect(agent, 3, { maxRepeatedText: 4 })
  assert.equal(out.filter(c => c.type === 'text-delta').length, 3)
  assert.equal(out.at(-1).type, 'text-delta', 'no finish may be synthesized for a healthy call')
  assert.equal(agent.steered.length, 0)
})

test('varying visible output never trips the breaker', async () => {
  const agent = fakeAgent()
  const ctx = fakeContext(agent)
  plugin.apply(ctx, CONFIG)
  const options = markAgentLoopRequest({ sessionId: 's1', provider: 'p', model: 'm', messages: [] })
  async function* varying() {
    for (let i = 0; i < 200; i++) yield { type: 'text-delta', index: 0, text: `chunk number ${i} ` }
  }
  const out = []
  for await (const chunk of ctx.fire(options, () => varying())) out.push(chunk)
  assert.equal(out.filter(c => c.type === 'text-delta').length, 200)
  assert.equal(agent.steered.length, 0)
})

/* -------------------------------------------------------------------------- */
/* the cycle rule — discussion #7043                                          */
/* -------------------------------------------------------------------------- */

/**
 * The two shapes as reported: a four-line cycle of short CJK fragments, and the
 * mixed-language variant that proves the bleed crosses a language boundary.
 * Both are cycled periods, not repeated deltas — the distinction the chunk rule
 * cannot see.
 */
const CYCLE_ZH = '好。\n发。\n好。\n好。\n'
const CYCLE_MIXED = 'Emitting.\n好。\n发。\n好。\n好。\n'

/** The rule under test, on its shipped defaults, with the chunk rule off. */
const CYCLE_ON = { ...CONFIG, maxRepeatedText: 0, maxRepeatedCycleChars: 64, minRepeatedCycleChars: 256 }

/** One delta per line: the least favourable chunking for a delta-based rule. */
function lineDeltas(cycle, repeats) {
  return cycle.repeat(repeats).split(/(?<=\n)/).filter(s => s !== '')
}

test('trailingCycle finds a short verbatim period and ignores everything else', () => {
  assert.equal(plugin.trailingCycle('nothing repeats here at all', 64, 256), 0)
  assert.equal(plugin.trailingCycle(CYCLE_ZH.repeat(40), 64, 256), 256, '12-char period, span reported at the minimum')
  assert.equal(plugin.trailingCycle(CYCLE_MIXED.repeat(40), 64, 256), 256, '26-char period, same contract')
  assert.equal(plugin.trailingCycle(CYCLE_ZH.repeat(5), 64, 256), 0, 'a span below the minimum is not a bleed')
})

test('trailingCycle refuses a one-character period, so long divider lines survive', () => {
  // '=' * 400 is technically periodic; a generated document may legitimately
  // contain a long rule line, and the chunk rule still covers the pathological
  // single-character bleed.
  assert.equal(plugin.trailingCycle('='.repeat(400), 64, 256), 0)
  assert.equal(plugin.trailingCycle('─'.repeat(400), 64, 256), 0)
})

test('the reported shape trips the cycle rule, and the chunk rule would not have', () => {
  const d = new TextRepetitionDetector({ ...CYCLE_ON, maxRepeatedText: 60 })
  let fired = 0
  for (const delta of lineDeltas(CYCLE_ZH, 40)) if (d.push(delta)) fired++
  assert.equal(fired, 1, 'exactly one delta completes the detection')
  assert.equal(d.trippedBy, 'repeating-cycle')
  assert.ok(d.emittedChars < 400, `must fire inside the first few hundred characters, fired at ${d.emittedChars}`)
  assert.equal(countRepeatedText(lineDeltas(CYCLE_ZH, 40)), 2, 'the chunk rule sees a run of only 2 — that is the bug')
})

test('the mixed-language variant trips the same way', () => {
  const d = new TextRepetitionDetector(CYCLE_ON)
  for (const delta of lineDeltas(CYCLE_MIXED, 40)) if (d.push(delta)) break
  assert.equal(d.tripped, true)
  assert.equal(d.trippedBy, 'repeating-cycle')
})

test('a bleed emitted without any newline is caught identically', () => {
  // The reported shape is displayed as lines, but a provider may stream the same
  // bleed with no line break at all; a character-level period does not care.
  const d = new TextRepetitionDetector(CYCLE_ON)
  for (let i = 0; i < 60; i++) if (d.push('好。发。好。好。')) break
  assert.equal(d.tripped, true)
})

test('legitimately repetitive output is NOT flagged (the false-positive control)', () => {
  // These are the samples the ratio-based alternative would have been ~0.06 away
  // from: a real table, generated CSS, a JSON dump, a log listing, repeated code
  // stubs and a uniform bullet list. Every one is periodic-looking to a coverage
  // measure and none of them is periodic.
  const samples = {
    'markdown table': '| id | name | status |\n| --- | --- | --- |\n'
      + Array.from({ length: 40 }, (_, i) => `| ${i} | item-${i} | ${i % 2 ? 'ok' : 'pending'} |\n`).join(''),
    'generated css': Array.from({ length: 40 }, (_, i) => `.row-${i} { display: flex; align-items: center; gap: 8px; }\n`).join(''),
    'json dump': JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ id: i, kind: 'item', enabled: true })), null, 2),
    'log listing': Array.from({ length: 60 }, (_, i) => `2026-09-18T16:0${i % 10}:00 INFO processing record ${i} done\n`).join(''),
    'code stubs': Array.from({ length: 40 }, (_, i) => `export function handler${i}(ctx: Context): void {\n  ctx.logger.info('handler ${i}')\n}\n`).join(''),
    'bullet list': Array.from({ length: 40 }, (_, i) => `- step ${i + 1}: run the same command and check the output\n`).join(''),
  }
  for (const [label, text] of Object.entries(samples)) {
    const d = new TextRepetitionDetector(CYCLE_ON)
    let tripped = false
    for (const delta of text.split(/(?<=\n)/)) if (d.push(delta)) { tripped = true; break }
    assert.equal(tripped, false, `${label} must not be flagged`)
  }
})

test('`maxRepeatedCycleChars: 0` disables the cycle rule but not the chunk rule', () => {
  const d = new TextRepetitionDetector({ ...CYCLE_ON, maxRepeatedText: 4, maxRepeatedCycleChars: 0 })
  for (const delta of lineDeltas(CYCLE_ZH, 40)) d.push(delta)
  assert.equal(d.tripped, false, 'the cycle rule is off')
  for (let i = 0; i < 4; i++) d.push('tick')
  assert.equal(d.tripped, true)
  assert.equal(d.trippedBy, 'identical-chunks')
})

test('a cycled stream is cut through apply() with a terminal error finish', async () => {
  // The helper test above cannot see whether the wrapper actually stops the call;
  // this is the assertion that fails if the breaker counts but never emits.
  const agent = fakeAgent()
  const ctx = fakeContext(agent)
  plugin.apply(ctx, CYCLE_ON)
  const options = markAgentLoopRequest({ sessionId: 's1', provider: 'p', model: 'm', messages: [] })
  const deltas = lineDeltas(CYCLE_ZH, 40)
  async function* cycled() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    for (const text of deltas) yield { type: 'text-delta', index: 0, text }
  }
  const out = []
  for await (const chunk of ctx.fire(options, () => cycled())) out.push(chunk)

  assert.ok(out.filter(c => c.type === 'text-delta').length < deltas.length, 'the stream must be cut, not drained')
  assert.equal(out.at(-1).type, 'finish')
  assert.equal(out.at(-1).reason.kind, 'stop')
  assert.ok(out.some(c => c.type === 'block-end'), 'the open text block must be closed before the finish')
  assert.equal(agent.steered.length, 1, 'the correction must be queued before the finish')
})

test('the schema ships the cycle rule on, with its documented defaults', () => {
  const resolved = plugin.Config({})
  assert.equal(resolved.maxRepeatedCycleChars, 512)
  assert.equal(resolved.minRepeatedCycleChars, 256)
  assert.equal(plugin.Config({ maxRepeatedCycleChars: 0 }).maxRepeatedCycleChars, 0, '0 must survive as the off switch')
  assert.throws(() => plugin.Config({ minRepeatedCycleChars: 1 }))
})

/* -------------------------------------------------------------------------- */
/* configuration                                                              */
/* -------------------------------------------------------------------------- */

test('the schema accepts the breaker keys and applies their defaults', () => {
  // Guards a real failure mode: schemastery reserves some key names, and a
  // collision fails at plugin *load* rather than in a type check.
  const resolved = plugin.Config({})
  assert.equal(resolved.maxRepeatedText, 60)
  assert.equal(resolved.breakCode, 'REPETITIVE_OUTPUT')
  assert.equal(resolved.breakCorrection, true)
  assert.equal(plugin.Config({ maxRepeatedText: 0 }).maxRepeatedText, 0, '0 must survive as the documented off switch')
})

test('the schema rejects a negative repetition threshold', () => {
  assert.throws(() => plugin.Config({ maxRepeatedText: -1 }))
})

/* -------------------------------------------------------------------------- */
/* the visible-output period cap — the regression that shipped broken         */
/* -------------------------------------------------------------------------- */

/**
 * A real visible-output bleed, reproduced from a session file: a 44 387-character
 * assistant message whose loop starts at character 139 and whose exact minimal
 * period is **172** characters, stable across every tail window from 512 to
 * 16 384.
 *
 * The shape is a small pool of short lines — `好。` / `我写报告。` / `（写）` /
 * `现在。` — which is why the chunk rule cannot see it (no two consecutive
 * deltas are equal) and why the *period* is 172 rather than the 12 of the
 * discussion-#7043 sample.
 */
const BLEED_POOL = ['好。', '我写报告。', '（写）', '现在。', '写。', '我写。', '写报告。']
const BLEED_PERIOD = (() => {
  let out = ''
  let i = 0
  while (out.length < 172) {
    out += BLEED_POOL[i % BLEED_POOL.length] + '\n'
    i++
  }
  return out.slice(0, 172)
})()

test('a 172-character period is invisible to the OLD 64 cap and caught by the shipped one', () => {
  // This is the regression, stated as the two numbers that matter. The old
  // default was 64; the measured period is 172; `trailingCycle` returns 0 for a
  // cap below the period, which is a SILENT failure — no fire, no log, and the
  // call runs to tens of thousands of characters.
  const text = BLEED_PERIOD.repeat(30)
  assert.equal(text.length, 5160)
  assert.equal(plugin.trailingCycle(text, 64, 256), 0, 'the old default could not see it — that was the bug')
  assert.ok(plugin.trailingCycle(text, 512, 256) > 0, 'the shipped default must see it')
})

test('the shipped period cap must exceed every measured visible-output period', () => {
  // The same assertion the reasoning side carries, for the same reason: a cap
  // below a real period fails silently. Measured periods on this side: 12 and 26
  // (discussion #7043), and 172 (the 44 387-character bleed).
  const MEASURED_PERIODS = [12, 26, 172]
  const cap = plugin.Config({}).maxRepeatedCycleChars
  for (const period of MEASURED_PERIODS) {
    assert.ok(cap > period, `cap ${cap} must exceed the measured period ${period}`)
  }
})

test('the real 172-period bleed is cut mid-stream through apply()', async () => {
  // End to end, through the wrapper, on the shipped defaults for the cycle rule:
  // the assertion that fails if the cap regresses, and the one that proves the
  // bleed is cut rather than merely measured.
  const config = { ...CONFIG, maxRepeatedText: 0, maxRepeatedCycleChars: 512, minRepeatedCycleChars: 256 }
  const agent = fakeAgent()
  const ctx = fakeContext(agent)
  plugin.apply(ctx, config)
  const options = markAgentLoopRequest({ sessionId: 's1', provider: 'p', model: 'm', messages: [] })
  const total = BLEED_PERIOD.repeat(60)
  async function* bleeding() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    for (let i = 0; i < total.length; i += 16) {
      yield { type: 'text-delta', index: 0, text: total.slice(i, i + 16) }
    }
  }
  const out = []
  for await (const chunk of ctx.fire(options, () => bleeding())) out.push(chunk)

  const emitted = out.filter(c => c.type === 'text-delta').reduce((n, c) => n + c.text.length, 0)
  assert.ok(emitted < total.length, 'the stream must be cut, not drained')
  assert.ok(emitted < 2000, `must cut inside the first couple of thousand characters, cut at ${emitted}`)
  assert.equal(out.at(-1).type, 'finish')
  assert.equal(out.at(-1).reason.kind, 'stop')
  assert.equal(agent.steered.length, 1)
})
