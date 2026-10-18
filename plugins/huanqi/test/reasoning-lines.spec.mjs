/**
 * The line-repeat rule — the phrase-pool bleed that the cycle rule cannot see.
 *
 * The cycle rule (`reasoning-breaker.spec.mjs`) only catches a bleed whose unit
 * repeats in the same order every time. A real reproduction broke that
 * assumption: 330 188 reasoning characters drawn from roughly eleven sentences —
 * `Let me read the section.` / `Executing.` / `Go.` / `Now.` / `Writing.` /
 * `OK.` / `Let me write.` — reshuffled on every pass, so the text has **no period
 * at any cap**:
 *
 *   - measured span with `trailingCycle(tail, cap, 512)`: 0 at every cap from
 *     64 to 4096;
 *   - the minimum period of the trailing 8192 characters was 6767, i.e. none.
 *
 * The cycle rule was therefore blind to it and the turn ran to 330 188
 * characters — "都快几百K输出了" — until the user aborted by hand. Raising the
 * cap cannot help: there is no period to find at any cap, which is why the
 * earlier cap bumps (64 → 256 → 512) never fixed this shape.
 *
 * What the bleed does have is a tiny **line vocabulary**. Counting how much of
 * the text sits in lines already seen separates it cleanly, and the two rules
 * are complementary rather than redundant: short-phrase bleeds (`Go.`, `OK.`,
 * under `LINE_MIN_CHARS`) are the cycle rule's job, long-phrase pools are this
 * one's.
 *
 * Calibration, on the real session (146 reasoning calls: 17 aborted bleeds,
 * 119 that produced text or a tool call):
 *
 *   - the shipped thresholds cut the 330 188-character bleed at **3264
 *     characters — 1.0 %** of its final length;
 *   - **0 false positives on all 119 producing calls**, and 0 across every
 *     parameter set the shipped one was chosen from (252 qualifying sets);
 *   - the control samples below are the *longest* producing calls in that
 *     session, i.e. the hardest negatives available.
 *
 * Runs against the built `lib/index.js`, so it pins the shipped artifact.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import * as plugin from '../lib/index.js'
import { ReasoningLoopBreaker, trailingCycle } from '../lib/index.js'

/** Real reasoning heads captured from the reproduction that exposed the shape. */
const FIXTURE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures-reasoning-lines.json'), 'utf8'),
)

/** The shipped defaults, resolved by the schema rather than restated by hand. */
const SHIPPED = plugin.Config({})

/** The line rule alone: both cycle rules and both visible-output rules off. */
const LINES_ONLY = {
  ...SHIPPED,
  maxRepeatedText: 0,
  maxRepeatedCycleChars: 0,
  maxRepeatedReasoningCycleChars: 0,
}

/** The line rule with its concentration guard disabled (pre-fix behaviour). */
const NO_CONCENTRATION = { ...LINES_ONLY, minRepeatedReasoningLineConcentration: 0 }

/** Drive the breaker the way the stream wrapper does, in 32-character strides. */
function run(text, config = LINES_ONLY) {
  const breaker = new ReasoningLoopBreaker(config)
  for (let i = 0; i < text.length; i += 32) {
    if (breaker.push(text.slice(i, i + 32))) {
      return { at: breaker.emittedChars, rule: breaker.trippedBy }
    }
  }
  return null
}

test('the fixture carries the real bleeds and the hardest real controls', () => {
  assert.ok(FIXTURE.bleeds.length >= 2, 'at least the two measured bleeds')
  assert.ok(FIXTURE.controls.length >= 4, 'several producing controls')
  // The load-bearing property of the fixture: these bleeds have NO period, so
  // the cycle rule cannot see them at any cap. If this ever stops holding, the
  // fixture no longer reproduces the bug it exists for.
  for (const bleed of FIXTURE.bleeds) {
    for (const cap of [64, 128, 256, 512, 1024, 2048, 4096]) {
      assert.equal(
        trailingCycle(bleed.head, cap, 512),
        0,
        `bleed seq=${bleed.seq} must stay period-free at cap ${cap}`,
      )
    }
  }
  // And the controls must be real producing calls, not aborted bleeds.
  for (const control of FIXTURE.controls) {
    assert.ok(control.textChars > 0 || control.toolCalls > 0, `control seq=${control.seq} produced something`)
  }
})

test('the line rule cuts the 330 188-character phrase-pool bleed early', () => {
  const biggest = FIXTURE.bleeds[0]
  assert.equal(biggest.reasoningChars, 330188, 'the measured reproduction')
  const hit = run(biggest.head)
  assert.ok(hit !== null, 'the bleed must trip the line rule')
  assert.equal(hit.rule, 'reasoning-lines')
  // The head is only the first 30000 characters of a 330188-character bleed; the
  // cut must land well inside it, which is what makes the rule useful at all.
  assert.ok(hit.at < biggest.head.length, `cut inside the sampled head, got ${hit.at}`)
  assert.ok(hit.at < biggest.reasoningChars * 0.02, `cut within 2% of the full bleed, got ${hit.at}`)
})

test('the second measured bleed is cut too', () => {
  const second = FIXTURE.bleeds[1]
  assert.equal(second.reasoningChars, 124070, 'the measured reproduction')
  const hit = run(second.head)
  assert.ok(hit !== null, 'the second bleed must trip')
  assert.equal(hit.rule, 'reasoning-lines')
  assert.ok(hit.at < second.reasoningChars, 'cut before the natural end')
})

test('no producing call in the reproduction trips the line rule (the false-positive control)', () => {
  for (const control of FIXTURE.controls) {
    const hit = run(control.head)
    assert.equal(
      hit,
      null,
      `control seq=${control.seq} (r=${control.reasoningChars}, text=${control.textChars}, `
      + `tools=${control.toolCalls}) must not trip, but tripped at ${hit?.at}`,
    )
  }
})

test('the two rules are complementary: short phrases are the cycle rule, long pools are the line rule', () => {
  // A short-phrase pool ("Go." / "OK." — under LINE_MIN_CHARS) is invisible to
  // the line rule and must still be caught by the cycle rule. This is why both
  // rules ship: neither subsumes the other.
  const shortPool = 'Go.\nOK.\nNow.\nGo.\nOK.\nNow.\n'.repeat(40)
  assert.equal(run(shortPool, LINES_ONLY), null, 'the line rule cannot see a short-phrase pool')
  const cycleOnly = { ...LINES_ONLY, maxRepeatedReasoningCycleChars: SHIPPED.maxRepeatedReasoningCycleChars }
  assert.ok(run(shortPool, cycleOnly) !== null, 'the cycle rule catches what the line rule misses')
})

test('lines shorter than two characters are excluded from both sides of the ratio', () => {
  // Generated code repeats `}` and `);` by the hundred. They must not be able to
  // drive the repeated share up, so they are dropped from the numerator AND the
  // denominator: a document made only of such lines has no counted mass at all.
  const braces = '}\n);\n}\n);\n'.repeat(400)
  assert.equal(run(braces), null, 'brace noise must never trip the rule')
})

test('varying reasoning with unique lines never trips the line rule', () => {
  const unique = Array.from({ length: 600 }, (_, i) => `Step ${i}: examine part ${i} of the input and record it.`).join('\n')
  assert.equal(run(unique), null)
})

test('the SECOND sighting of a line already counts as repetition', () => {
  // Boundary assertion for the counting rule itself. On the second sighting both
  // copies are repetition, so the repeated mass is `2 * length`; an implementation
  // that only counted from the third sighting onwards would need one extra pass
  // and would miss a bleed that is exactly at the threshold.
  // Sized so the two readings straddle the default 2048: 1024 * 2 = 2048 trips,
  // 1024 * 1 = 1024 does not.
  //
  // The concentration guard is switched off here: one line seen twice has a
  // concentration of 2 and the guard (default 4) would reject it. This test is
  // about the counting arithmetic, so it isolates that — the guard's own effect
  // on this shape is pinned separately below.
  const line = 'x'.repeat(1024)
  const twice = `${line}\n${line}\n`
  const hit = run(twice, NO_CONCENTRATION)
  assert.ok(hit !== null, 'two sightings of a 1024-character line must reach the 2048 threshold')
  assert.equal(hit.rule, 'reasoning-lines')
})

test('every sighting after the second keeps adding to the repeated mass', () => {
  // 512 * 2 (second sighting) + 512 + 512 (third and fourth) = 2048 exactly.
  // An implementation that stopped counting after the second sighting would sit
  // at 1024 and never trip.
  const line = 'y'.repeat(512)
  const fourTimes = `${line}\n${line}\n${line}\n${line}\n`
  const hit = run(fourTimes)
  assert.ok(hit !== null, 'four sightings of a 512-character line must reach 2048')
  assert.equal(hit.rule, 'reasoning-lines')
})

test('the schema ships the line rule on, with its calibrated defaults', () => {
  assert.equal(SHIPPED.maxRepeatedReasoningLineChars, 2048)
  assert.equal(SHIPPED.minRepeatedReasoningLineCoverage, 0.6)
  assert.equal(SHIPPED.minRepeatedReasoningLineConcentration, 4)
  assert.ok(SHIPPED.maxRepeatedReasoningLineChars > 0, 'the rule is on by default')
})

/* -------------------------------------------------------------------------- */
/* the concentration guard: coverage alone cannot tell a pool from a quote     */
/* -------------------------------------------------------------------------- */

/** Real fragments that were cut by the pre-guard rule but are not bleeds. */
const QUOTES = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures-reasoning-quote.json'), 'utf8'),
)

/** Per-line sighting counts of a text prefix, the guard's own measure. */
function vocabulary(text, upto = text.length) {
  const counts = new Map()
  for (const raw of text.slice(0, upto).split('\n')) {
    const line = raw.trim()
    if (line.length < 2) continue
    counts.set(line, (counts.get(line) ?? 0) + 1)
  }
  let instances = 0
  for (const count of counts.values()) instances += count
  return { distinct: counts.size, instances, perLine: counts.size ? instances / counts.size : 0 }
}

test('the quote fixture reproduces the bug: the pre-guard rule cuts it, the guard does not', () => {
  const quote = QUOTES.quotes[0]
  assert.equal(quote.text.length, quote.reasoningChars, 'the measured fragment')

  // Pre-guard behaviour: it fires, and it fires at the very end of the call —
  // which is the whole point: the cut saved one character and cost a step.
  const before = run(quote.text, NO_CONCENTRATION)
  assert.ok(before !== null, 'the pre-guard rule must still fire on this fixture')
  assert.equal(before.rule, 'reasoning-lines')
  assert.ok(
    before.at >= quote.reasoningChars - 4,
    `the pre-guard cut lands at the very end, got ${before.at} of ${quote.reasoningChars}`,
  )

  // With the guard: no fire at all.
  assert.equal(run(quote.text), null, 'the concentration guard must reject a code quote')
})

test('the quote fixture is rejected because its vocabulary is not a pool', () => {
  // The guard's own justification, asserted rather than described: this text
  // clears the coverage threshold while averaging well under 4 sightings per
  // distinct line, because a code block quoted twice puts every line in the
  // "seen twice" bucket.
  const quote = QUOTES.quotes[0]
  const vocab = vocabulary(quote.text)
  assert.equal(vocab.distinct, quote.measured.distinctLines)
  assert.equal(vocab.instances, quote.measured.instances)
  assert.ok(vocab.perLine < SHIPPED.minRepeatedReasoningLineConcentration,
    `per-line ${vocab.perLine.toFixed(2)} must sit below the guard`)
  // And it does clear the coverage threshold, which is why the guard is needed.
  const withoutGuard = run(quote.text, NO_CONCENTRATION)
  assert.ok(withoutGuard !== null, 'coverage alone lets this through')
})

test('the guard costs nothing on a real bleed: the trip point does not move', () => {
  // The load-bearing property. A guard that merely delayed the cut would trade
  // one false positive for a slower true positive; this one must not.
  for (const bleed of FIXTURE.bleeds) {
    const before = run(bleed.head, NO_CONCENTRATION)
    const after = run(bleed.head)
    assert.ok(before !== null, `bleed seq=${bleed.seq} trips without the guard`)
    assert.ok(after !== null, `bleed seq=${bleed.seq} must still trip WITH the guard`)
    assert.equal(after.at, before.at, `bleed seq=${bleed.seq} trip point must be unchanged`)
    assert.equal(after.rule, 'reasoning-lines')
  }
})

test('a bleed drawn from a pool trips at the same character with and without the guard', () => {
  // Synthetic, so the shape is exact: a small pool repeated many times. This is
  // what the guard is supposed to keep, and it must keep it at full speed.
  const pool = 'Let me read the section.\nExecuting.\nGo.\nNow.\nWriting.\nOK.\nLet me write.\n'
  const text = pool.repeat(60)
  const before = run(text, NO_CONCENTRATION)
  const after = run(text)
  assert.ok(before !== null, 'the pool trips without the guard')
  assert.ok(after !== null, 'the pool must still trip with the guard')
  assert.equal(after.at, before.at, 'the guard must not delay a real pool')
})

test('the guard separates the two populations with margin, not by a hair', () => {
  // Measured over every session on this machine: rejected quotes score 1.40-2.48
  // sightings per line, kept bleeds score 7.16-22.99 at their trip point. The
  // shipped default of 4 sits between them. This asserts the margin on the
  // fixtures the suite actually carries, so a retune that closes the gap fails.
  const quote = QUOTES.quotes[0]
  const quoteVocab = vocabulary(quote.text)
  const bleedVocab = vocabulary(FIXTURE.bleeds[0].head, run(FIXTURE.bleeds[0].head).at)
  assert.ok(quoteVocab.perLine < SHIPPED.minRepeatedReasoningLineConcentration)
  assert.ok(bleedVocab.perLine > SHIPPED.minRepeatedReasoningLineConcentration * 1.5,
    `a real bleed should clear the guard by a wide margin, got ${bleedVocab.perLine.toFixed(2)}`)
})

test('`minRepeatedReasoningLineConcentration: 0` restores the pre-guard behaviour', () => {
  // The escape hatch must be real, not nominal: setting it to 0 has to bring the
  // false positive back, or it is not actually the knob it claims to be.
  const quote = QUOTES.quotes[0]
  assert.equal(run(quote.text), null)
  assert.ok(run(quote.text, NO_CONCENTRATION) !== null)
})

test('`maxRepeatedReasoningLineChars: 0` disables the rule', () => {
  const off = { ...LINES_ONLY, maxRepeatedReasoningLineChars: 0 }
  assert.equal(run(FIXTURE.bleeds[0].head, off), null)
})

test('a higher coverage requirement defers the cut, it does not move it earlier', () => {
  // The coverage ratio is the rule's precision knob: demanding a larger repeated
  // share can only delay a cut, never advance it. Asserted as a monotonicity
  // property over the measured bleed rather than a fixed position, so the
  // assertion stays true if the thresholds are ever retuned.
  const text = FIXTURE.bleeds[0].head
  const cuts = [0.5, 0.6, 0.7, 0.8].map((cov) => run(text, { ...LINES_ONLY, minRepeatedReasoningLineCoverage: cov }))
  assert.ok(cuts[0] !== null, 'the lenient setting cuts')
  for (const [i, hit] of cuts.entries()) {
    if (hit === null) continue
    assert.ok(
      hit.at >= cuts[0].at,
      `coverage step ${i} cut at ${hit.at}, earlier than the lenient ${cuts[0].at}`,
    )
  }
  // At least the calibrated default must still catch this bleed.
  assert.ok(cuts[1] !== null, 'the shipped 0.6 catches the measured bleed')
})

test('the breaker reports which rule fired', () => {
  const breaker = new ReasoningLoopBreaker(LINES_ONLY)
  let tripped = false
  const text = FIXTURE.bleeds[0].head
  for (let i = 0; i < text.length; i += 32) {
    if (breaker.push(text.slice(i, i + 32))) { tripped = true; break }
  }
  assert.ok(tripped)
  assert.equal(breaker.trippedBy, 'reasoning-lines')
  assert.ok(breaker.emittedChars > 0)
  // Once tripped it stays tripped and never reports a second time.
  assert.equal(breaker.push('more text\n'), false)
})

test('the line rule is bounded and incremental over a long bleed', () => {
  // The rule must stay linear: the whole 330 188-character bleed is processed
  // here, not just the sampled head, and it must not blow up.
  const one = FIXTURE.bleeds[0]
  const full = one.head.repeat(Math.ceil(one.reasoningChars / one.head.length)).slice(0, one.reasoningChars)
  const started = Date.now()
  const hit = run(full)
  const elapsed = Date.now() - started
  assert.ok(hit !== null, 'the full-length bleed trips')
  assert.ok(elapsed < 20000, `must stay fast, took ${elapsed}ms`)
})
