// respond-selftest —— events/respond.mjs 的断言（全离线，用假 reader/outbox + 假时钟）
//
// ★ 2026-11-13（第 13 代）：`watch` 已改成 async（bridge 版 replyReader 是异步的）。
//   这里每一处调用都补了 await —— 不补的话 turnBefore 那个 await 还没落地就断言，会假失败。
//   ★ 旧同步 reader 仍然工作（await 非 Promise 值是合法的），所以这些断言测的还是同一套行为。
import { createResponder } from '../src/events/respond.mjs'

let pass = 0, fail = 0
const ok = (name, cond, extra) => { if (cond) { pass++; return } fail++; console.log('  ✗ ' + name + (extra ? ' → ' + JSON.stringify(extra).slice(0, 220) : '')) }

// ---------- 假时钟 ----------
function makeClock() {
  let t = 0
  const timers = []
  return {
    now: () => t,
    setTimer: (fn, ms) => { const h = { fn, at: t + ms, dead: false }; timers.push(h); return h },
    clearTimer: (h) => { if (h) h.dead = true },
    advance(ms) {
      const target = t + ms
      for (;;) {
        const live = timers.filter((x) => !x.dead && x.at <= target).sort((a, b) => a.at - b.at)
        if (!live.length) break
        const h = live[0]
        h.dead = true
        t = h.at
        h.fn()
      }
      t = target
    },
    // 把到期定时器跑干净，等 Promise 链落地
    async flush(ms) { this.advance(ms); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); return this },
  }
}

// ---------- 假 reader：可以随时改「现在第几轮」 ----------
function makeReader(initialTurn) {
  const state = { turn: initialTurn, ok: true, text: '默认回复' }
  return {
    state,
    lastReply() {
      if (!state.ok) return { ok: false, code: 'REPLY_NO_SESSION_FILE', error: '没有' }
      return { ok: true, turn: state.turn, text: state.text, chars: state.text.length }
    },
  }
}

// ---------- 假 outbox ----------
function makeOutbox() {
  const sent = []
  return {
    sent,
    // ★ 按**真实** outbox 的段落格式取（{type,data:{text}}）——
    //   这里如果按我自己的假设写，测试就永远绿，而生产里一条都发不出去。
    send(chatId, segs) { sent.push({ chatId, text: segs.map((s) => (s && s.data && s.data.text) || '').join('') }); return { ok: true, messageId: 'm1' } },
  }
}

const mk = (readerTurn, sendFail) => {
  const clock = makeClock()
  const reader = makeReader(readerTurn)
  const outbox = makeOutbox()
  if (sendFail) outbox.send = () => ({ ok: false, code: 'QQ_HTTP', error: 'HTTP 500' })
  const r = createResponder({ replyReader: reader, outbox, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, pollMs: 100, timeoutMs: 1000 })
  return { clock, reader, outbox, r }
}

// ① 正常：投递时 turn=5，之后变 6 → 发
{
  const { clock, reader, outbox, r } = mk(5)
  await r.watch('s1', 'group:1')
  reader.state.turn = 6; reader.state.text = '新的回复'
  await clock.flush(200)
  ok('正常发出去一条', outbox.sent.length === 1, outbox.sent)
  ok('发到对的 chatId', outbox.sent[0] && outbox.sent[0].chatId === 'group:1', outbox.sent[0])
  ok('正文对', outbox.sent[0] && outbox.sent[0].text === '新的回复', outbox.sent[0])
  ok('sent 计数 = 1', r.view().sent === 1, r.view())
  ok('watch 已摘掉', r.view().watching === 0, r.view())
}
// ② turn 没变（还是 5）→ 不发
{
  const { clock, outbox, r } = mk(5)
  await r.watch('s1', 'group:1')
  await clock.flush(300)
  ok('旧 turn 不发', outbox.sent.length === 0, outbox.sent)
}
// ③ 一直读不到（会话文件不存在）→ 不抛、超时记一笔
{
  const { clock, reader, outbox, r } = mk(5)
  reader.state.ok = false
  await r.watch('s1', 'group:1')
  await clock.flush(1200)
  ok('读不到时不发', outbox.sent.length === 0, outbox.sent)
  ok('超时计数 = 1', r.view().timeouts === 1, r.view())
  ok('超时后不再 watch', r.view().watching === 0, r.view())
}
// ④ 发失败 → failed 计数，lastCode 记下来
{
  const { clock, reader, outbox, r } = mk(5, true)
  await r.watch('s1', 'group:1')
  reader.state.turn = 7
  await clock.flush(200)
  ok('失败也摘掉 watch', r.view().watching === 0, r.view())
  ok('failed = 1', r.view().failed === 1, r.view())
  ok('lastCode 是发失败', r.view().lastCode === 'QQ_HTTP', r.view())
}
// ⑤ 一条投递只发一次：turn 继续涨也不再发
{
  const { clock, reader, outbox, r } = mk(5)
  await r.watch('s1', 'group:1')
  reader.state.turn = 6
  await clock.flush(200)
  reader.state.turn = 7; reader.state.text = '又一轮'
  await clock.flush(600)
  ok('只发一次', outbox.sent.length === 1, outbox.sent)
}
// ⑥ 重复 watch 同一 (会话,chat) → 覆盖，不叠加
{
  const { clock, reader, outbox, r } = mk(5)
  await r.watch('s1', 'group:1')
  await r.watch('s1', 'group:1')
  ok('重复登记只留一个', r.view().watching === 1, r.view())
  reader.state.turn = 6
  await clock.flush(200)
  ok('还是只发一次', outbox.sent.length === 1, outbox.sent)
}
// ⑦ 投递前没有完整一轮（turnBefore=0）→ 第一个完整回复就发
{
  const clock = makeClock()
  const reader = { lastReply: () => ({ ok: false, code: 'REPLY_NO_TURN_END' }) }
  const outbox = makeOutbox()
  const r = createResponder({ replyReader: reader, outbox, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, pollMs: 100, timeoutMs: 1000 })
  await r.watch('s1', 'private:9')
  reader.lastReply = () => ({ ok: true, turn: 1, text: '第一次说话' })
  await clock.flush(200)
  ok('无基准时首个完整回复就发', outbox.sent.length === 1 && outbox.sent[0].text === '第一次说话', outbox.sent)
}
// ⑧ 没有 reader / outbox → 明确拒绝，不假装登记
{
  const r = createResponder({})
  const a = await r.watch('s', 'c')
  ok('缺依赖时拒绝', a.ok === false && a.code === 'RESPOND_UNCONFIGURED', a)
}
// ⑨ stop 之后不再发
{
  const { clock, reader, outbox, r } = mk(5)
  await r.watch('s1', 'group:1')
  r.stop()
  reader.state.turn = 6
  await clock.flush(400)
  ok('stop 之后不发', outbox.sent.length === 0, outbox.sent)
  ok('stop 清空 watch', r.view().watching === 0, r.view())
}

console.log((fail === 0 ? 'ALL PASS' : 'FAILED') + ' · ' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
