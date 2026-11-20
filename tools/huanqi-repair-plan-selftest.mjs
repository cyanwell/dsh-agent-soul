import assert from 'node:assert/strict'
import { validateHuanqiRepairPlan as validate } from '../src/organs/huanqi-repair-plan.mjs'

// All identifiers and statements below are invented. No files or services are queried.
function fixture () {
  const sessionId = 'synthetic-session-A'
  function source (eventId, eventRevision, frameSeq, hostSeq, kind, text) {
    return { ref: { sessionId, eventId, eventRevision, frameSeq, hostSeq }, kind, text }
  }
  const user = source('event-question', 'r1', 0, 4, 'user', '校准范围是什么？禁止加热。')
  const first = source('event-run-A', 'r2', 3, 19, 'tool_result', '校准记录：采样结束。A 批偏差 7；尝试 A 失败。')
  const second = source('event-run-B', 'r3', 5, 28, 'tool_result', '校准记录：采样结束。B 批偏差 9；B 批尚未复测。')
  const assistant = source('event-report', 'r1', 6, 31, 'assistant', '先判 A 批通过，随后撤回。暂不验收。')
  const outside = source('event-run-C', 'r1', 8, 42, 'tool_result', 'C 批记录，不在本次目标集合。')
  function cite (record, quote) {
    const start = record.text.indexOf(quote)
    assert.ok(start >= 0)
    return { ref: record.ref, start, end: start + quote.length, quote }
  }
  const shared = '校准记录：采样结束。'
  const items = [
    { id: 'question-range', kind: 'question', text: '确认校准范围。', citations: [cite(user, '校准范围是什么？')] },
    { id: 'no-heat', kind: 'constraint', text: '禁止加热。', citations: [cite(user, '禁止加热。')] },
    { id: 'common', kind: 'evidence', text: '两批均记录采样结束。', citations: [cite(first, shared), cite(second, shared)] },
    { id: 'A-failed', kind: 'failure', text: 'A 批偏差 7；尝试 A 失败。', citations: [cite(first, 'A 批偏差 7；尝试 A 失败。')] },
    { id: 'correction', kind: 'reversal', text: '撤回 A 批通过的判断。', citations: [cite(assistant, '先判 A 批通过，随后撤回。')] },
    { id: 'current', kind: 'conclusion', text: '当前暂不验收。', citations: [cite(assistant, '暂不验收。')] },
    { id: 'B-pending', kind: 'unresolved', text: 'B 批偏差 9；B 批尚未复测。', citations: [cite(second, 'B 批偏差 9；B 批尚未复测。')] },
  ]
  const context = {
    version: 1, kind: 'authorized-synthetic-visible-snapshot',
    binding: { sessionId, snapshotId: 'snapshot-1', scopeId: 'request-scope-1',
      evidenceRevision: 'e3', projectionRevision: 'p2', issuedAtMs: 1_000, expiresAtMs: 2_000 },
    nowMs: 1_500,
    evidence: [user, first, second, assistant, outside], targets: [first.ref, second.ref], requiredItems: items,
  }
  // JSON round-trip duplicates internal refs too, so tampering one citation doesn't change a target.
  const proposal = JSON.parse(JSON.stringify({ version: 1, kind: 'derived-repair-plan', origin: 'manual',
    binding: context.binding, targets: context.targets, items }))
  return { context, proposal }
}

let passed = 0
function run (name, test) {
  test()
  passed++
  console.log('ok - ' + name)
}

const candidate = { ok: true, disposition: 'review-only', canApply: false, targetComparison: 'distinct-visible-text' }
function rejects (name, code, mutate) {
  run(name, () => {
    const { context, proposal } = fixture()
    mutate(context, proposal)
    assert.deepEqual(validate(context, proposal), { ok: false, disposition: 'keep-original', canApply: false, code })
  })
}

function freezeDeep (value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child)
    Object.freeze(value)
  }
  return value
}

run('manual and LLM use same validation; partial overlap remains review-only', () => {
  const { context, proposal } = fixture()
  const original = JSON.stringify({ context, proposal })
  assert.deepEqual(validate(freezeDeep(context), freezeDeep(proposal)), candidate)
  const automatic = { ...proposal, origin: 'embedded-llm', targets: [...proposal.targets].reverse(),
    items: [...proposal.items].reverse().map((item) => ({ ...item, citations: [...item.citations].reverse() })) }
  assert.deepEqual(validate(context, automatic), candidate)
  assert.equal(JSON.stringify({ context, proposal }), original)
})

run('even exact duplicate visible text is never applicable', () => {
  const { context, proposal } = fixture()
  context.evidence[2].text = context.evidence[1].text
  context.requiredItems = context.requiredItems.filter((item) => item.id !== 'B-pending')
  proposal.items = proposal.items.filter((item) => item.id !== 'B-pending')
  assert.deepEqual(validate(context, proposal), { ...candidate, targetComparison: 'identical-visible-text' })
})

run('a matching quote alone does not certify a new claim', () => {
  const { context, proposal } = fixture()
  proposal.items.push({ id: 'unsupported-claim', kind: 'inference', text: '采样结束说明温度设置造成了偏差。',
    citations: [proposal.items[2].citations[0]] })
  assert.deepEqual(validate(context, proposal), candidate)
})

run('window start is inclusive', () => {
  const { context, proposal } = fixture()
  context.nowMs = context.binding.issuedAtMs
  assert.deepEqual(validate(context, proposal), candidate)
})
rejects('expiry boundary is exclusive', 'OUTSIDE_TIME_WINDOW', (c) => { c.nowMs = c.binding.expiresAtMs })
rejects('not yet issued', 'OUTSIDE_TIME_WINDOW', (c) => { c.nowMs = c.binding.issuedAtMs - 1 })
rejects('renewed context cannot renew the old proposal', 'BINDING_MISMATCH', (c) => {
  c.nowMs = c.binding.expiresAtMs
  c.binding.expiresAtMs++
})
rejects('proposal cannot extend validity', 'BINDING_MISMATCH', (_c, p) => { p.binding.expiresAtMs++ })
rejects('missing local clock', 'INVALID_CONTEXT', (c) => { delete c.nowMs })
rejects('wrong session binding', 'BINDING_MISMATCH', (_c, p) => { p.binding.sessionId = 'synthetic-other' })
rejects('wrong scope', 'BINDING_MISMATCH', (_c, p) => { p.binding.scopeId = 'another-request' })
rejects('wrong snapshot', 'BINDING_MISMATCH', (_c, p) => { p.binding.snapshotId = 'snapshot-0' })
rejects('stale evidence revision', 'BINDING_MISMATCH', (c) => { c.binding.evidenceRevision = 'e4' })
rejects('stale projection revision', 'BINDING_MISMATCH', (c) => { c.binding.projectionRevision = 'p3' })
rejects('wrong citation session', 'REFERENCE_SESSION_MISMATCH', (_c, p) => { p.items[0].citations[0].ref.sessionId = 'synthetic-other' })
rejects('frame seq cannot substitute for host seq', 'SOURCE_NOT_IN_SNAPSHOT', (_c, p) => { p.targets[0].hostSeq = p.targets[0].frameSeq })
rejects('wrong citation frame seq', 'SOURCE_NOT_IN_SNAPSHOT', (_c, p) => { p.items[0].citations[0].ref.frameSeq = 1 })
rejects('no silent default for a missing host seq', 'INVALID_REFERENCE', (_c, p) => { delete p.targets[0].hostSeq })
rejects('wrong event revision', 'SOURCE_NOT_IN_SNAPSHOT', (_c, p) => { p.targets[0].eventRevision = 'r1' })
rejects('forged source locator despite exact quote text', 'SOURCE_NOT_IN_SNAPSHOT', (_c, p) => { p.items[0].citations[0].ref.eventId = 'invented' })
rejects('forged quote at real locator', 'CITATION_QUOTE_MISMATCH', (_c, p) => { p.items[0].citations[0].quote = '校准范围是零？' })
rejects('shifted quote offset', 'CITATION_QUOTE_MISMATCH', (_c, p) => { p.items[0].citations[0].start++ })
rejects('duplicate host sequence in trusted set is ambiguous', 'AMBIGUOUS_EVIDENCE_IDENTITY', (c) => { c.evidence[2].ref.hostSeq = c.evidence[1].ref.hostSeq })
rejects('eligible tool result outside selected scope', 'TARGET_OUTSIDE_SCOPE', (c, p) => { p.targets[1] = c.evidence[4].ref })
rejects('omits an authorized target', 'TARGET_SET_MISMATCH', (_c, p) => { p.targets.pop() })
rejects('duplicate target', 'DUPLICATE_TARGET', (_c, p) => { p.targets[1] = p.targets[0] })
for (const i of [0, 3]) {
  rejects('user and assistant text are evidence, not targets: ' + i, 'INELIGIBLE_TARGET', (c) => { c.targets[0] = c.evidence[i].ref })
}
rejects('synthetic tool call is not a target', 'INELIGIBLE_TARGET', (c) => { c.evidence[1].kind = 'tool_call' })
rejects('placeholder is not a target', 'INELIGIBLE_TARGET', (c) => { c.evidence[1].text = '[换气] 定点清除 seq 19' })
rejects('target must be cited even if absent from obligations', 'UNCITED_TARGET', (c, p) => {
  c.requiredItems = c.requiredItems.filter((item) => !['common', 'B-pending'].includes(item.id))
  p.items = p.items.filter((item) => !['common', 'B-pending'].includes(item.id))
})
for (const id of ['no-heat', 'A-failed', 'correction', 'B-pending']) {
  rejects('omits required decision: ' + id, 'MISSING_REQUIRED_ITEM', (_c, p) => { p.items = p.items.filter((item) => item.id !== id) })
}
rejects('inverts negation despite valid quote', 'CHANGED_REQUIRED_ITEM', (_c, p) => { p.items[1].text = '允许加热。' })
rejects('merges distinct numbers despite retaining a quote', 'CHANGED_REQUIRED_ITEM', (_c, p) => { p.items[6].text = 'B 批偏差 7；B 批尚未复测。' })
rejects('drops one required citation', 'CHANGED_REQUIRED_ITEM', (_c, p) => { p.items[2].citations.pop() })
rejects('duplicates a required item', 'DUPLICATE_ITEM', (_c, p) => { p.items.push(p.items[0]) })
rejects('duplicates an exact citation', 'DUPLICATE_CITATION', (_c, p) => { p.items[2].citations.push(p.items[2].citations[0]) })
rejects('omits all independently required items', 'INVALID_ITEM_SET', (c) => { c.requiredItems = [] })
rejects('unknown plan field cannot convey authority', 'INVALID_PROPOSAL', (_c, p) => { p.apply = true })
rejects('unknown evidence field', 'INVALID_EVIDENCE', (c) => { c.evidence[0].extra = 'synthetic' })
rejects('unknown nested citation field', 'INVALID_CITATION', (_c, p) => { p.items[0].citations[0].extra = 'synthetic' })
rejects('unrecognized source kind', 'INVALID_EVIDENCE', (c) => { c.evidence[0].kind = 'unsupported' })
rejects('unknown fields on an array are rejected', 'INVALID_TARGET_SET', (_c, p) => { p.targets.extra = true })
rejects('sparse array rejected', 'INVALID_ITEM_SET', (_c, p) => { delete p.items[0] })
rejects('oversize evidence rejected', 'INVALID_EVIDENCE', (c) => { c.evidence[0].text = 'x'.repeat(32_769) })
run('accessor is rejected without invoking it', () => {
  const { context, proposal } = fixture()
  let called = false
  Object.defineProperty(proposal.items[0], 'text', { get () { called = true; return 'synthetic' } })
  assert.equal(validate(context, proposal).code, 'INVALID_ITEM')
  assert.equal(called, false)
})

console.log('huanqi-repair-plan-selftest: ' + passed + ' cases passed (synthetic only; no apply)')
