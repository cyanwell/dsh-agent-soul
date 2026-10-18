#!/usr/bin/env node
/**
 * Offline replay of the thinking-loop guard over a real dsh session file.
 *
 * Issue #1 (jilian-dsh) needs two answers that only their machine has:
 * "did the recurring calls emit text?" and "how similar were the reasoning
 * texts?". Both are answerable from a session jsonl without re-running the
 * model — and the answer is trustworthy only if it is produced by the SAME
 * decision rule the plugin runs, so this script reuses `LoopDetector` from the
 * plugin rather than re-implementing the heuristic (a re-implementation would
 * be a second source of truth, and the whole point is to report what the
 * installed guard would have decided).
 *
 * Usage:
 *   node tools/analyze-session.mjs <session.jsonl> [--similarity 0.8] [--threshold 3]
 *                                [--min-chars 2048] [--max-fires 4] [--json]
 *
 * Reads both durable attempt formats:
 *   - `assistant/chunk` (session format v1: dsh <= 0.1.2-rc.1) — one event per
 *     stream chunk, grouped by (turn, step);
 *   - `assistant/attempt` (session format v2: dsh >= 0.1.5) — one event per
 *     attempt carrying the whole compacted `stream` record array.
 *
 * A "step" is one model call, i.e. one (turn, step) group. For each step it
 * reports whether text/tool output was emitted and what the reasoning was, then
 * feeds the same `StepObservation` the plugin feeds at runtime.
 *
 * It also reports the **intra-call** shape (issue #2848): the trailing run of
 * identical visible-output chunks inside one call, which is the only measure
 * that describes a call repeating itself for minutes without ever ending. That
 * shape is invisible to every per-call verdict on purpose — the call never
 * completes — so it gets its own column. Two columns after it answer "would the
 * shipped breaker have cut this call?" for both rules the plugin ships:
 * `repeatedRun` (identical deltas, `--max-repeated-text`) and `cycleSpan` (the
 * exact verbatim period at the tail, `--max-repeated-cycle`).
 *
 * The cycle rule exists because of discussion #7043: a call bleeding `好。 / 发。 /
 * 好。 / 好。` for tens of lines has a run of identical deltas of 2, so the chunk
 * rule never fires — and the reporter's session file is exactly what this tool
 * is pointed at to answer whether the shipped plugin would have cut it.
 */
import { readFileSync } from 'node:fs'
import { LoopDetector, TextRepetitionDetector, countRepeatedText, trailingCycle } from '../lib/index.js'

const DEFAULT_CONFIG = {
  maxThinkingSteps: 3,
  minReasoningChars: 2048,
  similarityThreshold: 0.8,
  maxFires: 4,
  maxRepeatedText: 60,
  maxRepeatedCycleChars: 512,
  minRepeatedCycleChars: 256,
  maxRepeatedReasoningCycleChars: 512,
  minRepeatedReasoningCycleChars: 512,
  maxRepeatedReasoningLineChars: 2048,
  minRepeatedReasoningLineCoverage: 0.6,
  minRepeatedReasoningLineConcentration: 4,
  maxRepeatedTextLineChars: 2048,
  minRepeatedTextLineCoverage: 0.6,
  minRepeatedTextLineConcentration: 4,
}

function parseArgs(argv) {
  const config = { ...DEFAULT_CONFIG }
  let file
  let asJson = false
  const flags = { '--similarity': 'similarityThreshold', '--threshold': 'maxThinkingSteps', '--min-chars': 'minReasoningChars', '--max-fires': 'maxFires', '--max-repeated-text': 'maxRepeatedText', '--max-repeated-cycle': 'maxRepeatedCycleChars', '--min-repeated-cycle': 'minRepeatedCycleChars' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') { asJson = true; continue }
    if (flags[arg] !== undefined) {
      const value = Number(argv[++i])
      if (!Number.isFinite(value)) throw new Error(`${arg} expects a number`)
      config[flags[arg]] = value
      continue
    }
    if (arg.startsWith('--')) throw new Error(`unknown flag ${arg}`)
    file = arg
  }
  if (file === undefined) throw new Error('usage: node tools/analyze-session.mjs <session.jsonl> [--json]')
  return { file, config, asJson }
}

/** True when a chunk is model-authored output (as opposed to reasoning). */
function isOutputChunk(type) {
  return type === 'text-delta' || type === 'tool-call-delta'
}

/** Pull the reasoning/text/tool deltas out of one raw chunk. */
function readChunk(chunk) {
  if (chunk === null || typeof chunk !== 'object') return undefined
  const type = chunk.type
  if (typeof type !== 'string') return undefined
  if (type === 'reasoning-delta') return { type, text: String(chunk.text ?? '') }
  if (type === 'text-delta') return { type, text: String(chunk.text ?? '') }
  if (type === 'tool-call-delta') return { type, text: String(chunk.argumentsDelta ?? '') }
  return { type, text: '' }
}

/**
 * Flatten one v1 `assistant/chunk` event into chunk-like deltas.
 *
 * The durable event carries `data.chunk` with the plugin-facing `StreamChunk`
 * shape, so the mapping is direct.
 */
function deltasFromChunkEvent(event) {
  const chunk = event?.data?.chunk
  const delta = readChunk(chunk)
  return delta === undefined ? [] : [delta]
}

/**
 * Flatten one v2 `assistant/attempt` event's compacted stream into deltas.
 *
 * The durable stream is a compacted record array, not raw chunks:
 *   - `{ type: 'chunk', time, chunk }` — one chunk, unchanged;
 *   - `{ type: 'text-chunks' | 'reasoning-chunks' | 'tool-call-chunks', texts:
 *      Array<[time, string]> }` — a run-length-compacted delta group.
 * Unknown record types are ignored rather than guessed at, so a future format
 * addition degrades to "fewer steps observed" instead of a wrong verdict.
 */
function deltasFromAttemptEvent(event) {
  const stream = event?.data?.stream
  if (!Array.isArray(stream)) return []
  const out = []
  for (const record of stream) {
    if (record === null || typeof record !== 'object') continue
    if (record.type === 'chunk') {
      const delta = readChunk(record.chunk)
      if (delta !== undefined) out.push(delta)
      continue
    }
    const texts = record.texts
    if (!Array.isArray(texts)) continue
    const type = record.type === 'text-chunks'
      ? 'text-delta'
      : record.type === 'reasoning-chunks'
        ? 'reasoning-delta'
        : record.type === 'tool-call-chunks'
          ? 'tool-call-delta'
          : undefined
    if (type === undefined) continue
    for (const entry of texts) {
      const text = Array.isArray(entry) ? entry[1] : entry
      out.push({ type, text: String(text ?? '') })
    }
  }
  return out
}

/** Group the file's events into per-model-call steps, in file order. */
function readSteps(lines) {
  const steps = []
  const byCoordinate = new Map()
  for (const line of lines) {
    if (line.trim().length === 0) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    const type = event?.type
    if (type !== 'assistant/chunk' && type !== 'assistant/attempt') continue
    // v1 chunk events carry (turn, step) in data; v2 attempts are already one step.
    const turn = event?.data?.turn
    const step = event?.data?.step
    const key = `${turn}/${step}`
    let group = byCoordinate.get(key)
    if (group === undefined) {
      group = { turn, step, reasoning: '', text: '', texts: [], hasOutput: false }
      byCoordinate.set(key, group)
      steps.push(group)
    }
    const deltas = type === 'assistant/chunk' ? deltasFromChunkEvent(event) : deltasFromAttemptEvent(event)
    for (const delta of deltas) {
      if (delta.type === 'reasoning-delta') group.reasoning += delta.text
      else if (isOutputChunk(delta.type)) {
        group.hasOutput = true
        group.text += delta.text
        // Only text deltas participate in the intra-call breaker; tool-argument
        // deltas are chunked by the provider's own tokenizer.
        if (delta.type === 'text-delta') group.texts.push(delta.text)
      }
    }
  }
  return steps
}

const { file, config, asJson } = parseArgs(process.argv.slice(2))
const lines = readFileSync(file, 'utf8').split('\n')
const steps = readSteps(lines)

const detector = new LoopDetector({ pollMs: 0, graceMs: 0, escalate: 'steer', ...config })
const report = []
for (const [index, step] of steps.entries()) {
  const reason = detector.observe({ hasOutput: step.hasOutput, reasoning: step.reasoning })
  const fire = detector.takeFire()
  const repeatRun = countRepeatedText(step.texts)
  // Every rule runs on the SAME input the plugin's breaker sees: text deltas
  // only, in stream order. This tool exists to answer "would the shipped breaker
  // have cut this call?", so a rule the plugin has but the tool does not would
  // make the tool quietly wrong. That is why the decision comes from the real
  // `TextRepetitionDetector` rather than from a re-implementation: a hand-rolled
  // copy silently missed the phrase-pool rule the moment it was added.
  const breaker = new TextRepetitionDetector(config)
  let brokeAt = 0
  for (const chunk of step.texts) {
    if (breaker.push(chunk)) { brokeAt = breaker.emittedChars; break }
  }
  const wouldBreakBy = brokeAt > 0 ? (breaker.trippedBy ?? null) : null
  const cycleSpan = trailingCycle(step.texts.join(''), config.maxRepeatedCycleChars, config.minRepeatedCycleChars)
  report.push({
    step: index + 1,
    turn: step.turn,
    call: step.step,
    reasoningChars: step.reasoning.length,
    textChars: step.text.length,
    textChunks: step.texts.length,
    hasOutput: step.hasOutput,
    verdict: reason ?? 'progress',
    fired: fire ?? null,
    // The intra-call shape (issue #2848). `repeatedRun` is the trailing run of
    // identical visible-output chunks; `wouldBreak` answers whether the shipped
    // breaker would have ended this call mid-stream.
    repeatedRun: repeatRun,
    cycleSpan,
    brokeAt,
    // The figure the notice would print — taken from the breaker itself so the
    // tool cannot misreport it.
    repeatedChars: breaker.repeatedChars,
    wouldBreak: wouldBreakBy !== null,
    wouldBreakBy,
  })
}
const broken = report.filter(r => r.wouldBreak).length

if (asJson) {
  process.stdout.write(`${JSON.stringify({ file, config, steps: report }, null, 2)}\n`)
} else {
  console.log(`session: ${file}`)
  console.log(`config:  ${JSON.stringify(config)}`)
  console.log(`steps:   ${steps.length} model call(s)`)
  console.log('')
  console.log('  #   turn/step   reasonChars  textChars  chunks  verdict             fired  repeatedRun  cycleSpan  repeatedChars  break')
  for (const row of report) {
    console.log(
      `  ${String(row.step).padStart(2)}  ${String(row.turn)}/${String(row.call)}`.padEnd(20)
      + `${String(row.reasoningChars).padStart(9)}  ${String(row.textChars).padStart(9)}  `
      + `${String(row.textChunks).padStart(6)}  ${row.verdict.padEnd(18)}  ${String(row.fired ?? '').padEnd(5)}  `
      + `${String(row.repeatedRun).padStart(11)}  ${String(row.cycleSpan).padStart(9)}  `
      + `${String(row.repeatedChars).padStart(13)}  `
      + `${row.wouldBreak ? `BREAK(${row.wouldBreakBy})` : ''}`,
    )
  }
  const stalls = report.filter(r => r.verdict !== 'progress').length
  const fires = report.filter(r => r.fired !== null).length
  const withText = report.filter(r => r.hasOutput).length
  console.log('')
  console.log(`stalled steps: ${stalls}/${report.length}  |  reactions: ${fires}  |  steps that emitted text: ${withText}`)
  const byChunks = report.filter(r => r.wouldBreakBy === 'identical-chunks').length
  const byCycle = report.filter(r => r.wouldBreakBy === 'repeating-cycle').length
  console.log(`intra-call repetition: ${broken} call(s) would be cut mid-stream `
    + `(${byChunks} by identical chunks, maxRepeatedText = ${config.maxRepeatedText}; `
    + `${byCycle} by a repeating cycle, maxRepeatedCycleChars = ${config.maxRepeatedCycleChars}, `
    + `minRepeatedCycleChars = ${config.minRepeatedCycleChars})`)
  if (byCycle === 0 && byChunks === 0 && report.some(r => r.repeatedRun > 1)) {
    const worst = Math.max(...report.map(r => r.repeatedRun))
    console.log(`  (the longest identical-chunk run seen was ${worst}; lower --max-repeated-text to cut such calls)`)
  }
  if (report.length === 0) {
    console.log('(no assistant steps found — is this a v1 `assistant/chunk` or v2 `assistant/attempt` session?)')
  }
}
