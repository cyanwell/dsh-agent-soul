/**
 * The visible-output phrase-pool rule — the shape neither older text rule reaches.
 *
 * The two visible-output rules that predate this one are structurally blind to a
 * reshuffled phrase pool, and a real call proved it by running to 56 465
 * characters until the user aborted the turn:
 *
 *  - `maxRepeatedText` counts *consecutive identical deltas*. Providers chunk text
 *    into 2-3 character fragments, so `Go.` arrives as `Go` + `.`; measured over
 *    that whole call the longest run of identical payloads was **1**, against a
 *    threshold of 60. No amount of extra length can reach it.
 *  - `maxRepeatedCycleChars` needs an exact period. A reshuffled pool has none:
 *    `trailingCycle(512, 256)` returned **0** on the same text.
 *
 * The reasoning side already had this rule (`reasoning-lines`), which is why 69 of
 * the 72 breaks in that session were reasoning-side. This call had **zero**
 * reasoning and zero tool calls — the loop ran entirely in visible output, and
 * fell into the gap.
 *
 * Both sides now share one `PhrasePool` implementation, so a threshold change
 * cannot make them disagree. The thresholds here match the reasoning side.
 *
 * Runs against the built `lib/index.js`, so it pins the shipped artifact.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import * as plugin from '../lib/index.js'
import { TextRepetitionDetector, countRepeatedText, trailingCycle } from '../lib/index.js'

/** Real captures: one bleed and two legitimate long texts. */
const FIXTURE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures-text-lines.json'), 'utf8'),
)

/** The shipped defaults, resolved by the schema rather than restated by hand. */
const SHIPPED = plugin.Config({})

/** The phrase-pool rule alone: every other visible-output rule switched off. */
const LINES_ONLY = {
  ...SHIPPED,
  maxRepeatedText: 0,
  maxRepeatedCycleChars: 0,
  maxRepeatedReasoningLineChars: 0,
  maxRepeatedReasoningCycleChars: 0,
}

/** Drive the detector the way the stream wrapper does, in 32-character strides. */
function run(text, config = LINES_ONLY, size = 32) {
  const detector = new TextRepetitionDetector(config)
  for (let i = 0; i < text.length; i += size) {
    if (detector.push(text.slice(i, i + size))) {
      return { at: detector.emittedChars, rule: detector.trippedBy, repeated: detector.repeatedChars }
    }
  }
  return null
}

/* -------------------------------------------------------------------------- */
/* the fixture is the case that motivated the rule                            */
/* -------------------------------------------------------------------------- */

test('the fixture reproduces the bug: the two older rules cannot see this bleed', () => {
  const bleed = FIXTURE.bleeds[0]
  assert.equal(bleed.fullChars, 56465, 'the measured reproduction')
  assert.equal(bleed.text.length, bleed.keptChars)

  // Load-bearing: the shape must still be invisible to both older rules, or the
  // fixture no longer reproduces the gap this rule exists to close.
  assert.equal(
    trailingCycle(bleed.text, SHIPPED.maxRepeatedCycleChars, SHIPPED.minRepeatedCycleChars),
    0,
    'a reshuffled pool has no period, so the cycle rule must stay blind',
  )

  // The chunk rule needs consecutive identical payloads; this text is streamed in
  // 32-character strides here, and the real provider used 2-3 character fragments
  // (measured: longest run 1). Either way it is nowhere near 60.
  const chunks = bleed.text.match(/[\s\S]{1,32}/g) ?? []
  assert.ok(
    countRepeatedText(chunks) < SHIPPED.maxRepeatedText,
    `the chunk rule must not reach ${SHIPPED.maxRepeatedText}, got ${countRepeatedText(chunks)}`,
  )

  // And with both older rules active but the phrase-pool rule off, nothing fires.
  const older = { ...SHIPPED, maxRepeatedTextLineChars: 0 }
  assert.equal(run(bleed.text, older), null, 'the older rules alone must miss it')
})

test('the phrase-pool rule cuts that bleed early', () => {
  const bleed = FIXTURE.bleeds[0]
  const hit = run(bleed.text)
  assert.ok(hit !== null, 'the phrase-pool rule must fire')
  assert.equal(hit.rule, 'text-lines')
  // The fixture keeps the first 6000 characters of a 56465-character call; the
  // cut must land well inside it, which is what makes the rule useful at all.
  assert.ok(hit.at < bleed.text.length, `cut inside the sampled prefix, got ${hit.at}`)
  assert.ok(hit.at < 6000 * 0.6, `cut in the first 60% of the sample, got ${hit.at}`)
  assert.ok(hit.repeated > 0, 'the reported repetition must be non-zero')
})

test('the reported repetition is the repeated mass, not the call length', () => {
  const bleed = FIXTURE.bleeds[0]
  const hit = run(bleed.text)
  assert.ok(hit !== null)
  // The notice is about the repetition; reporting `emittedChars` here would claim
  // the whole call was repetition.
  assert.ok(
    hit.repeated < hit.at,
    `repetition (${hit.repeated}) must be below the emitted total (${hit.at})`,
  )
})

/* -------------------------------------------------------------------------- */
/* the false-positive control                                                 */
/* -------------------------------------------------------------------------- */

test('legitimate long texts never trip the phrase-pool rule', () => {
  for (const control of FIXTURE.controls) {
    const hit = run(control.text)
    assert.equal(
      hit,
      null,
      `control "${control.id}" (${control.text.length} chars) must not trip, but tripped at ${hit?.at}`,
    )
  }
})

test('a long block quoted twice is rejected by the concentration guard', () => {
  // Coverage alone cannot tell a phrase pool from one long block appearing twice:
  // quoting a block puts every line in the "seen twice" bucket, so coverage
  // approaches 1.0 with a vocabulary that is not a pool at all. This is the same
  // guard the reasoning side needed, and it must apply here too.
  const source = FIXTURE.controls[1].text
  const block = source.split('\n').slice(0, 200).join('\n')
  const quoted = `Before:\n\`\`\`ts\n${block}\n\`\`\`\nAfter:\n\`\`\`ts\n${block}\n\`\`\`\n`
  assert.equal(run(quoted), null, 'a doubled code block must not be treated as a pool')
})

test('the phrase-pool rule needs the repeated mass, not just repetition', () => {
  // A short text with a couple of repeated lines is ordinary writing, not a
  // bleed. The 2048-character floor is what keeps it out.
  const small = 'Note this.\nAnd this.\nNote this.\nAnd this.\nNote this.\nAnd this.\n'
  assert.equal(run(small), null)
})

/* -------------------------------------------------------------------------- */
/* the switch                                                                 */
/* -------------------------------------------------------------------------- */

test('the schema ships the phrase-pool rule on, with the reasoning-side thresholds', () => {
  assert.equal(SHIPPED.maxRepeatedTextLineChars, 2048)
  assert.equal(SHIPPED.minRepeatedTextLineCoverage, 0.6)
  assert.equal(SHIPPED.minRepeatedTextLineConcentration, 4)
  // Both sides share one implementation, so their defaults must not drift apart.
  assert.equal(SHIPPED.maxRepeatedTextLineChars, SHIPPED.maxRepeatedReasoningLineChars)
  assert.equal(SHIPPED.minRepeatedTextLineCoverage, SHIPPED.minRepeatedReasoningLineCoverage)
  assert.equal(SHIPPED.minRepeatedTextLineConcentration, SHIPPED.minRepeatedReasoningLineConcentration)
})

test('`maxRepeatedTextLineChars: 0` disables the rule', () => {
  const off = { ...LINES_ONLY, maxRepeatedTextLineChars: 0 }
  assert.equal(run(FIXTURE.bleeds[0].text, off), null)
})

test('the detector reports which rule fired', () => {
  const detector = new TextRepetitionDetector(LINES_ONLY)
  const text = FIXTURE.bleeds[0].text
  let tripped = false
  for (let i = 0; i < text.length; i += 32) {
    if (detector.push(text.slice(i, i + 32))) { tripped = true; break }
  }
  assert.ok(tripped)
  assert.equal(detector.trippedBy, 'text-lines')
  assert.ok(detector.emittedChars > 0)
  assert.equal(detector.push('more text\n'), false, 'once tripped it never reports again')
})

/* -------------------------------------------------------------------------- */
/* through apply() — the assertion a helper-only test cannot make              */
/* -------------------------------------------------------------------------- */

test('the bleed is cut through apply(), with a legal terminal finish', async () => {
  const bleed = FIXTURE.bleeds[0]
  const steered = []
  const agent = { inject: () => {}, steer: (m) => steered.push(m), cancel: () => {} }
  let stream = null
  const ctx = {
    logger: { warn: () => {}, debug: () => {}, info: () => {}, error: () => {} },
    agents: { get: () => agent },
    on: (e, l) => { if (e === 'llm/stream') stream = l },
  }
  plugin.apply(ctx, SHIPPED)

  const options = markAgentLoopRequest({ sessionId: 's1' })
  const chunks = [{ type: 'block-start', index: 0, blockType: 'text' }]
  for (let i = 0; i < bleed.text.length; i += 32) {
    chunks.push({ type: 'text-delta', index: 0, text: bleed.text.slice(i, i + 32) })
  }

  let emitted = 0
  let finish = null
  let closed = 0
  for await (const c of stream(options, async function* () { for (const x of chunks) yield x })) {
    if (c.type === 'text-delta') emitted += c.text.length
    if (c.type === 'block-end') closed++
    if (c.type === 'finish') finish = c.reason
  }

  assert.ok(finish !== null, 'the stream must be finished, not left open')
  // A `stop` finish is only legal with no open block, so the block must be closed.
  assert.equal(finish.kind, 'stop')
  assert.ok(closed > 0, 'the open text block must be closed before the finish')
  assert.ok(emitted < bleed.text.length, 'the stream must be cut before the end')

  const notice = steered.find((m) => m.source?.kind === 'loop-guard')
  assert.ok(notice, 'a correction must be steered')
  const body = notice.content.map((b) => b.text).join('')
  // The noun must say visible output: the same notice is used for reasoning, and
  // telling the model its *reasoning* repeated when the text did would misdirect it.
  assert.ok(body.includes('可见输出'), `the notice must name visible output, got: ${body}`)
  assert.ok(notice.source.summary.includes('可见输出'), 'the collapsed row must say so too')
})
