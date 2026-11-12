// 帧 → 事件 · 接线自检（只碰临时目录；生产 dataDir 零写入）
// ============================================================================
// 跑：node tools/events-coalesce-wire-selftest.mjs
// 断言分组（与父任务给的单子一一对应）：
//   a) 三条连发 → 3 帧 / 1 事件，frameIds 就是那 3 个
//   b) 再追加一条「超过窗口」的帧 → 事件变 2 条（且这一条是**落帧自动触发**的）
//   c) 同一个 event.id 重复 append → 文件里还是 1 行
//   d) 重启恢复：新 store 实例读同一目录 → 事件数不变、不重复写
//   e) 乱序/迟到帧 → 接线层不崩；选定的策略是「拒绝并留痕」（见断言里的说明）
//   f) mode=off → 目录都没建（连 dataDir 都不建）
//   g) 结构对账：events.jsonl 的行 == 用 coalesce 重算的结果，逐条相同
//
// ★ 为什么全程用注入的时钟：coalesce 的「关闭」判据是 now >= deadline。
//   用真实时间跑，测试要么等 8 秒要么靠运气；注入时钟之后这条链变成确定性的。
// ★ 为什么用假 transport 而不是连网关：这条自检验的是「落帧之后有没有推导」，
//   不是 WS。假 transport 让帧从真实入口（ingress-onebot.onEvent）进来，
//   于是走的仍是生产那条路：append → onFlush → derive。
// ============================================================================

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { openStore } from '../src/events/store.mjs'
import { coalesce } from '../src/events/coalesce.mjs'
import { framesFromEnvelopes, createEventDeriver } from '../src/events/derive.mjs'
import { buildEnvelope } from '../src/events/envelope.mjs'
import { createEventsIngress } from '../src/events/index.mjs'

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0)   // 固定基准：整秒，便于 d.time（秒）无损换算
const CHAT = 'private:20002'

let pass = 0
const fails = []
function ok (name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name) } catch (e) { fails.push({ name, e }); console.log('  FAIL ' + name + ' → ' + (e && e.message)) }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'core-event-wire-'))
const evDirOf = (dataDir) => path.join(dataDir, 'events')
const ledgerOf = (dataDir) => path.join(evDirOf(dataDir), 'events.jsonl')
const framesOf = (dataDir) => path.join(evDirOf(dataDir), 'envelopes.jsonl')
const errorsOf = (dataDir) => path.join(evDirOf(dataDir), 'errors.jsonl')

function lineCount (p) {
  try { return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() !== '').length } catch { return 0 }
}
function readJsonl (p) {
  try { return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l)) } catch { return [] }
}

// —— 假 transport：只提供 create()，返回一个能挂回调的 socket ——
function fakeTransport () {
  const socks = []
  return {
    socks,
    create () {
      const s = { onopen: null, onmessage: null, onerror: null, onclose: null, closed: false, close () { this.closed = true } }
      socks.push(s)
      return s
    },
  }
}

const dataDir = path.join(tmpRoot, 'A', 'data')
const tr = fakeTransport()
let clock = T0
const rt = createEventsIngress({
  config: { dataDir, events: { ingress: { mode: 'direct-ws', onebot: { wsUrl: 'ws://127.0.0.1:1', allow: { all: true }, maxReconnect: 1 } } } },
  env: {},
  transport: tr,
  now: () => clock,
  log: () => {},
})

let sock = null
function send (i, atMs) {
  sock.onmessage({
    data: JSON.stringify({
      post_type: 'message',
      message_type: 'private',
      self_id: '10001',
      user_id: '20002',
      message_id: 'm' + i,
      time: Math.floor(atMs / 1000),          // OneBot 的 time 是**秒**；envelope 会自己换算
      message: [{ type: 'text', data: { text: '第' + i + '条' } }],
    }),
  })
}

const started = rt.start()
await new Promise((r) => setImmediate(r))
sock = tr.socks[0]

console.log('[a] 三条连发（同 chatId，间隔 1s）')
ok('接入起来了（mode=direct-ws），且目录已建', () => {
  assert.equal(started.started, true)
  assert.ok(sock, '假 transport 没被 create（connect 没跑到）')
  assert.ok(fs.existsSync(evDirOf(dataDir)))
})
sock.onopen()
{
  clock = T0; send(1, T0)
  clock = T0 + 1000; send(2, T0 + 1000)
  clock = T0 + 2000; send(3, T0 + 2000)
}
ok('落帧 3 次 → envelopes.jsonl 3 行', () => assert.equal(lineCount(framesOf(dataDir)), 3))
ok('★ 每落一帧都跑了一次推导（不是定时器）', () => assert.ok(rt.eventsStats().runs >= 3, 'runs=' + rt.eventsStats().runs))
ok('窗口还没关（deadline=T0+2000+8000）→ 事件账一行都没写，连文件都没有', () => {
  assert.equal(lineCount(ledgerOf(dataDir)), 0)
  assert.equal(fs.existsSync(ledgerOf(dataDir)), false)
})
clock = T0 + 10000                     // now 恰好等于 deadline → coalesce 判「已关闭」
ok('触发一次推导（窗口关闭；生产里这次触发由下一条帧/启动/停止带来）', () => {
  const r = rt.deriveEvents()
  assert.equal(r.ok, true)
  assert.equal(r.written.length, 1)
})
ok('events.jsonl 1 行，且 frameIds 就是那 3 帧（顺序=落帧顺序）', () => {
  const rows = readJsonl(ledgerOf(dataDir))
  assert.equal(rows.length, 1)
  const ids = readJsonl(framesOf(dataDir)).map((e) => e.event_id)
  assert.deepEqual(rows[0].frameIds, ids)
  assert.equal(rows[0].chatId, CHAT)
})
ok('event 行的键与帧不同：有 id/kind，没有 event_id/seq/payload', () => {
  const row = readJsonl(ledgerOf(dataDir))[0]
  assert.equal(row.kind, 'event')
  assert.equal(typeof row.id, 'string')
  for (const k of ['event_id', 'seq', 'payload', 'dedup_key']) assert.equal(k in row, false, '不该出现帧的键 ' + k)
  assert.deepEqual(Object.keys(row).sort(), ['chatId', 'closedAt', 'frameIds', 'id', 'kind', 'openedAt', 'rule', 'windowMs'])
})

console.log('[b] 再追加一条「超过窗口」的帧')
{
  clock = T0 + 60000
  send(4, T0 + 40000)                  // 比上一条晚 38s，远超过 extendMs=8000 → 新事件
}
ok('★ 这一次没有手动触发：落帧后自动多出 1 条（共 2 条）', () => {
  const rows = readJsonl(ledgerOf(dataDir))
  assert.equal(rows.length, 2)
  assert.equal(lineCount(framesOf(dataDir)), 4)
  const second = rows.find((e) => e.openedAt === T0 + 40000)
  assert.ok(second, '没找到第二条事件')
  assert.equal(second.frameIds.length, 1)
  assert.equal(second.closedAt, T0 + 40000 + 2500)
})

console.log('[c] 同一个 event.id 重复 append')
ok('重复 append 2 条已入账事件 → written 0 / duplicate 2，文件仍是 2 行', () => {
  const rows = rt.store.readEvents()
  assert.equal(rows.length, 2)
  const r = rt.store.appendEvents(rows)
  assert.equal(r.written.length, 0)
  assert.equal(r.duplicate.length, 2)
  assert.equal(lineCount(ledgerOf(dataDir)), 2)
})

console.log('[d] 重启恢复')
rt.stop('selftest')
ok('新 store 实例读同一目录：事件数不变', () => {
  const s2 = openStore({ dir: evDirOf(dataDir), env: {}, now: () => clock })
  assert.equal(s2.readEvents().length, 2)
  assert.equal(s2.snapshot().eventsLedger.rows, 2)
})
ok('重启后重跑推导：0 条新写、2 条幂等命中，文件仍是 2 行', () => {
  const s2 = openStore({ dir: evDirOf(dataDir), env: {}, now: () => clock })
  const d2 = createEventDeriver({ store: s2, now: () => clock })
  const r = d2.derive()
  assert.equal(r.ok, true)
  assert.equal(r.written.length, 0)
  assert.equal(r.duplicate, 2)
  assert.equal(lineCount(ledgerOf(dataDir)), 2)
})

console.log('[e] 乱序 / 迟到帧（独立目录，免得污染对账）')
{
  const eData = path.join(tmpRoot, 'E', 'data')
  const eDir = evDirOf(eData)
  let ec = T0 + 20000
  const se = openStore({ dir: eDir, env: {}, now: () => ec })
  const put = (mid, at) => se.append(buildEnvelope({
    source: 'lead-relay', type: 'report', payload: { mid }, chatId: CHAT, userId: '20002',
    messageId: mid, bootId: 'e', raw_ptr: 'test:' + mid, createdAt: at, receivedAt: at,
  }))
  put('e1', T0)
  put('e2', T0 + 1000)
  const de = createEventDeriver({ store: se, now: () => ec })
  ok('先把 e1/e2 推成一个已关闭事件（1 行）', () => {
    const r = de.derive()
    assert.equal(r.written.length, 1)
    assert.equal(lineCount(path.join(eDir, 'events.jsonl')), 1)
  })
  ok('★ 再塞一条「时间落在旧窗口里」的迟到帧 → 推导不抛、账不加行', () => {
    put('e-late', T0 + 500)
    let r = null
    assert.doesNotThrow(() => { r = de.derive() })
    assert.equal(r.ok, true)
    assert.equal(r.written.length, 0)
    assert.equal(r.conflict, 1)
    assert.equal(lineCount(path.join(eDir, 'events.jsonl')), 1)
  })
  ok('★ 冲突留痕：errors.jsonl 里有 EVENT_REVISED（不是静默吞掉）', () => {
    const errs = readJsonl(path.join(eDir, 'errors.jsonl'))
    assert.ok(errs.some((x) => x.code === 'EVENT_REVISED'), 'errors=' + JSON.stringify(errs.map((x) => x.code)))
  })
  ok('★ 重算确实会得出不同的事件 id（证明「跳过」是因为边界变了，不是没事发生）', () => {
    const { frames } = framesFromEnvelopes(se.readAll())
    const r = coalesce(frames, { now: ec, closedOnly: true })
    assert.equal(r.ok, true)
    const writtenIds = new Set(se.readEvents().map((e) => e.id))
    assert.equal(writtenIds.has(r.events[0].id), false)
  })
}

console.log('[f] mode=off')
ok('start() 拒起，且 dataDir / events 目录都没建（读都没读）', () => {
  const offData = path.join(tmpRoot, 'OFF', 'data')
  const rtOff = createEventsIngress({ config: { dataDir: offData }, env: {} })
  const r = rtOff.start()
  assert.equal(r.started, false)
  assert.equal(rtOff.readEvents().length, 0)
  assert.equal(fs.existsSync(offData), false)
  assert.equal(fs.existsSync(evDirOf(offData)), false)
})

console.log('[g] 结构对账：events.jsonl == 用 coalesce 重算')
ok('行数、id、frameIds、时间边界、rule 逐条相同', () => {
  const s = openStore({ dir: evDirOf(dataDir), env: {}, now: () => clock })
  const rows = s.readEvents()
  const { frames } = framesFromEnvelopes(s.readAll())
  const r = coalesce(frames, { now: clock, closedOnly: true })
  assert.equal(r.ok, true)
  assert.equal(rows.length, r.events.length)
  for (let i = 0; i < rows.length; i++) {
    const { kind, ...row } = rows[i]
    assert.equal(kind, 'event')
    assert.deepEqual(row, r.events[i], '第 ' + i + ' 条对不上')
  }
})
ok('readEvents({since}) 按 openedAt 过滤；ISO 也收；解析不出来就抛', () => {
  const s = openStore({ dir: evDirOf(dataDir), env: {}, now: () => clock })
  assert.equal(s.readEvents({ since: T0 + 30000 }).length, 1)
  assert.equal(s.readEvents({ since: new Date(T0 + 30000).toISOString() }).length, 1)
  assert.equal(s.readEvents().length, 2)
  assert.throws(() => s.readEvents({ since: '不是时间' }), TypeError)
})

// ————————————————————————— 汇总 —————————————————————————
try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* Windows 上偶尔有句柄没放，留一个临时目录不致命 */ }

console.log('')
if (fails.length === 0) {
  console.log('ALL PASS · ' + pass + ' 条断言')
  process.exitCode = 0
} else {
  console.log('FAILED ' + fails.length + ' / ' + (pass + fails.length))
  for (const f of fails) {
    console.log('--- ' + f.name)
    console.log(f.e && f.e.stack ? f.e.stack.split('\n').slice(0, 6).join('\n') : String(f.e))
  }
  process.exitCode = 1
}
