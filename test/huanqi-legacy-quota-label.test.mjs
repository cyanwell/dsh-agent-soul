import assert from 'node:assert/strict'
import test from 'node:test'
import { huanqiCard } from '../src/organs/huanqi-read.mjs'

test('stale legacy DSH quota is labeled historical and deactivated, not live', () => {
  const card = huanqiCard({
    agentSoul: { ok: true, worst: { sid: 'session', stalled: 1, threshold: 3, observed: 2 } },
    dsh: { ok: true, ledgerStale: true, ledgerAgeMs: 36 * 60 * 1000, credit: 4, creditMax: 6, stats: null, lastTurn: null, ledgerFile: 'legacy-ledger.json' },
  })
  assert.match(card.note, /旧 DSH 额度（已停用 · 历史） 4\/6/)
  assert.match(card.note, /36 分钟未更新/)
  assert.doesNotMatch(card.note, /DSH 额度 4\/6/)
  assert.equal(card.value, '1 / 3')
})

test('fresh DSH quota keeps its active label', () => {
  const card = huanqiCard({
    agentSoul: { ok: true, worst: { sid: 'session', stalled: 0, threshold: 3, observed: 1 } },
    dsh: { ok: true, ledgerStale: false, ledgerAgeMs: 1000, credit: 2, creditMax: 6, stats: null, lastTurn: null, ledgerFile: 'live-ledger.json' },
  })
  assert.match(card.note, /DSH 额度 2\/6/)
  assert.doesNotMatch(card.note, /已停用/)
})
