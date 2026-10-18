/**
 * The reasoning bleed breaker — the issue #5976 shape.
 *
 * #5976 is a model that degrades into a pure reasoning bleed and never returns:
 * no `text-delta`, no `tool-call-delta`, so the step never settles and the
 * harness turn loop never breaks. Every post-call detector here is structurally
 * too late for it, and the visible-output breaker is blind to it by design.
 *
 * The thresholds asserted below are not invented. They were calibrated on a real
 * 174 MB reproduction (4628 calls, dsh 0.1.5-rc.2), of which 1005 had >= 2048
 * reasoning characters:
 *
 *   - the seven bleeds in that session have measured periods of 89-235 chars;
 *   - `maxPeriod: 64` — the visible-output default — finds 0 of them;
 *   - `maxPeriod: 128` and above find the same 7 and nothing else (a plateau);
 *   - 0 of the 997 calls that produced text or a tool call trip the rule, while
 *     the highest-`rr` non-loop call (0.833) has no period at all.
 *
 * The load-bearing assertions exercise `apply()`, not just the pure helper: a
 * breaker that detects correctly but never emits its terminal `finish` would
 * leave the call running forever, which is the whole failure. `test/…` runs on
 * the built `lib/index.js`, so these also pin the shipped artifact.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import * as plugin from '../lib/index.js'
import { ReasoningLoopBreaker, trailingCycle, periodicTailSpan } from '../lib/index.js'

/**
 * Real reasoning tails captured from the reproduction.
 *
 * Real beats synthetic here: a generated "periodic" string is easy to get wrong
 * (a fixed literal cycles at its own length, and a counter can introduce a
 * *shorter* period than intended), which is exactly the trap this suite hit
 * while being written. These samples carry the actual periods, character
 * distribution and newline placement of the reported failure.
 */
const FIXTURE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures-reasoning-bleed.json'), 'utf8'),
)

const CONFIG = {
  maxThinkingSteps: 3,
  minReasoningChars: 2048,
  similarityThreshold: 0.8,
  escalate: 'steer',
  maxFires: 4,
  cancelCause: 'thinking-loop',
  // The two visible-output rules are switched off so every assertion below is
  // about the reasoning rule alone; a bleed in reasoning emits no text at all,
  // so this also mirrors the reported failure exactly.
  maxRepeatedText: 0,
  maxRepeatedCycleChars: 0,
  minRepeatedCycleChars: 512,
  maxRepeatedReasoningCycleChars: 512,
  minRepeatedReasoningCycleChars: 512,
  // The line-repeat rule is a separate detector with its own suite
  // (`reasoning-lines.spec.mjs`); switching it off keeps every assertion here
  // about the verbatim-cycle rule alone.
  maxRepeatedReasoningLineChars: 0,
  minRepeatedReasoningLineCoverage: 0.6,
  breakCode: 'REPETITIVE_OUTPUT',
  breakCorrection: true,
}

/**
 * The largest real bleed (period 187), used to drive `apply()` end to end.
 * A second copy is concatenated so the emitted-total check has room to show
 * that the cut lands far from the end.
 */
const BLEED = FIXTURE.loops.find((l) => l.minPeriod > 0).text.repeat(3)

/** A cyclic burst too short to judge — the legitimate-scratch-repetition control. */
const SHORT = (() => {
  const loop = FIXTURE.loops.find((l) => l.minPeriod > 0)
  // Strictly below the qualifying span, so the rule has nothing to act on yet.
  return loop.text.slice(-Math.floor(CONFIG.minRepeatedReasoningCycleChars / 2))
})()

/** Feed a reasoning text through the breaker at a fixed chunk size. */
function trip(text, config = CONFIG, size = 32) {
  const breaker = new ReasoningLoopBreaker(config)
  const pieces = text.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) || []
  for (const piece of pieces) if (breaker.push(piece)) return breaker.emittedChars
  return 0
}

/* -------------------------------------------------------------------------- */
/* the primitive, against real captures                                        */
/* -------------------------------------------------------------------------- */

test('every real reasoning bleed trips the breaker', () => {
  // `seq 27953` is excluded here on purpose: its cycle develops late, outside
  // the 4096-character tail this fixture carries. It is asserted separately.
  const caught = FIXTURE.loops.filter((l) => l.minPeriod > 0)
  assert.ok(caught.length >= 6, 'fixture must carry the cycling bleeds')
  for (const loop of caught) {
    assert.ok(trip(loop.text) > 0, `seq ${loop.seq} (period ${loop.minPeriod}) must trip`)
  }
})

test('the reported periods really sit above the visible-output threshold', () => {
  // This is why the fix is a reasoning rule and not a widened text rule: the
  // measured periods are 89-235 characters, and the shipped visible-output
  // default is 64.
  const periods = FIXTURE.loops.map((l) => l.minPeriod).filter((p) => p > 0)
  assert.ok(Math.min(...periods) > 64, `smallest measured period is ${Math.min(...periods)}`)
  for (const loop of FIXTURE.loops) {
    if (loop.minPeriod <= 0) continue
    assert.equal(trailingCycle(loop.text, 64, 512), 0, `period ${loop.minPeriod} must be invisible to maxPeriod 64`)
    assert.ok(trailingCycle(loop.text, 256, 512) > 0)
  }
})

test('the breaker trips early, not at the end of the bleed', () => {
  // On the real session a 357,112-character bleed is caught at 512 characters.
  // The fixture is a 4096-character tail, so the cut must land well inside it.
  for (const loop of FIXTURE.loops) {
    if (loop.minPeriod <= 0) continue
    const at = trip(loop.text)
    assert.ok(at > 0 && at < loop.text.length / 2, `seq ${loop.seq} cut at ${at} of ${loop.text.length}`)
  }
})

test('the breaker leaves real productive reasoning alone', () => {
  // The false-positive control: these are genuine calls that produced text or a
  // tool call. Measured over the whole session, 0 of 997 productive calls trip.
  assert.ok(FIXTURE.normals.length >= 3)
  for (const normal of FIXTURE.normals) {
    assert.equal(trip(normal.text), 0, `seq ${normal.seq} (rr ${normal.rr}) must not be cut`)
  }
})

test('a high repeat ratio alone is not enough — periodicity is the signal', () => {
  // The highest-rr non-loop call in the session has no period at all, so a
  // ratio rule would flag it while the exact rule does not.
  const high = FIXTURE.normals.filter((n) => n.rr > 0.7)
  assert.ok(high.length > 0, 'fixture must carry a high-rr normal call')
  for (const n of high) {
    assert.equal(trip(n.text), 0, `seq ${n.seq} has rr ${n.rr} but must not be cut`)
  }
})

test('the breaker leaves coherent reasoning alone', () => {
  const breaker = new ReasoningLoopBreaker(CONFIG)
  // Long, varied reasoning with no verbatim period — the shape of the 997
  // productive calls that the rule must not touch.
  const text = Array.from({ length: 400 }, (_, i) =>
    `Step ${i}: reading the file, the parser at line ${i * 7} handles the ${i % 3 === 0 ? 'leading' : 'trailing'} case. `,
  ).join('')
  let tripped = false
  for (const piece of text.match(/[\s\S]{1,32}/g)) if (breaker.push(piece)) { tripped = true; break }
  assert.equal(tripped, false)
})

test('a repeated heading or divider is not a bleed', () => {
  const breaker = new ReasoningLoopBreaker(CONFIG)
  // One-character periods are refused, so a long rule line stays legitimate.
  const text = '='.repeat(4000)
  let tripped = false
  for (const piece of text.match(/[\s\S]{1,32}/g)) if (breaker.push(piece)) { tripped = true; break }
  assert.equal(tripped, false)
  assert.equal(trailingCycle('='.repeat(4000), 256, 512), 0)
})

test('reasoning shorter than minRepeatedReasoningCycleChars is never cut', () => {
  const breaker = new ReasoningLoopBreaker(CONFIG)
  // Legitimate cycling that is simply too short to judge.
  assert.ok(SHORT.length < CONFIG.minRepeatedReasoningCycleChars)
  let tripped = false
  for (const piece of SHORT.match(/[\s\S]{1,32}/g)) if (breaker.push(piece)) { tripped = true; break }
  assert.equal(tripped, false)
})

test('`maxRepeatedReasoningCycleChars: 0` disables the reasoning rule', () => {
  const breaker = new ReasoningLoopBreaker({ ...CONFIG, maxRepeatedReasoningCycleChars: 0 })
  const loop = FIXTURE.loops.find((l) => l.minPeriod > 0)
  let tripped = false
  for (const piece of loop.text.match(/[\s\S]{1,32}/g)) if (breaker.push(piece)) { tripped = true; break }
  assert.equal(tripped, false)
})

test('the breaker trips exactly once', () => {
  const breaker = new ReasoningLoopBreaker(CONFIG)
  const loop = FIXTURE.loops.find((l) => l.minPeriod > 0)
  const pieces = loop.text.match(/[\s\S]{1,32}/g)
  let trips = 0
  for (const piece of pieces) if (breaker.push(piece)) trips++
  assert.equal(trips, 1)
})

/* -------------------------------------------------------------------------- */
/* through apply() — the assertion a helper-only test cannot make             */
/* -------------------------------------------------------------------------- */

/** A host that captures what the plugin does to a live stream. */
function host(overrides = {}) {
  const config = { ...CONFIG, ...overrides }
  const steered = []
  const warnings = []
  const agent = {
    inject: () => {},
    steer: (m) => steered.push(m),
    cancel: () => {},
  }
  let stream = null
  const ctx = {
    logger: { warn: (m) => warnings.push(m), debug: () => {}, info: () => {}, error: () => {} },
    agents: { get: () => agent },
    on: (event, listener) => { if (event === 'llm/stream') stream = listener },
  }
  plugin.apply(ctx, config)
  assert.equal(typeof stream, 'function')
  return { stream, steered, warnings, agent }
}

/** Drive the wrapper with a chunk sequence and collect everything it yields. */
async function drive(stream, chunks) {
  const options = markAgentLoopRequest({ sessionId: 's1' })
  const out = []
  for await (const chunk of stream(options, async function* source() { for (const c of chunks) yield c })) {
    out.push(chunk)
  }
  return out
}

/**
 * A realistic reasoning stream: one `block-start`, then indexed deltas.
 *
 * The index and the open block matter: a real provider always opens a block
 * before streaming into it, and the break's whole job is to close what is open.
 * Emitting bare deltas with no block would test a shape no adapter produces.
 */
function reasoningChunks(text, size = 32, index = 0) {
  const deltas = (text.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) || [])
    .map((t) => ({ type: 'reasoning-delta', index, text: t }))
  return [{ type: 'block-start', index, blockType: 'reasoning' }, ...deltas]
}

test('a reasoning bleed is cut by closing its block, not by failing the call', async () => {
  const { stream, steered, warnings } = host()
  const out = await drive(stream, reasoningChunks(BLEED))
  const last = out.at(-1)
  assert.equal(last.type, 'finish')
  // A `stop` finish, not `error`: see the block below for why the call must be
  // closed rather than failed.
  assert.equal(last.reason.kind, 'stop')
  // Every block the provider opened is closed before the finish, which is what
  // makes the `stop` legal.
  assert.ok(out.some((c) => c.type === 'block-end'))
  // The correction is queued so the resumed turn is told what happened. The
  // wording follows the host language (Chinese by default), so this asserts the
  // localized noun rather than an English phrase.
  assert.equal(steered.length, 1)
  assert.match(steered[0].content[0].text, /思考内容/)
  assert.ok(warnings.some((w) => w.includes('reasoning-cycle')))
})

test('the break leaves no block open, so the invariant accepts the stop finish', async () => {
  // The invariant fails a `stop` finish while any block is open, so "no block
  // left open" is the precise property that makes the break legal. Tracked here
  // directly rather than inferred from the finish reason.
  const { stream } = host()
  const out = await drive(stream, reasoningChunks(BLEED))
  const open = new Set()
  for (const c of out) {
    if (c.type === 'block-start') open.add(c.index)
    if (c.type === 'block-end') open.delete(c.index)
  }
  assert.deepEqual([...open], [], 'no block may remain open at the finish')
})

test('the break produces a renderable assistant message, not an attempt', async () => {
  // This is the regression that mattered in production. `agent-loop` settles an
  // `error` finish as an `assistant/attempt` and appends NO `assistant/message`,
  // so the conversation renderer built a null node for a target it had already
  // materialized and threw:
  //   conversation Definition "assistant-step" withdrew materialized target "chat"
  // The break must therefore reach the ordinary path, where `live.blocks()`
  // yields real content. A `stop` finish with every block closed is that path.
  const { stream } = host()
  const out = await drive(stream, reasoningChunks(BLEED))
  assert.equal(out.at(-1).reason.kind, 'stop')
  // A closed reasoning block carries content, so the assembled message is not
  // empty — the renderer needs something to show.
  const closed = out.filter((c) => c.type === 'block-end')
  assert.ok(closed.length > 0)
  assert.ok(closed.every((c) => typeof c.block.text === 'string' && c.block.text.length > 0))
})

test('the terminal finish is the last chunk and nothing follows it', async () => {
  const { stream } = host()
  const out = await drive(stream, reasoningChunks(BLEED))
  assert.equal(out.filter((c) => c.type === 'finish').length, 1)
  assert.equal(out.at(-1).type, 'finish')
})

test('the cut happens early, not after the whole bleed', async () => {
  const { stream } = host()
  // A bleed far larger than the threshold: the point is that it stops near the
  // start. On the real session a 357,112-character bleed is cut at 512.
  const out = await drive(stream, reasoningChunks(BLEED))
  const emitted = out
    .filter((c) => c.type === 'reasoning-delta')
    .reduce((n, c) => n + c.text.length, 0)
  const total = BLEED.length
  assert.ok(emitted < total / 10, `must cut early, emitted ${emitted} of ${total}`)
})

test('the pending deltas after the cut are dropped, not flushed', async () => {
  const { stream } = host()
  const out = await drive(stream, reasoningChunks(BLEED))
  const finishAt = out.findIndex((c) => c.type === 'finish')
  assert.equal(finishAt, out.length - 1)
})

test('`breakCorrection: false` still cuts but says nothing', async () => {
  const { stream, steered } = host({ breakCorrection: false })
  const out = await drive(stream, reasoningChunks(BLEED))
  assert.equal(out.at(-1).type, 'finish')
  assert.equal(steered.length, 0)
})

test('a call that moves on to real output is left alone', async () => {
  const { stream, steered } = host()
  // A short cyclic burst below `minRepeatedReasoningCycleChars` — legitimate
  // scratch repetition — followed by genuine output. This is the false-positive
  // control: a model that was briefly repetitive and then acted must not be cut.
  const burst = SHORT
  assert.ok(burst.length < CONFIG.minRepeatedReasoningCycleChars)
  const chunks = [
    ...reasoningChunks(burst),
    { type: 'text-delta', text: 'Here is the answer.' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const out = await drive(stream, chunks)
  assert.equal(out.at(-1).reason.kind, 'stop')
  assert.equal(steered.length, 0)
})

test('coherent reasoning is never cut', async () => {
  const { stream, steered } = host()
  const text = Array.from({ length: 400 }, (_, i) =>
    `Step ${i}: reading the file, the parser at line ${i * 7} handles the ${i % 3 === 0 ? 'leading' : 'trailing'} case. `,
  ).join('')
  const out = await drive(stream, [...reasoningChunks(text), { type: 'finish', reason: { kind: 'stop' } }])
  assert.equal(out.at(-1).reason.kind, 'stop')
  assert.equal(steered.length, 0)
})

/* -------------------------------------------------------------------------- */
/* the cut is protocol-legal and ends the turn, not the session                */
/* -------------------------------------------------------------------------- */

/**
 * A Cordis-shaped context whose `llm/stream` listeners form the real chain.
 * `prepend` listeners run first because the shipped invariant registers that
 * way, so this array order IS the wrapper nesting the llm service builds.
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
  const fail = (m) => failures.push(m)
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
  const step = (i) => (i >= listeners.length ? source() : listeners[i](options, () => step(i + 1)))
  for await (const chunk of step(0)) out.push(chunk)
  return out
}

/** A provider stream emitting only reasoning deltas — the #5976 shape. */
async function* reasoningStream(text, size = 32) {
  yield { type: 'block-start', index: 0, blockType: 'reasoning' }
  for (const t of text.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) || []) {
    yield { type: 'reasoning-delta', index: 0, text: t }
  }
}

test('the reasoning cut is protocol-legal: the shipped llm invariant accepts it', async () => {
  // The breaker fires with the call's reasoning block still OPEN. The invariant
  // fails a `stop` finish while any block is open, so this runs the wrapper's own
  // output through the real validator rather than trusting a reading of the
  // source — that is exactly how the original `stop` attempt was caught
  // ("finished with 1 open block(s)").
  const agent = { steer: () => {}, inject: () => {}, cancel: () => {} }
  const { ctx, listeners } = chainContext(agent)
  const failures = await installInvariant(ctx)
  plugin.apply(ctx, CONFIG)
  assert.equal(listeners.length, 2, 'the chain must be invariant -> plugin')

  const options = markAgentLoopRequest({ sessionId: 's1', provider: 'p', model: 'm', messages: [] })
  const seen = await runChain(listeners, options, () => reasoningStream(BLEED))

  assert.deepEqual(failures, [], 'the synthesized finish must not violate the stream grammar')
  assert.equal(seen.at(-1).type, 'finish')
  assert.equal(seen.at(-1).reason.kind, 'stop')
})

test('the break never aborts the agent', async () => {
  // The plugin must end the CALL, not the agent: `agent.cancel()` would abort
  // the whole activity and clear the inbox, discarding the correction it just
  // queued. A closed-block `stop` finish is the turn-level mechanism.
  const agent = { steer: () => {}, inject: () => {}, cancel: () => { throw new Error('must not cancel the agent') } }
  const { ctx, listeners } = chainContext(agent)
  plugin.apply(ctx, CONFIG)
  const options = markAgentLoopRequest({ sessionId: 's1', provider: 'p', model: 'm', messages: [] })
  const seen = await runChain(listeners, options, () => reasoningStream(BLEED))
  assert.equal(seen.at(-1).reason.kind, 'stop')
  // No `failure` is attached: this is a closed call, not a failed one.
  assert.equal(seen.at(-1).reason.failure, undefined)
})

test('an unbroken reasoning bleed would have run to completion', async () => {
  // Control for the test above: the same fixture WITHOUT the plugin produces no
  // terminal chunk at all — that is precisely why the reporter had to abort the
  // turn by hand. It proves the cut is the breaker's doing, not the fixture's.
  const raw = []
  for await (const c of reasoningStream(BLEED)) raw.push(c)
  assert.equal(raw.filter((c) => c.type === 'finish').length, 0)
  assert.ok(raw.length > 50, 'the unbroken stream keeps producing deltas')
})

/* -------------------------------------------------------------------------- */
/* resumeAfterBreak: the wake must land AFTER the turn's wind-down            */
/* -------------------------------------------------------------------------- */

/**
 * An agent stand-in that models `agent-loop`'s wake suppression.
 *
 * The real `wakeDriver()` only starts a driver when the phase is `idle`; while
 * `running` it refuses to latch a non-abort wake, so a `followup()` issued from
 * inside the stream wrapper is dropped and the session comes to rest. This
 * stand-in reproduces that boundary so the test can prove the delay is
 * load-bearing rather than incidental.
 */
function resumeAgent() {
  let idlePromise = null
  let resolveIdle = null
  const followups = []
  const steered = []
  const agent = {
    steered,
    followups,
    /** Simulate the driver being busy until `finishTurn()` is called. */
    _busy: true,
    _wokeWhileBusy: 0,
    steer: (m) => steered.push(m),
    inject: () => {},
    cancel: () => {},
    whenIdle() {
      if (!agent._busy) return Promise.resolve()
      if (idlePromise === null) idlePromise = new Promise((r) => { resolveIdle = r })
      return idlePromise
    },
    followup(m) {
      // A wake while running is dropped by the harness; only an idle wake starts
      // a driver. Recording it separately is what makes the ordering assertable.
      if (agent._busy) { agent._wokeWhileBusy++; return }
      followups.push(m)
    },
  }
  agent.finishTurn = () => {
    agent._busy = false
    if (resolveIdle) resolveIdle()
    // Give the queued microtask a chance to observe idleness.
    return new Promise((r) => setImmediate(r))
  }
  return agent
}

test('resumeAfterBreak re-enters the model only after the turn is idle', async () => {
  const agent = resumeAgent()
  const { ctx, listeners } = chainContext(agent)
  plugin.apply(ctx, { ...CONFIG, resumeAfterBreak: true, breakCorrection: false })
  const options = markAgentLoopRequest({ sessionId: 's1', provider: 'p', model: 'm', messages: [] })

  await runChain(listeners, options, () => reasoningStream(BLEED))

  // Still running: the wake must not have been delivered yet, and must not have
  // been attempted into the busy phase either — the guard waits, it does not
  // fire a doomed wake and hope.
  assert.equal(agent.followups.length, 0, 'no wake while the turn is still unwinding')
  assert.equal(agent._wokeWhileBusy, 0, 'the guard must wait for idle, not race it')

  await agent.finishTurn()

  assert.equal(agent.followups.length, 1, 'exactly one continuation after idle')
  const text = agent.followups[0].content.map((b) => b.text ?? '').join('')
  assert.match(text, /截断/, 'the continuation carries the correction, it is not empty')
})

test('the continuation is never an empty message', async () => {
  // An empty user message would re-enter the model with the same degenerate
  // history and no new instruction — the loop's own input. This pins that the
  // resume path always carries the correction text.
  const agent = resumeAgent()
  const { ctx, listeners } = chainContext(agent)
  plugin.apply(ctx, { ...CONFIG, resumeAfterBreak: true, breakCorrection: false })
  const options = markAgentLoopRequest({ sessionId: 's1', provider: 'p', model: 'm', messages: [] })
  await runChain(listeners, options, () => reasoningStream(BLEED))
  await agent.finishTurn()

  const blocks = agent.followups[0].content
  assert.ok(blocks.length > 0, 'must carry at least one block')
  assert.ok(blocks.every((b) => (b.text ?? '').length > 0), 'no empty text block')
})

test('resumeAfterBreak is off by default', async () => {
  const agent = resumeAgent()
  const { ctx, listeners } = chainContext(agent)
  plugin.apply(ctx, CONFIG)
  const options = markAgentLoopRequest({ sessionId: 's1', provider: 'p', model: 'm', messages: [] })
  await runChain(listeners, options, () => reasoningStream(BLEED))
  await agent.finishTurn()
  assert.equal(agent.followups.length, 0, 'the default must not re-enter the model unasked')
})

test('the shipped schema defaults resumeAfterBreak to false', () => {
  // Behavioural test above covers the undefined case; this pins the schema
  // itself, so flipping the default is caught even if a future config path
  // always passes the key explicitly.
  assert.equal(plugin.Config(CONFIG).resumeAfterBreak, false)
  const resolved = plugin.Config({ ...CONFIG, resumeAfterBreak: undefined })
  assert.equal(resolved.resumeAfterBreak, false)
})

test('a guard without whenIdle/followup still breaks cleanly', async () => {
  // The resume methods are optional on the Agent type, so a stand-in that omits
  // them must not turn a working break into a crash.
  const agent = { steer: () => {}, inject: () => {}, cancel: () => {} }
  const { ctx, listeners } = chainContext(agent)
  plugin.apply(ctx, { ...CONFIG, resumeAfterBreak: true })
  const options = markAgentLoopRequest({ sessionId: 's1', provider: 'p', model: 'm', messages: [] })
  const seen = await runChain(listeners, options, () => reasoningStream(BLEED))
  assert.equal(seen.at(-1).reason.kind, 'stop')
})

test('an open tool-call block aborts the break instead of committing it', async () => {
  // Closing a half-streamed tool-call would put a truncated call into
  // `message.content`, and `step()` executes every tool-call block it finds —
  // running a call whose arguments are still invalid JSON. The break must
  // therefore refuse rather than close it, even though that leaves the
  // repetition running (the post-call detectors still apply).
  //
  // The sequence matters: the breaker must trip while the tool-call is ALREADY
  // open, so a non-repetitive reasoning prefix runs first (below the threshold),
  // then the tool-call opens, and only then does the bleed start. The prefix
  // must not itself be periodic — a repeated literal would trip the breaker
  // before the tool-call ever opens, and the test would pass for the wrong
  // reason.
  const { stream, warnings } = host()
  const prefix = Array.from({ length: 20 }, (_, i) =>
    `Line ${i} inspects the parser entry at offset ${i * 37} and notes case ${i % 3}. `,
  ).join('')
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    ...reasoningChunks(prefix, 32, 0).slice(1),
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: 'call-1', name: 'read', argumentsDelta: '{"file_pa' },
    ...reasoningChunks(BLEED, 32, 0).slice(1),
  ]
  const out = await drive(stream, chunks)
  assert.ok(!out.some((c) => c.type === 'finish'), 'no finish may be synthesized')
  assert.equal(out.at(-1).type, 'reasoning-delta', 'the stream must be left running')
  assert.ok(
    warnings.some((w) => w.includes('non-text block is open')),
    'the refusal must be logged, not silent',
  )
})

test('the break output assembles into a non-empty message through the real BlockAssembler', async () => {
  // The end-to-end property the client depends on: the chunks the break emits
  // must assemble into real content, because the renderer builds its
  // `assistant-step` node from a settled message and throws if a step it already
  // materialized produces none. Asserted through the harness's own assembler
  // rather than by re-reading the chunk list, so the block-end payload shape is
  // validated too.
  const require = createRequire(import.meta.url)
  const { BlockAssembler } = await import(
    new URL('lib/types/assembler.js', `file://${require.resolve('@deepseek-ai/dsh-llm/package.json').replace(/package\.json$/, '')}`).href
  )
  const agent = { steer: () => {}, inject: () => {}, cancel: () => {} }
  const { ctx, listeners } = chainContext(agent)
  plugin.apply(ctx, CONFIG)
  const options = markAgentLoopRequest({ sessionId: 's1', provider: 'p', model: 'm', messages: [] })
  const seen = await runChain(listeners, options, () => reasoningStream(BLEED))

  const assembler = new BlockAssembler()
  for (const chunk of seen) assembler.push(chunk)
  const blocks = assembler.blocks()
  assert.ok(blocks.length > 0, 'the assembled message must not be empty')
  assert.ok(
    blocks.every((b) => typeof b.text === 'string' && b.text.length > 0),
    'every assembled block must carry content',
  )
  assert.equal(assembler.finish.kind, 'stop')
})

/* -------------------------------------------------------------------------- */
/* language: the guard speaks the language the user reads                     */
/* -------------------------------------------------------------------------- */

/**
 * Drive a break with a stubbed host settings service.
 *
 * The service is exposed through `ctx.get('settings')`, not a `ctx.settings`
 * property: Cordis's context proxy throws for an undeclared service read, and the
 * guard only declares `agents`, so `get` is the accessor it must use.
 */
async function breakWithLocale(settings) {
  const steered = []
  const agent = { steer: (m) => steered.push(m), inject: () => {}, cancel: () => {} }
  let listener = null
  const ctx = {
    on: (n, fn) => { if (n === 'llm/stream') listener = fn },
    logger: { warn: () => {}, debug: () => {} },
    agents: { get: () => agent },
    get: (name) => (name === 'settings' ? settings : undefined),
  }
  plugin.apply(ctx, CONFIG)
  const options = markAgentLoopRequest({ sessionId: 's1', provider: 'p', model: 'm', messages: [] })
  const out = []
  for await (const c of listener(options, async function* () {
    yield { type: 'block-start', index: 0, blockType: 'reasoning' }
    for (const t of BLEED.match(/[\s\S]{1,32}/g)) yield { type: 'reasoning-delta', index: 0, text: t }
  })) out.push(c)
  assert.equal(out.at(-1).type, 'finish', 'the break must still happen')
  assert.equal(steered.length, 1)
  return steered[0].content.map((b) => b.text ?? '').join('')
}

const settingsWith = (preference) => ({ get: (ns) => (ns === 'locale' ? { preference } : undefined) })

/** Drive a break and return the queued notice's `source`, for attribution checks. */
async function breakWithLocaleSource(settings) {
  const steered = []
  const agent = { steer: (m) => steered.push(m), inject: () => {}, cancel: () => {} }
  let listener = null
  const ctx = {
    on: (n, fn) => { if (n === 'llm/stream') listener = fn },
    logger: { warn: () => {}, debug: () => {} },
    agents: { get: () => agent },
    get: (name) => (name === 'settings' ? settings : undefined),
  }
  plugin.apply(ctx, CONFIG)
  const options = markAgentLoopRequest({ sessionId: 's1', provider: 'p', model: 'm', messages: [] })
  for await (const _ of listener(options, () => reasoningStream(BLEED))) { /* drain */ }
  assert.equal(steered.length, 1)
  return steered[0].source
}

test('a zh locale produces a Chinese correction', async () => {
  // The correction is model-facing, and the model mirrors the language it is
  // addressed in — an English notice inside a Chinese session is noise.
  const text = await breakWithLocale(settingsWith('zh'))
  assert.match(text, /重复/)
  assert.match(text, /\d+/)
  // The noun naming what repeated is templated too, so it needs its own
  // assertion: the surrounding Chinese would still match /重复/ if the noun
  // leaked back to English, producing "你的reasoning已连续重复…".
  assert.match(text, /思考内容/)
  assert.ok(!/repeated itself/.test(text), 'must not fall back to the English template')
  assert.ok(!/\breasoning\b/.test(text), 'the noun must be localized too')
})

test('an en locale produces an English correction', async () => {
  const text = await breakWithLocale(settingsWith('en'))
  assert.match(text, /repeated itself/)
  assert.ok(!/重复/.test(text))
})

test('a regional zh tag is still Chinese', async () => {
  // `zh-Hans`, `zh-CN` and friends all mean Chinese; matching only the exact
  // string `zh` would silently send English to those users.
  for (const tag of ['zh-Hans', 'zh-CN', 'ZH']) {
    const text = await breakWithLocale(settingsWith(tag))
    assert.match(text, /重复/, `locale ${tag} must select Chinese`)
  }
})

test('an unknown, missing or malformed locale falls back to Chinese', async () => {
  // Chinese is the default in every direction: an unknown id, a missing value or
  // a malformed one must all resolve to `zh` rather than to English or to a
  // throw. Only an explicit `en` selects English.
  for (const preference of ['fr', 'de-DE', '', 42, null, undefined, {}, []]) {
    const text = await breakWithLocale(settingsWith(preference))
    assert.match(text, /重复/, `preference ${String(preference)} must fall back to Chinese`)
  }
})

test('a host without a settings service still breaks, in Chinese', async () => {
  const text = await breakWithLocale(undefined)
  assert.match(text, /重复/)
})

test('a settings service with no readable get() still breaks, in Chinese', async () => {
  // A foreign or partially-initialized service must be treated as absent, not
  // dereferenced: `settings.get(...)` on an object without it would throw inside
  // the stream wrapper, turning a working break into a broken model call.
  for (const settings of [{}, { get: null }, { get: 'not a function' }]) {
    const text = await breakWithLocale(settings)
    assert.match(text, /重复/, `settings ${JSON.stringify(settings)} must fall back`)
  }
})

test('a throwing settings service does not break the guard', async () => {
  // `settings.get` is host code; if it throws, the guard must still cut the
  // stream rather than let the exception escape into the model call.
  const text = await breakWithLocale({ get: () => { throw new Error('settings unavailable') } })
  assert.match(text, /重复/)
})

test('the service is read through ctx.get, not the throwing ctx.settings proxy', async () => {
  // Cordis's context proxy throws `cannot get property "settings" without
  // inject` for an undeclared service read, and the guard declares only
  // `agents`. Reaching for `ctx.settings` would therefore make the locale
  // silently unreadable — the guard would fall back forever, which is exactly
  // the kind of quiet failure this suite exists to catch. A getter that throws
  // reproduces the proxy's behaviour.
  const steered = []
  const agent = { steer: (m) => steered.push(m), inject: () => {}, cancel: () => {} }
  let listener = null
  const ctx = {
    on: (n, fn) => { if (n === 'llm/stream') listener = fn },
    logger: { warn: () => {}, debug: () => {} },
    agents: { get: () => agent },
    get: (name) => (name === 'settings' ? { get: () => ({ preference: 'en' }) } : undefined),
    get settings() { throw new Error('cannot get property "settings" without inject') },
  }
  plugin.apply(ctx, CONFIG)
  const options = markAgentLoopRequest({ sessionId: 's1', provider: 'p', model: 'm', messages: [] })
  for await (const _ of listener(options, () => reasoningStream(BLEED))) { /* drain */ }
  assert.equal(steered.length, 1)
  const text = steered[0].content.map((b) => b.text ?? '').join('')
  // The `en` preference was reachable, so the read did not go through the proxy.
  assert.match(text, /repeated itself/)
})

test('the notice is attributed to the package, with an account of what happened', async () => {
  // The source kind is this plugin's own id (declared by the module augmentation
  // in `src/index.ts`), not a shared catch-all. `summary` is the collapsed row's
  // one-line account, so it must describe the event rather than repeat the kind —
  // otherwise the row reads "loop-guard · loop-guard" and says nothing.
  const steered = []
  const agent = { steer: (m) => steered.push(m), inject: () => {}, cancel: () => {} }
  let listener = null
  const ctx = {
    on: (n, fn) => { if (n === 'llm/stream') listener = fn },
    logger: { warn: () => {}, debug: () => {} },
    agents: { get: () => agent },
    get: () => undefined,
  }
  plugin.apply(ctx, CONFIG)
  const options = markAgentLoopRequest({ sessionId: 's1', provider: 'p', model: 'm', messages: [] })
  for await (const _ of listener(options, () => reasoningStream(BLEED))) { /* drain */ }

  const source = steered[0].source
  // The plugin's own kind, not a shared catch-all. A host that does not know this
  // kind falls through it, which is the documented contract.
  assert.equal(source.kind, 'loop-guard')
  assert.equal(source.form, 'notice')
  assert.notEqual(source.summary, source.kind, 'the summary must not merely repeat the kind')
  assert.ok(source.summary.length > 0)
  // The summary rides a collapsed row and is committed to the durable log, so it
  // is bounded; exceeding the cap would be truncated by the harness anyway.
  assert.ok(source.summary.length <= 120, `summary too long: ${source.summary.length}`)
})

test('the summary is localized alongside the body', async () => {
  const zh = await breakWithLocaleSource(settingsWith('zh'))
  const en = await breakWithLocaleSource(settingsWith('en'))
  assert.match(zh.summary, /[\u4e00-\u9fa5]/, 'the zh summary must be Chinese')
  assert.ok(!/[\u4e00-\u9fa5]/.test(en.summary), 'the en summary must not contain Chinese')
})

test('a bleed at the widest measured period is caught by the SHIPPED default', () => {
  // Regression for a real miss. A turn looped with a **409-character** period
  // and was not cut: the default cap was 256, `trailingCycle` returned 0, and the
  // user had to abort by hand — the exact failure this rule exists to prevent.
  // The assertion therefore runs against the schema default rather than a
  // test-local constant, so lowering the default below a measured period fails
  // here instead of in production.
  const shipped = plugin.Config({}).maxRepeatedReasoningCycleChars
  const widest = Math.max(...FIXTURE.loops.map((l) => l.minPeriod).filter((p) => p > 0), 409)
  assert.ok(
    shipped > widest,
    `the default period cap (${shipped}) must exceed every measured period (${widest}); `
    + 'a cap below a real period fails silently',
  )
})

/* -------------------------------------------------------------------------- */
/* what the notice reports: repetition size, not call length                   */
/* -------------------------------------------------------------------------- */

test('`repeatedChars` reports the repetition, not the call length', () => {
  // The defect this pins: `emittedChars` is the call's TOTAL length, and the
  // notice used to print it as "had repeated itself for N characters". On
  // measured firings the two differ by 1.6x-10.1x (median 1.9x), so the model was
  // told it had gone in circles far longer than it had.
  //
  // Shape: a long non-repeating preamble, then a short verbatim cycle. The
  // preamble must NOT be counted as repetition.
  const preamble = Array.from({ length: 60 }, (_, i) => `Considering aspect ${i} of the design in detail.`).join('\n')
  const unit = 'Now. Writing. Go. OK. Let me write it.\n'
  const text = `${preamble}\n${unit.repeat(40)}`

  const breaker = new ReasoningLoopBreaker(CONFIG)
  let tripped = false
  for (let i = 0; i < text.length; i += 32) {
    if (breaker.push(text.slice(i, i + 32))) { tripped = true; break }
  }
  assert.ok(tripped, 'the cycle must trip')

  // The call's total is far larger than the repetition, and the repetition must
  // be bounded by the cyclic tail rather than the whole call.
  assert.ok(breaker.emittedChars > 3000, `the call emitted plenty, got ${breaker.emittedChars}`)
  assert.ok(
    breaker.repeatedChars < breaker.emittedChars / 2,
    `repetition (${breaker.repeatedChars}) must be well below the call total (${breaker.emittedChars})`,
  )
  // And it must be at least the qualifying span, never zero.
  assert.ok(breaker.repeatedChars >= CONFIG.minRepeatedReasoningCycleChars, 'a real span, not 0')
})

test('the reported repetition is a genuine periodic tail, maximal in length', () => {
  // Property check rather than a magic number: the reported span must be periodic
  // AND one character longer must NOT be, so it is the real extent of the
  // repetition rather than an arbitrary prefix of it.
  const unit = 'Executing. Go. Now. Writing. OK.\n'
  const text = `${'x'.repeat(5000)}\n${unit.repeat(60)}`
  const breaker = new ReasoningLoopBreaker(CONFIG)
  for (let i = 0; i < text.length; i += 32) {
    if (breaker.push(text.slice(i, i + 32))) break
  }
  const span = breaker.repeatedChars
  const seen = text.slice(0, breaker.emittedChars)
  assert.ok(span > 0, 'a span was reported')

  // Periodic: brute-force search for ANY period that reproduces the tail.
  const periodic = (s) => {
    for (let p = 1; p <= Math.min(512, Math.floor(s.length / 2)); p++) {
      if (new Set(s.slice(s.length - p)).size < 2) continue
      let ok = true
      for (let i = s.length - 1; i >= p; i--) if (s[i] !== s[i - p]) { ok = false; break }
      if (ok) return true
    }
    return false
  }
  assert.ok(periodic(seen.slice(-span)), 'the reported span must be periodic')
  if (span + 1 <= seen.length) {
    assert.ok(!periodic(seen.slice(-(span + 1))), 'one more character must break the periodicity')
  }
})

test('`trailingCycle` stays capped while `periodicTailSpan` reports the true extent', () => {
  // The two must not be confused: `trailingCycle` is the DECISION rule and stops
  // at `max(minSpan, 2 * period)` on purpose, so its value is a lower bound. Only
  // `periodicTailSpan` walks the tail out, and it is what the notice uses.
  const unit = 'Go. OK. Now.\n'
  const text = unit.repeat(400)          // a long, genuine cycle
  const capped = trailingCycle(text, 512, 512)
  const full = periodicTailSpan(text, 512, 512)
  assert.ok(capped > 0, 'the cycle rule sees it')
  assert.ok(full > capped, `the true span (${full}) must exceed the capped one (${capped})`)
  assert.ok(full >= text.length - unit.length * 2, `the span should cover nearly the whole text, got ${full}`)
})

test('`periodicTailSpan` returns 0 on text with no period', () => {
  let seed = 7
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296
  const noise = Array.from({ length: 4000 }, () => String.fromCharCode(97 + Math.floor(rnd() * 26))).join('')
  assert.equal(periodicTailSpan(noise, 512, 512), 0)
  assert.equal(periodicTailSpan('short', 512, 512), 0)
  assert.equal(periodicTailSpan(noise, 0, 512), 0, 'a disabled cap reports nothing')
})

test('the notice carries the repetition figure, not the call length', async () => {
  // End-to-end through `apply()`: the steered text must contain the repetition
  // size. Asserting the property (the number is the repeated one) rather than a
  // literal, so a retune does not break it.
  const unit = 'Now. Writing. Go. OK.\n'
  const text = `${'y'.repeat(6000)}\n${unit.repeat(60)}`
  const { stream, steered } = host()
  const out = await drive(stream, reasoningChunks(text))
  assert.ok(out.some((c) => c.type === 'finish'), 'the call was ended')

  const notice = steered.find((m) => m.source?.kind === 'loop-guard')
  assert.ok(notice, 'a correction was steered')
  const body = notice.content.map((b) => b.text).join('')
  const number = Number((body.match(/(\d+)/) ?? [])[1])
  assert.ok(Number.isFinite(number) && number > 0, `the notice must carry a figure, got: ${body}`)
  // The load-bearing assertion: the figure is far below the call's length. The
  // old code printed `emittedChars` here, which for this shape is the whole text.
  assert.ok(
    number < text.length / 2,
    `the notice reported ${number} for a ${text.length}-character call; it must report the repetition`,
  )
})

test('a synthetic 409-character period trips the shipped default', () => {
  const period = 409
  let unit = ''
  for (let i = 0; unit.length < period; i++) unit += `Step ${i} revisits the parser at offset ${i * 31}.\n\n`
  unit = unit.slice(0, period)
  assert.ok(new Set(unit).size >= 2, 'the period must vary')
  const text = unit.repeat(30)

  // It is genuinely invisible to the old cap — the bug this guards against.
  assert.equal(trailingCycle(text, 256, 512), 0, 'a 409-period bleed must be invisible to maxPeriod 256')
  assert.ok(trailingCycle(text, 512, 512) > 0, 'and visible to the shipped cap')

  const shipped = plugin.Config({})
  const at = trip(text, shipped)
  assert.ok(at > 0, 'the shipped default must cut a 409-character-period bleed')
  assert.ok(at < text.length / 2, `must cut early, cut at ${at} of ${text.length}`)
})

test('the correction sends the model back to its task, not to a conclusion', async () => {
  // Regression for a real derailment. The original wording ended with "state the
  // conclusion once, briefly, and then either call a tool or finish the answer",
  // which reads as "wrap up now" — the break stopped the loop but also made the
  // model abandon work in progress. The only instruction it may carry is "stop
  // repeating, carry on", so the wrap-up phrasings are asserted absent.
  for (const preference of ['zh', 'en']) {
    const text = await breakWithLocale(settingsWith(preference))
    assert.ok(!/结论/.test(text), `[${preference}] must not tell the model to conclude`)
    assert.ok(!/finish the answer|conclusion/i.test(text), `[${preference}] must not tell the model to wrap up`)
    // And it must positively point back at the task.
    assert.ok(
      /任务|task/i.test(text),
      `[${preference}] must redirect to the original task, got: ${text}`,
    )
  }
})

/* -------------------------------------------------------------------------- */
/* the shipped schema                                                         */
/* -------------------------------------------------------------------------- */

test('the schema ships the reasoning rule on, with its calibrated defaults', () => {
  const resolved = plugin.Config(CONFIG)
  assert.equal(resolved.maxRepeatedReasoningCycleChars, 512)
  assert.equal(resolved.minRepeatedReasoningCycleChars, 512)
})

test('the schema accepts the reasoning keys and applies their defaults', () => {
  const resolved = plugin.Config({ ...CONFIG, maxRepeatedReasoningCycleChars: undefined, minRepeatedReasoningCycleChars: undefined })
  assert.equal(resolved.maxRepeatedReasoningCycleChars, 512)
  assert.equal(resolved.minRepeatedReasoningCycleChars, 512)
})

test('the schema rejects a negative reasoning period', () => {
  assert.throws(() => plugin.Config({ ...CONFIG, maxRepeatedReasoningCycleChars: -1 }))
})
