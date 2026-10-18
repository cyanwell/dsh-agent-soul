/**
 * Fixture tests for the offline session analyzer (tools/analyze-session.mjs).
 *
 * The analyzer exists so issue #1's reporter can answer two questions from a
 * session file instead of re-running the model. That is only trustworthy if it
 * parses BOTH durable attempt formats and reproduces the detector's own verdict,
 * so each format gets a fixture here:
 *
 *   - v1 `assistant/chunk` (dsh <= 0.1.2-rc.1) — one event per chunk;
 *   - v2 `assistant/attempt` (dsh >= 0.1.5) — compacted `stream` records.
 *
 * Run through `node --test` so CI-less consumers cannot silently break the tool.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ANALYZER = fileURLToPath(new URL('../tools/analyze-session.mjs', import.meta.url))
const TOOL = fileURLToPath(new URL('../lib/index.js', import.meta.url))

/** Long enough to clear the analyzer's `--min-chars 8` test override. */
const STALLED = 'We must reconsider whether the retry budget is the true root cause of the failure here.'
const FRESH = 'The socket closed after the peer wrote a partial frame, so the reader saw an incomplete message.'

/**
 * Scratch directories created by this file, removed on process exit.
 *
 * `mkdtempSync` alone leaks one directory per call, and this suite calls it once
 * per test — a full-suite run left 164 of them behind in the OS tempdir before
 * this was added. `process.on('exit')` (not `after()`) is deliberate: it still
 * runs when a test fails or the runner bails, which is exactly when the leak
 * would otherwise accumulate unnoticed.
 */
const scratchDirs = []
process.on('exit', () => {
  for (const dir of scratchDirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})

/** Create a tracked scratch directory. Every temp dir MUST come from here. */
function scratchDir() {
  const dir = mkdtempSync(join(tmpdir(), 'tlg-analyzer-'))
  scratchDirs.push(dir)
  return dir
}

function writeSession(lines) {
  const dir = scratchDir()
  const file = join(dir, 'session.jsonl')
  writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n')
  return file
}

function run(file, extra = []) {
  const out = execFileSync(process.execPath, [ANALYZER, file, '--json', '--min-chars', '8', '--threshold', '2', ...extra], { encoding: 'utf8' })
  return JSON.parse(out)
}

test('analyzer reads v1 assistant/chunk events and groups them by (turn, step)', () => {
  const chunk = (turn, step, data) => ({ type: 'assistant/chunk', seq: 0, time: 0, data: { turn, step, chunk: data } })
  const file = writeSession([
    // step 1: reasoning only (no text) -> reasoning-only
    chunk(0, 0, { type: 'reasoning-delta', index: 0, text: STALLED }),
    chunk(0, 0, { type: 'finish', reason: 'stop' }),
    // step 2: same reasoning again, but this time with text -> repeated-material
    chunk(0, 1, { type: 'reasoning-delta', index: 0, text: STALLED }),
    chunk(0, 1, { type: 'text-delta', index: 1, text: 'still thinking' }),
    chunk(0, 1, { type: 'finish', reason: 'stop' }),
    { type: 'user/message', seq: 0, time: 0, data: { message: { id: 'm1', role: 'user', content: [] }, turn: 0, step: 2 } },
  ])
  const { steps } = run(file)
  assert.equal(steps.length, 2, 'two model calls')
  assert.equal(steps[0].verdict, 'reasoning-only')
  assert.equal(steps[0].hasOutput, false)
  assert.equal(steps[1].hasOutput, true)
  assert.equal(steps[1].verdict, 'repeated-material')
  // threshold 2: the second stalled step fires
  assert.equal(steps[1].fired, 'repeated-material')
})

test('analyzer reads v2 assistant/attempt events with compacted stream records', () => {
  const attempt = (turn, step, stream) => ({ type: 'assistant/attempt', seq: 0, time: 0, data: { turn, step, stream } })
  const file = writeSession([
    attempt(0, 0, [{ type: 'reasoning-chunks', time0: 0, texts: [[0, STALLED]] }]),
    attempt(0, 1, [
      { type: 'reasoning-chunks', time0: 0, texts: [[0, STALLED]] },
      { type: 'text-chunks', time0: 1, texts: [[1, 'still thinking']] },
    ]),
    attempt(0, 2, [
      { type: 'reasoning-chunks', time0: 0, texts: [[0, FRESH]] },
      { type: 'chunk', time: 1, chunk: { type: 'tool-call-delta', index: 0, id: 'c1', argumentsDelta: '{}' } },
    ]),
  ])
  const { steps } = run(file)
  assert.equal(steps.length, 3)
  assert.equal(steps[0].verdict, 'reasoning-only')
  assert.equal(steps[1].verdict, 'repeated-material')
  // Fresh material with real output is progress and ends the run.
  assert.equal(steps[2].verdict, 'progress')
  assert.equal(steps[2].textChars, '{}'.length)
})

test('analyzer survives unrelated and malformed lines without losing the steps', () => {
  const dir = scratchDir()
  const file = join(dir, 'session.jsonl')
  writeFileSync(file, [
    '{"type":"turn/start","seq":0,"time":0,"data":{"turn":0}}',
    'not json at all',
    JSON.stringify({ type: 'assistant/attempt', seq: 1, time: 1, data: { turn: 0, step: 0, stream: [{ type: 'reasoning-chunks', time0: 0, texts: [[0, STALLED]] }] } }),
    '',
    JSON.stringify({ type: 'turn/end', seq: 2, time: 2, data: { turn: 0 } }),
  ].join('\n') + '\n')
  const { steps } = run(file)
  assert.equal(steps.length, 1)
  assert.equal(steps[0].verdict, 'reasoning-only')
})

test('an unknown stream record type is skipped rather than guessed at', () => {
  const file = writeSession([
    { type: 'assistant/attempt', seq: 0, time: 0, data: { turn: 0, step: 0, stream: [
      { type: 'future-record-kind', texts: [[0, STALLED]] },
      { type: 'reasoning-chunks', time0: 1, texts: [[1, STALLED]] },
    ] } },
    { type: 'assistant/attempt', seq: 1, time: 1, data: { turn: 0, step: 1, stream: [
      { type: 'reasoning-chunks', time0: 0, texts: [[0, STALLED]] },
      { type: 'text-chunks', time0: 1, texts: [[1, 'text']] },
    ] } },
  ])
  const { steps } = run(file)
  assert.equal(steps[0].verdict, 'reasoning-only')
  assert.equal(steps[1].verdict, 'repeated-material')
})

test('analyzer reports no steps for a session with no assistant events', () => {
  const file = writeSession([{ type: 'turn/start', seq: 0, time: 0, data: { turn: 0 } }])
  const { steps } = run(file)
  assert.deepEqual(steps, [])
})

test('analyzer verdicts agree with the shipped LoopDetector for the same input', async () => {
  // Import through a file:// URL, not the filesystem path: the default ESM
  // loader rejects a bare `g:\...`/`C:\...` path on Windows with
  // ERR_UNSUPPORTED_ESM_URL_SCHEME, so the path form makes this assertion
  // unrunnable on the platform the guard is most used on.
  const { LoopDetector } = await import(new URL('../lib/index.js', import.meta.url).href)
  const config = { maxThinkingSteps: 2, minReasoningChars: 8, similarityThreshold: 0.8, maxFires: 4 }
  const file = writeSession([
    { type: 'assistant/attempt', seq: 0, time: 0, data: { turn: 0, step: 0, stream: [{ type: 'reasoning-chunks', time0: 0, texts: [[0, STALLED]] }] } },
    { type: 'assistant/attempt', seq: 1, time: 1, data: { turn: 0, step: 1, stream: [
      { type: 'reasoning-chunks', time0: 0, texts: [[0, STALLED]] },
      { type: 'text-chunks', time0: 1, texts: [[1, 'x']] },
    ] } },
  ])
  const analyzed = run(file)
  const detector = new LoopDetector(config)
  const direct = [
    detector.observe({ hasOutput: false, reasoning: STALLED }),
    detector.observe({ hasOutput: true, reasoning: STALLED }),
  ]
  assert.deepEqual(analyzed.steps.map(s => s.verdict), direct.map(r => r ?? 'progress'))
})

/* -------------------------------------------------------------------------- */
/* the issue #2848 shape: one call that repeats itself forever                */
/* -------------------------------------------------------------------------- */

/**
 * The reported session had ONE model call streaming ~2825 identical text
 * chunks (~420,000 characters). It never finished, so no per-call verdict can
 * describe it — the only useful question is whether the intra-call breaker would
 * have stopped it, which is what `repeatedRun`/`wouldBreak` report.
 */
test('analyzer flags a single call that repeats one sentence to the end', () => {
  const sentence = 'The `register` API matches. '
  const texts = Array.from({ length: 300 }, (_, i) => [i, sentence])
  const file = writeSession([
    { type: 'assistant/attempt', seq: 0, time: 0, data: { turn: 0, step: 20, stream: [
      { type: 'text-chunks', time0: 0, texts },
      { type: 'reasoning-chunks', time0: 0, texts: [[0, STALLED]] },
    ] } },
  ])
  const { steps } = run(file, ['--max-repeated-text', '60'])
  assert.equal(steps.length, 1)
  assert.equal(steps[0].repeatedRun, 300, 'the whole call is one identical-chunk run')
  assert.equal(steps[0].wouldBreak, true)
  assert.equal(steps[0].textChunks, 300)
})

test('the analyzer matches the streaming plugin: an early run IS cut, before the tail changes', () => {
  // This assertion used to read `wouldBreak === false`, and that was WRONG — it
  // described a post-hoc reading of the whole text rather than what the plugin
  // does. The plugin decides *while the stream is open*: on the third `header`
  // the run reaches the threshold and the call is cut there. It cannot know that
  // the fourth chunk will differ, because that chunk has not arrived yet.
  //
  // So the analyzer now feeds the real `TextRepetitionDetector` chunk by chunk,
  // and the verdict is "cut" — which is what the plugin actually does. The old
  // assertion certified a divergence between the tool and the plugin it exists
  // to model.
  const file = writeSession([
    { type: 'assistant/attempt', seq: 0, time: 0, data: { turn: 0, step: 0, stream: [
      { type: 'text-chunks', time0: 0, texts: [[0, 'header'], [1, 'header'], [2, 'header'], [3, 'then real work continued here']] },
    ] } },
  ])
  const { steps } = run(file, ['--max-repeated-text', '3'])
  // `repeatedRun` still reports the trailing run of the WHOLE call, which is 1 —
  // it is a descriptive statistic, not the verdict.
  assert.equal(steps[0].repeatedRun, 1)
  assert.equal(steps[0].wouldBreak, true, 'the plugin cuts on the third identical chunk')
  assert.equal(steps[0].wouldBreakBy, 'identical-chunks')
  assert.equal(steps[0].brokeAt, 18, 'three 6-character chunks')
})

test('analyzer leaves a healthy multi-chunk call alone', () => {
  const file = writeSession([
    { type: 'assistant/attempt', seq: 0, time: 0, data: { turn: 0, step: 0, stream: [
      { type: 'text-chunks', time0: 0, texts: [[0, 'chunk one'], [1, 'chunk two'], [2, 'chunk three']] },
    ] } },
  ])
  const { steps } = run(file)
  assert.equal(steps[0].repeatedRun, 1)
  assert.equal(steps[0].wouldBreak, false)
})

/* -------------------------------------------------------------------------- */
/* the discussion #7043 shape: a call cycling a few lines instead of working   */
/* -------------------------------------------------------------------------- */

/**
 * The tool answers "would the shipped breaker have cut this call?" — so it must
 * answer it for BOTH rules the plugin ships. This fixture is the reported shape
 * exactly: `好。 / 发。 / 好。 / 好。` cycled for tens of lines, where a tool call
 * belonged. Its identical-delta run is 2, which is why the chunk rule alone
 * reported "nothing to see" on the very session the reporter would analyze.
 */
test('analyzer flags a call cycling a few short lines, which the chunk rule misses', () => {
  const cycle = '好。\n发。\n好。\n好。\n'
  const texts = cycle.repeat(40).split(/(?<=\n)/).filter(s => s !== '').map((text, i) => [i, text])
  const file = writeSession([
    { type: 'assistant/attempt', seq: 0, time: 0, data: { turn: 4, step: 9, stream: [
      { type: 'text-chunks', time0: 0, texts },
    ] } },
  ])
  const { steps } = run(file)
  assert.equal(steps.length, 1)
  assert.equal(steps[0].repeatedRun, 2, 'the chunk rule cannot see a cycle')
  assert.ok(steps[0].cycleSpan >= 256, `the cycle rule must see it, got ${steps[0].cycleSpan}`)
  assert.equal(steps[0].wouldBreak, true)
  assert.equal(steps[0].wouldBreakBy, 'repeating-cycle')
})

test('analyzer reads the same shape from the v1 assistant/chunk format', () => {
  const cycle = '好。\n发。\n好。\n好。\n'
  const lines = cycle.repeat(40).split(/(?<=\n)/).filter(s => s !== '')
    .map((text, i) => ({ type: 'assistant/chunk', seq: i, time: 0, data: { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text } } }))
  const { steps } = run(writeSession(lines))
  assert.equal(steps[0].wouldBreakBy, 'repeating-cycle')
})

test('analyzer does not flag a legitimately repetitive but healthy call', () => {
  // The false-positive control at the tool level too: generated CSS rows look
  // periodic to a coverage measure and are not periodic.
  const texts = Array.from({ length: 40 }, (_, i) => [i, `.row-${i} { display: flex; align-items: center; gap: 8px; }\n`])
  const file = writeSession([
    { type: 'assistant/attempt', seq: 0, time: 0, data: { turn: 0, step: 0, stream: [{ type: 'text-chunks', time0: 0, texts }] } },
  ])
  const { steps } = run(file)
  assert.equal(steps[0].cycleSpan, 0)
  assert.equal(steps[0].wouldBreak, false)
})
