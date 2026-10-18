// 端到端：把插件产出的 chunk 序列喂给 dsh 真实的 BlockAssembler，
// 证明①不违反 invariant ②blocks() 非空（客户端拿得到可渲染内容）。
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import * as plugin from '../lib/index.js'

// `BlockAssembler` has no exported subpath, so resolve the real file the way the
// harness does. This is the assembler `agent-loop` feeds every chunk into, so
// running the break's output through it is the closest thing to the production
// path available outside a live session.
const require = createRequire(import.meta.url)
const { BlockAssembler } = await import(
  new URL('lib/types/assembler.js', `file://${require.resolve('@deepseek-ai/dsh-llm/package.json').replace(/package\.json$/, '')}`).href
)

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures-reasoning-bleed.json', import.meta.url), 'utf8'))
const BLEED = FIXTURE.loops.find((l) => l.minPeriod > 0).text.repeat(3)

const CONFIG = {
  maxThinkingSteps: 3, minReasoningChars: 2048, similarityThreshold: 0.8,
  escalate: 'steer', maxFires: 4, cancelCause: 'thinking-loop',
  maxRepeatedText: 0, maxRepeatedCycleChars: 0, minRepeatedCycleChars: 512,
  maxRepeatedReasoningCycleChars: 512, minRepeatedReasoningCycleChars: 512,
  breakCode: 'REPETITIVE_OUTPUT', breakCorrection: true, resumeAfterBreak: false,
}

const agent = { steer: () => {}, inject: () => {}, cancel: () => {} }
let listener = null
const ctx = {
  on: (n, fn) => { if (n === 'llm/stream') listener = fn },
  logger: { warn: () => {}, debug: () => {} },
  agents: { get: () => agent },
  get: () => undefined,
}
plugin.apply(ctx, CONFIG)

async function* source() {
  yield { type: 'block-start', index: 0, blockType: 'reasoning' }
  for (const t of BLEED.match(/[\s\S]{1,32}/g)) yield { type: 'reasoning-delta', index: 0, text: t }
}

const options = markAgentLoopRequest({ sessionId: 's1', provider: 'p', model: 'm', messages: [] })
const out = []
for await (const c of listener(options, source)) out.push(c)

console.log('chunks emitted:', out.length)
console.log('last chunk    :', JSON.stringify(out.at(-1)))

// ① 真实 invariant
const { apply: applyInvariant } = await import('@deepseek-ai/dsh-llm/invariant')
const failures = []
const fail = (m) => failures.push(m)
const inner = new Proxy(ctx, { get: (t, k) => (k === 'on' ? t.on.bind(t) : t[k]) })
await applyInvariant({ ...inner, invariants: { register: (_n, inst) => inst(inner, fail) } }, fail)
console.log('\ninvariant failures:', failures.length ? failures : '(none)')

// ② 真实 BlockAssembler → 客户端会拿到的 blocks
const asm = new BlockAssembler()
for (const c of out) asm.push(c)
const blocks = asm.blocks()
console.log('assembled blocks:', JSON.stringify(blocks.map((b) => ({ type: b.type, len: (b.text ?? '').length }))))
console.log('finish reason   :', JSON.stringify(asm.finish))
console.log('\n可渲染（blocks 非空）:', blocks.length > 0 && blocks.every((b) => (b.text ?? '').length > 0))
