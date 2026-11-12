// coalesce.mjs 自检 —— 纯断言，不写任何文件
// 跑：node tools/coalesce-selftest.mjs
// ★ 参数化：一组用例一条断言，失败不中断（继续跑完，最后汇总退出码）。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'

import { DEFAULT_RULES, coalesce, eventIdOf, kindOf } from '../src/events/coalesce.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
// COALESCE_SRC 只给变异测试用：指向别处时，[i] 那组结构断言改扫那个文件。
const SRC_PATH = process.env.COALESCE_SRC || join(HERE, '..', 'src', 'events', 'coalesce.mjs')

let pass = 0
const fails = []
function ok (name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name) } catch (e) { fails.push({ name, e }); console.log('  FAIL ' + name + ' → ' + (e && e.message)) }
}

const NL = String.fromCharCode(10)
const SQ = String.fromCharCode(39)

const F = (id, chatId, at) => ({ id, chatId, at })
const P = 'private:u1'
const G = 'group:g1'

// ————————————————————————— a) 三条连发 —————————————————————————
console.log('[a] 三条连发（间隔 1s）')
{
  const frames = [F('f1', P, 0), F('f2', P, 1000), F('f3', P, 2000)]
  const r = coalesce(frames, { now: 999999 })
  ok('1 个事件 / 3 帧', () => {
    assert.equal(r.ok, true)
    assert.equal(r.events.length, 1)
    assert.deepEqual(r.events[0].frameIds, ['f1', 'f2', 'f3'])
  })
  ok('openedAt=0，续窗后 closedAt=2000+8000=10000，windowMs=8000', () => {
    assert.equal(r.events[0].openedAt, 0)
    assert.equal(r.events[0].closedAt, 10000)
    assert.equal(r.events[0].windowMs, 8000)
    assert.equal(r.events[0].rule, 'private')
  })
  ok('open 为空 → null', () => assert.equal(r.open, null))
  ok('id = eventIdOf(frameIds)，形如 ev_ + 16 hex', () => {
    assert.equal(r.events[0].id, eventIdOf(['f1', 'f2', 'f3']))
    assert.match(r.events[0].id, /^ev_[0-9a-f]{16}$/)
  })
  ok('字段集就是约定的 7 个，不多不少', () => {
    assert.deepEqual(Object.keys(r.events[0]).sort(), ['chatId', 'closedAt', 'frameIds', 'id', 'openedAt', 'rule', 'windowMs'])
  })
}

// ————————————————————————— b) 三条间隔 10s —————————————————————————
console.log('[b] 三条间隔 10s（> firstMs 2500，且 > extendMs 8000）')
{
  const frames = [F('f1', P, 0), F('f2', P, 10000), F('f3', P, 20000)]
  const r = coalesce(frames, { now: 1e9 })
  ok('3 个事件，各 1 帧', () => {
    assert.equal(r.events.length, 3)
    assert.deepEqual(r.events.map((e) => e.frameIds), [['f1'], ['f2'], ['f3']])
  })
  ok('每个事件 windowMs=firstMs=2500', () => {
    for (const e of r.events) assert.equal(e.windowMs, 2500)
  })
  ok('closedAt 分别为 at+2500', () => {
    assert.deepEqual(r.events.map((e) => e.closedAt), [2500, 12500, 22500])
  })
}

// ————————————————————————— c) 私聊与群交错 —————————————————————————
console.log('[c] private:u1 与 group:g1 交错')
{
  const frames = [
    F('p1', P, 0), F('g1', G, 100), F('p2', P, 200),
    F('g2', G, 300), F('p3', P, 400), F('g3', G, 500),
  ]
  const r = coalesce(frames, { now: 1e6 })
  ok('2 个事件、各自 3 帧、不串', () => {
    assert.equal(r.events.length, 2)
    const byChat = Object.fromEntries(r.events.map((e) => [e.chatId, e]))
    assert.deepEqual(byChat[P].frameIds, ['p1', 'p2', 'p3'])
    assert.deepEqual(byChat[G].frameIds, ['g1', 'g2', 'g3'])
  })
  ok('rule 各按档位：private / group，closedAt 各自算', () => {
    const byChat = Object.fromEntries(r.events.map((e) => [e.chatId, e]))
    assert.equal(byChat[P].rule, 'private')
    assert.equal(byChat[G].rule, 'group')
    assert.equal(byChat[P].closedAt, 400 + 8000)
    assert.equal(byChat[G].closedAt, 500 + 15000)
  })
  ok('群的 firstMs 确实是 5000：3000ms 后那帧群里并入、私聊同刻另开', () => {
    const frames2 = [F('g1', G, 0), F('p1', P, 0), F('g2', G, 3000), F('p2', P, 3000)]
    const r2 = coalesce(frames2, { now: 1e6 })
    const byChat = Object.fromEntries(r2.events.map((e) => [e.chatId, e]))
    assert.deepEqual(byChat[G].frameIds, ['g1', 'g2'])
    assert.deepEqual(byChat[P].frameIds, ['p2'])
    assert.equal(r2.events.filter((e) => e.chatId === P).length, 2)
  })
  ok('未知前缀落 default 档', () => {
    assert.equal(kindOf('channel:x'), 'default')
    assert.equal(kindOf(''), 'default')
    assert.equal(kindOf(null), 'default')
    assert.equal(kindOf('private:x'), 'private')
    assert.equal(kindOf('group:1'), 'group')
  })
}

// ————————————————————————— d) 窗口边界 ±1ms —————————————————————————
console.log('[d] 边界：首窗恰到期 / 早 1ms / 晚 1ms（private firstMs=2500）')
{
  const at = (t) => coalesce([F('f1', P, 0), F('f2', P, t)], { now: 1e9 })
  ok('t=2500 恰好到期 → 2 个事件（该帧算新事件）', () => {
    const r = at(2500)
    assert.equal(r.events.length, 2)
    assert.deepEqual(r.events.map((e) => e.frameIds), [['f1'], ['f2']])
    assert.equal(r.events[0].closedAt, 2500)
    assert.equal(r.events[1].openedAt, 2500)
  })
  ok('t=2499 早 1ms → 1 个事件，2 帧，续窗从第二帧起算', () => {
    const r = at(2499)
    assert.equal(r.events.length, 1)
    assert.deepEqual(r.events[0].frameIds, ['f1', 'f2'])
    assert.equal(r.events[0].closedAt, 2499 + 8000)
    assert.equal(r.events[0].windowMs, 8000)
  })
  ok('t=2501 晚 1ms → 2 个事件', () => {
    const r = at(2501)
    assert.equal(r.events.length, 2)
    assert.equal(r.events[0].closedAt, 2500)
    assert.equal(r.events[1].openedAt, 2501)
  })
  ok('续窗边界同样左闭右开：deadline=2499+8000=10499 上 → 新事件', () => {
    const mk = (t) => coalesce([F('f1', P, 0), F('f2', P, 2499), F('f3', P, t)], { now: 1e9 })
    assert.equal(mk(10498).events.length, 1)
    assert.equal(mk(10499).events.length, 2)
    assert.equal(mk(10500).events.length, 2)
  })
  ok('now 恰好等于 closedAt → 已关闭（与帧边界同向）', () => {
    const frames = [F('f1', P, 0)]
    assert.equal(coalesce(frames, { now: 2500, closedOnly: true }).events.length, 1)
    assert.equal(coalesce(frames, { now: 2499, closedOnly: true }).events.length, 0)
  })
  ok('同毫秒两帧（非递减）允许，且并入同一事件', () => {
    const r = coalesce([F('f1', P, 0), F('f2', P, 0)], { now: 1e9 })
    assert.equal(r.events.length, 1)
    assert.deepEqual(r.events[0].frameIds, ['f1', 'f2'])
  })
}

// ————————————————————————— e) 确定性 —————————————————————————
console.log('[e] 同一批帧跑两次，输出逐字相同')
{
  const frames = [
    F('p1', P, 0), F('g1', G, 100), F('p2', P, 200), F('p3', P, 300),
    F('g2', G, 400), F('x1', 'channel:x', 500), F('p4', P, 9000),
  ]
  const a = JSON.stringify(coalesce(frames, { now: 20000 }))
  const b = JSON.stringify(coalesce(frames, { now: 20000 }))
  ok('JSON.stringify 相等（含 id）', () => assert.equal(a, b))
  ok('事件 id 确实在输出里', () => assert.ok(a.includes('ev_')))
  ok('改第一次的结果不影响第二次（不共享可变状态）', () => {
    const r1 = coalesce(frames, { now: 20000 })
    r1.events[0].frameIds.push('污染')
    const r2 = coalesce(frames, { now: 20000 })
    assert.notDeepEqual(r1.events[0].frameIds, r2.events[0].frameIds)
    assert.equal(JSON.stringify(r2), a)
  })
  ok('入参不被修改', () => {
    const snapshot = JSON.stringify(frames)
    coalesce(frames, { now: 20000 })
    assert.equal(JSON.stringify(frames), snapshot)
  })
  ok('事件按 openedAt 全局升序（跨 chatId 也排好）', () => {
    const r = coalesce(frames, { now: 20000 })
    const ats = r.events.map((e) => e.openedAt)
    assert.deepEqual(ats, ats.slice().sort((x, y) => x - y))
    assert.deepEqual(ats, [0, 100, 500, 9000])
  })
}

// ————————————————————————— f) 错误 —————————————————————————
console.log('[f] 错误：乱序 / 缺字段 / 坏规则')
{
  ok('乱序 → UNSORTED，并指出第几帧', () => {
    const r = coalesce([F('f1', P, 1000), F('f2', P, 500)], { now: 1e9 })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'UNSORTED')
    assert.equal(r.index, 1)
    assert.equal(r.prevAt, 1000)
    assert.equal(r.at, 500)
  })
  ok('缺 at → BAD_FRAME，index=1、field=at、message 指出「第 1 帧」', () => {
    const r = coalesce([F('f1', P, 0), { id: 'f2', chatId: P }], { now: 1e9 })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'BAD_FRAME')
    assert.equal(r.index, 1)
    assert.equal(r.field, 'at')
    assert.match(r.message, /第 1 帧/)
  })
  ok('缺 chatId → BAD_FRAME index=0 field=chatId', () => {
    const r = coalesce([{ id: 'f1', at: 0 }], { now: 1e9 })
    assert.equal(r.code, 'BAD_FRAME')
    assert.equal(r.index, 0)
    assert.equal(r.field, 'chatId')
  })
  ok('at 是 ISO 字符串 → BAD_FRAME（不偷偷解析）', () => {
    const r = coalesce([F('f1', P, '2026-11-11T00:00:00.000Z')], { now: 1e9 })
    assert.equal(r.code, 'BAD_FRAME')
    assert.equal(r.field, 'at')
  })
  ok('NaN at → BAD_FRAME', () => assert.equal(coalesce([F('f1', P, NaN)], { now: 0 }).code, 'BAD_FRAME'))
  ok('缺 id → BAD_FRAME field=id（没 id 派生不出稳定事件 id）', () => {
    const r = coalesce([{ chatId: P, at: 0 }], { now: 1e9 })
    assert.equal(r.code, 'BAD_FRAME')
    assert.equal(r.field, 'id')
  })
  ok('null 帧 → BAD_FRAME', () => assert.equal(coalesce([null], { now: 0 }).code, 'BAD_FRAME'))
  ok('非数组 → BAD_FRAME index=-1', () => {
    const r = coalesce(null, { now: 0 })
    assert.equal(r.code, 'BAD_FRAME')
    assert.equal(r.index, -1)
  })
  ok('坏规则 → BAD_RULES（不静默回落）', () => {
    const r = coalesce([F('f1', P, 0)], { rules: { group: { extendMs: -1 } } })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'BAD_RULES')
    assert.equal(r.kind, 'group')
    assert.equal(r.field, 'extendMs')
  })
}

// ————————————————————————— g) closedOnly —————————————————————————
console.log('[g] closedOnly：now 落在窗口中间')
{
  const frames = [F('f1', P, 0), F('f2', P, 1000)]
  const mid = coalesce(frames, { now: 5000, closedOnly: true })
  ok('closedOnly=true → events 为空，open 里有它且 closedAt=null', () => {
    assert.equal(mid.events.length, 0)
    assert.equal(mid.open.length, 1)
    assert.equal(mid.open[0].closedAt, null)
    assert.deepEqual(mid.open[0].frameIds, ['f1', 'f2'])
  })
  ok('closedOnly=false → 同一未关闭事件也在 events 里（closedAt=null）', () => {
    const all = coalesce(frames, { now: 5000 })
    assert.equal(all.events.length, 1)
    assert.equal(all.events[0].closedAt, null)
    assert.equal(all.events[0], all.open[0])
  })
  ok('now 过了窗口 → 进 events，open 为 null', () => {
    const r = coalesce(frames, { now: 9000, closedOnly: true })
    assert.equal(r.events.length, 1)
    assert.equal(r.events[0].closedAt, 9000)
    assert.equal(r.open, null)
  })
  ok('两个 chatId 同时开着 → open 是 2 条（数组，不是只留最后一条）', () => {
    const r = coalesce([F('p1', P, 0), F('g1', G, 100)], { now: 200, closedOnly: true })
    assert.equal(r.events.length, 0)
    assert.equal(r.open.length, 2)
    assert.deepEqual(r.open.map((e) => e.chatId), [P, G])
  })
  ok('不传 now → 当作历史重算，全部算已关闭', () => {
    const r = coalesce([F('f1', P, 0), F('f2', P, 10000)])
    assert.equal(r.events.length, 2)
    assert.equal(r.open, null)
    assert.ok(r.events.every((e) => e.closedAt !== null))
  })
}

// ————————————————————————— 空输入 / 常量 / 不变式 —————————————————————————
console.log('[空] 空输入、常量、不变式')
{
  const r = coalesce([], { now: 123 })
  ok('空输入 → { ok:true, events: [], open: null }', () => {
    assert.equal(r.ok, true)
    assert.deepEqual(r.events, [])
    assert.equal(r.open, null)
    assert.deepEqual(Object.keys(r).sort(), ['events', 'ok', 'open'])
  })
  ok('DEFAULT_RULES 数值与口径一字不差', () => {
    assert.deepEqual(DEFAULT_RULES.private, { firstMs: 2500, extendMs: 8000 })
    assert.deepEqual(DEFAULT_RULES.group, { firstMs: 5000, extendMs: 15000 })
  })
  ok('DEFAULT_RULES 被冻结（一次调用改不坏共享常量）', () => {
    assert.equal(Object.isFrozen(DEFAULT_RULES), true)
    assert.equal(Object.isFrozen(DEFAULT_RULES.private), true)
    assert.throws(() => { DEFAULT_RULES.private.firstMs = 1 }, TypeError)
  })
  ok('eventIdOf：空 → null；同批同 id；条数/顺序变则 id 变', () => {
    assert.equal(eventIdOf([]), null)
    assert.equal(eventIdOf(null), null)
    assert.equal(eventIdOf(['a', 'b']), eventIdOf(['a', 'b']))
    assert.notEqual(eventIdOf(['a', 'b']), eventIdOf(['a']))
    assert.notEqual(eventIdOf(['a', 'b']), eventIdOf(['b', 'a']))
  })
  ok('不变式：每个已关闭事件都满足 closedAt === lastAt + windowMs', () => {
    const frames = [
      F('f1', P, 0), F('g1', G, 0), F('f2', P, 1000), F('g2', G, 4000),
      F('f3', P, 20000), F('g3', G, 25000), F('g4', G, 26000),
    ]
    const atOf = { f1: 0, f2: 1000, f3: 20000, g1: 0, g2: 4000, g3: 25000, g4: 26000 }
    const r = coalesce(frames, { now: 1e9 })
    assert.equal(r.events.length, 4)
    for (const e of r.events) {
      const lastAt = atOf[e.frameIds[e.frameIds.length - 1]]
      assert.equal(e.closedAt, lastAt + e.windowMs, JSON.stringify(e))
    }
  })
  ok('规则覆盖生效：extendMs=0 → 续窗立刻到期（同毫秒那帧不再并）', () => {
    const r = coalesce([F('f1', P, 0), F('f2', P, 2499), F('f3', P, 2499)], { now: 1e9, rules: { private: { extendMs: 0 } } })
    assert.equal(r.events.length, 2)
    assert.deepEqual(r.events[0].frameIds, ['f1', 'f2'])
    assert.equal(r.events[0].closedAt, 2499)
    assert.equal(r.events[0].windowMs, 0)
  })
  ok('规则覆盖生效：default.firstMs 改 5000 → 未知前缀 3000ms 间隔也并了', () => {
    const frames = [F('a1', 'channel:x', 0), F('a2', 'channel:x', 3000)]
    assert.equal(coalesce(frames, { now: 1e9 }).events.length, 2)
    const r = coalesce(frames, { now: 1e9, rules: { default: { firstMs: 5000 } } })
    assert.equal(r.events.length, 1)
    assert.equal(r.events[0].rule, 'default')
  })
  ok('未知规则键 → BAD_RULES（不静默无效）', () => {
    const r = coalesce([F('a1', 'channel:x', 0)], { now: 1e9, rules: { channel: { firstMs: 10 } } })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'BAD_RULES')
    assert.equal(r.kind, 'channel')
  })
}

// ————————————————————————— h) 性能 —————————————————————————
console.log('[h] 1000 帧 / 200 个事件')
{
  const frames = []
  let t = 0
  let n = 0
  for (let e = 0; e < 200; e++) {
    const chatId = e % 2 === 0 ? P : G
    for (let k = 0; k < 5; k++) {
      frames.push({ id: 'f' + (n++), chatId, at: t })
      t += 500
    }
    t += 60000
  }
  const t0 = performance.now()
  const r = coalesce(frames, { now: 1e12 })
  const ms = performance.now() - t0
  ok('跑完：1000 帧 → 200 个事件，每个 5 帧', () => {
    assert.equal(frames.length, 1000)
    assert.equal(r.events.length, 200)
    assert.ok(r.events.every((e) => e.frameIds.length === 5))
  })
  ok('实测 ' + ms.toFixed(3) + ' ms（要求 < 200ms）', () => assert.ok(ms < 200, '太慢：' + ms + 'ms'))
  ok('第二次跑结果逐字相同（200 个 id 全部一致）', () => {
    assert.equal(JSON.stringify(coalesce(frames, { now: 1e12 })), JSON.stringify(r))
  })
}

// ————————————————————————— i) 结构断言：源码里没有 IO / 时间 / 日志 —————————————————————————
console.log('[i] 结构断言：coalesce.mjs 不碰 IO / 时间 / 进程 / 日志')
{
  const raw = readFileSync(SRC_PATH, 'utf8')
  const BT = String.fromCharCode(96)
  const BS = String.fromCharCode(92)
  const DQ = String.fromCharCode(34)
  const FWD = String.fromCharCode(47)
  const STAR = String.fromCharCode(42)

  // 只扫**可执行代码**：注释里「不读当前时间」这类说明不该被算成违规。
  // 手写一个去注释/去字符串字面量的剥离器（本文件没有正则字面量，够用）。
  function codeOnly (src) {
    let out = ''
    let i = 0
    let state = 'code'
    while (i < src.length) {
      const c = src[i]
      const n = src[i + 1]
      if (state === 'code') {
        if (c === FWD && n === FWD) { state = 'line'; i += 2; continue }
        if (c === FWD && n === STAR) { state = 'block'; i += 2; continue }
        if (c === SQ) { state = 'sq'; i++; continue }
        if (c === DQ) { state = 'dq'; i++; continue }
        if (c === BT) { state = 'tpl'; i++; continue }
        out += c; i++; continue
      }
      if (state === 'line') { if (c === NL) { state = 'code'; out += NL } i++; continue }
      if (state === 'block') { if (c === STAR && n === FWD) { state = 'code'; i += 2 } else i++; continue }
      if (c === BS) { i += 2; continue }
      if ((state === 'sq' && c === SQ) || (state === 'dq' && c === DQ) || (state === 'tpl' && c === BT)) { state = 'code'; i++; continue }
      i++
    }
    return out
  }

  const code = codeOnly(raw)
  const hasWord = (s, w) => new RegExp('(^|[^A-Za-z0-9_$])' + w + '([^A-Za-z0-9_$]|$)').test(s)
  const banned = [
    ['fs', () => hasWord(code, 'fs')],
    ['Date.now', () => code.includes('Date.now')],
    ['new Date', () => code.includes('new Date')],
    ['process', () => hasWord(code, 'process')],
    ['setTimeout/setInterval', () => hasWord(code, 'setTimeout') || hasWord(code, 'setInterval') || hasWord(code, 'setImmediate')],
    ['console', () => hasWord(code, 'console')],
    ['require(', () => code.includes('require(')],
    ['node:fs', () => code.includes('node:fs')],
    ['node:path', () => code.includes('node:path')],
    ['Math.random', () => code.includes('Math.random')],
    ['await', () => hasWord(code, 'await')],
  ]
  ok('代码区不含任何禁用符号', () => {
    const hits = banned.filter(([, hit]) => hit()).map(([n]) => n)
    assert.deepEqual(hits, [], '命中：' + hits.join(', '))
  })
  ok('剥离后仍有正文（不是剥空导致的假阴性）', () => {
    assert.ok(code.includes('export function coalesce'), '剥离后正文丢失')
    assert.ok(code.length > 2000, '代码区异常短 = ' + code.length)
  })
  ok('只 import 了 node:crypto', () => {
    const imports = raw.split(NL).filter((l) => l.startsWith('import ')).map((l) => l.split(SQ)[1])
    assert.deepEqual(imports, ['node:crypto'])
  })
  ok('导出面只有 DEFAULT_RULES / kindOf / eventIdOf / coalesce', () => {
    const exported = code.split(NL).filter((l) => l.startsWith('export ')).map((l) => l.split(' ')[2])
    assert.deepEqual(exported.sort(), ['DEFAULT_RULES', 'coalesce', 'eventIdOf', 'kindOf'])
  })
}

// ————————————————————————— 汇总 —————————————————————————
console.log('')
if (fails.length === 0) {
  console.log('ALL PASS · ' + pass + ' 条断言')
  process.exitCode = 0
} else {
  console.log('FAILED ' + fails.length + ' / ' + (pass + fails.length))
  for (const f of fails) {
    console.log('--- ' + f.name)
    console.log(f.e && f.e.stack ? f.e.stack.split(NL).slice(0, 5).join(NL) : String(f.e))
  }
  process.exitCode = 1
}
