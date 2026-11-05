import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-qzone-'))

const { createQzone } = await import('../src/features/qzone.js')
const { dataDir, readJson, writeJson } = await import('../src/core/store.js')

const noopLog = { info() {}, warn() {} }
const hub = { chatLogOf: () => [] }
const config = { enabled: true, dryRun: false, diary: { visibility: 'all', minChars: 60, maxChars: 140 } }

/** 一个记录调用的假 OneBot：responses 按顺序回给每次 call。 */
function mockOnebot(responses = [], { fail = null } = {}) {
  const calls = []
  return {
    calls,
    async call(action, params, opts) {
      calls.push({ action, params, opts })
      if (fail) throw fail
      const next = responses.shift()
      if (next instanceof Error) throw next
      return next
    },
  }
}

function seed(history) {
  writeJson(dataDir('diary.json'), { plan: { day: '', times: [], done: [] }, history })
}

function qzoneWith(onebot) {
  return createQzone({ getConfig: () => config, onebot, hub, log: noopLog })
}

function entry(tid, extra = {}) {
  return { at: Date.now() - 60_000, text: '写了一条', ok: true, tid, dryRun: false, visibility: 'all', error: '', ...extra }
}

test('remove：删除成功后把本地记录标记为已删除', async () => {
  seed([entry('t1'), entry('t2')])
  const onebot = mockOnebot([{ tid: 't1' }])
  const qzone = qzoneWith(onebot)

  await qzone.remove('t1')

  assert.equal(onebot.calls[0].action, 'delete_qzone_msg')
  assert.equal(onebot.calls[0].params.tid, 't1', 'tid 以字符串形式交给 OneBot')
  const saved = readJson(dataDir('diary.json'), () => ({}))
  assert.ok(saved.history[0].deletedAt, '被删的那条有 deletedAt')
  assert.equal(saved.history[1].deletedAt, undefined, '别的不动')
})

test('remove：缺 tid 直接报错，不调用 OneBot', async () => {
  seed([])
  const onebot = mockOnebot([])
  const qzone = qzoneWith(onebot)
  await assert.rejects(() => qzone.remove('  '), /缺少说说 ID/)
  assert.equal(onebot.calls.length, 0)
})

test('syncHistory：完整读到列表时，把空间里没有的记录判为已删除', async () => {
  seed([entry('keep'), entry('gone')])
  const onebot = mockOnebot([{ total: 2, msglist: [{ tid: 'keep' }, { tid: 'other' }] }])
  const qzone = qzoneWith(onebot)

  const result = await qzone.syncHistory()

  assert.equal(result.ok, true)
  assert.equal(result.warning, undefined)
  const saved = readJson(dataDir('diary.json'), () => ({}))
  const byTid = Object.fromEntries(saved.history.map((d) => [d.tid, d]))
  assert.ok(byTid.keep.remoteCheckedAt, '还在的记录写入核对时间')
  assert.equal(byTid.keep.deletedAt, undefined)
  assert.ok(byTid.gone.deletedAt, '空间里没有的记录标记为已删除')
  assert.equal(byTid.gone.deletedSource, 'space-list')
})

test('syncHistory：按 30 一页翻到完整（46 = 30+16），不假设网关按请求页大小给', async () => {
  seed([entry('keep'), entry('gone')])
  const onebot = mockOnebot([
    { total: 46, msglist: Array.from({ length: 30 }, (_, i) => ({ tid: 'a' + i })) },
    { total: 46, msglist: Array.from({ length: 16 }, (_, i) => ({ tid: 'b' + i })) },
  ])
  const qzone = qzoneWith(onebot)

  const result = await qzone.syncHistory()

  assert.equal(result.ok, true)
  assert.equal(result.warning, undefined, '翻到总数后不应再报未完整读取')
  assert.deepEqual(onebot.calls.map((c) => [c.params.pos, c.params.num]), [[0, 30], [30, 30]], '请求页大小 30、按实际返回条数推进')
  const saved = readJson(dataDir('diary.json'), () => ({}))
  const byTid = Object.fromEntries(saved.history.map((d) => [d.tid, d]))
  assert.ok(byTid.gone.deletedAt, '完整读取后，空间里没有的记录判为已删除')
})

test('syncHistory：网关把页截得更短（每页只有 10 条）也能翻全', async () => {
  seed([entry('keep')])
  const pages = [10, 10, 10, 6].map((n, p) => ({ total: 36, msglist: Array.from({ length: n }, (_, i) => ({ tid: 'p' + p + '-' + i })) }))
  const onebot = mockOnebot(pages)
  const qzone = qzoneWith(onebot)

  const result = await qzone.syncHistory()

  assert.equal(result.ok, true)
  assert.equal(result.warning, undefined)
  assert.equal(onebot.calls.length, 4, '按实际返回条数推进 pos，不会因为页短就提前停')
})

test('syncHistory：网关反复返回同一页（没有新 id）时停止，只提示、不改记录', async () => {
  seed([entry('keep'), entry('maybe')])
  // 网关忽略 pos、永远返回同样的 30 条（total 说 250）→ 不能判定缺失
  const same = { total: 250, msglist: Array.from({ length: 30 }, (_, i) => ({ tid: 'a' + i })) }
  const onebot = mockOnebot(Array.from({ length: 10 }, () => same))
  const qzone = qzoneWith(onebot)

  const result = await qzone.syncHistory()

  assert.equal(result.ok, true)
  assert.match(result.warning, /未完整读取/)
  assert.equal(onebot.calls.length, 2, '第二页没有新 id 就停，不会无限翻')
  const saved = readJson(dataDir('diary.json'), () => ({}))
  assert.equal(saved.history[1].deletedAt, undefined, '读不全时绝不标记删除')
})

test('syncHistory：分页期间 total 变化时放弃判定', async () => {
  seed([entry('maybe')])
  const onebot = mockOnebot([
    { total: 150, msglist: Array.from({ length: 30 }, (_, i) => ({ tid: 'a' + i })) },
    { total: 160, msglist: Array.from({ length: 30 }, (_, i) => ({ tid: 'b' + i })) },
  ])
  const qzone = qzoneWith(onebot)

  const result = await qzone.syncHistory()

  assert.equal(result.ok, false)
  assert.match(result.warning, /正在变化/)
  const saved = readJson(dataDir('diary.json'), () => ({}))
  assert.equal(saved.history[0].deletedAt, undefined)
})

test('syncHistory：接口报错时保留记录并给出原因', async () => {
  seed([entry('keep')])
  const onebot = mockOnebot([], { fail: new Error('连接断开') })
  const qzone = qzoneWith(onebot)

  const result = await qzone.syncHistory()

  assert.equal(result.ok, false)
  assert.match(result.warning, /连接断开/)
  assert.match(result.warning, /保留原有记录/)
})

test('syncHistory：没有可对账的记录时直接返回，不发请求', async () => {
  seed([entry('dry', { dryRun: true }), entry('', { ok: false }), entry('del', { deletedAt: 1 })])
  const onebot = mockOnebot([])
  const qzone = qzoneWith(onebot)

  const result = await qzone.syncHistory()

  assert.equal(result.ok, true)
  assert.equal(onebot.calls.length, 0)
})

test('syncHistory：并发调用共用同一次对账', async () => {
  seed([entry('keep')])
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const calls = []
  const onebot = {
    async call(action, params) {
      calls.push(action)
      await gate
      return { total: 1, msglist: [{ tid: 'keep' }] }
    },
  }
  const qzone = qzoneWith(onebot)

  const a = qzone.syncHistory()
  const b = qzone.syncHistory()
  assert.equal(a, b, '第二次调用复用第一次的 Promise')
  release()
  await Promise.all([a, b])
  assert.equal(calls.length, 1)
})
