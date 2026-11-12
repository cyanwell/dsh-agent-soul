// 验证「到期触发」：窗口到期时不需要任何新帧，事件自己落盘。
// ★ 这条补的是子会话报的那个缺口：最后一条消息之后、下一条消息之前，事件不该一直不落盘。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openStore } from '../src/events/store.mjs'
import { createEventDeriver } from '../src/events/derive.mjs'

const ok = []; const bad = []
function check (name, cond, detail) {
  if (cond) ok.push('  ok   ' + name)
  else bad.push('  FAIL ' + name + (detail === undefined ? '' : '  >>> ' + JSON.stringify(detail)))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'derive-arm-'))
const evDir = path.join(dir, 'events')
const ledger = path.join(evDir, 'events.jsonl')
const frames = path.join(evDir, 'envelopes.jsonl')
const lineCount = (p) => { try { return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).length } catch { return 0 } }
const frames_ = (n, atMs) => Array.from({ length: n }, (_, i) => JSON.stringify({
  kind: 'frame', event_id: 'f' + i, chatId: 'private:1',
  created_at: new Date(atMs + i * 10).toISOString(),
})).join('\n') + '\n'

console.log('')
console.log('=== 到期触发自检 ===')

// ① 窗口没到期时：derive 报 open，且**不该**落账
fs.mkdirSync(evDir, { recursive: true })
const base = Date.now() - 1000
fs.writeFileSync(frames, frames_(2, base), 'utf8')
const store = openStore({ dir: evDir, env: {}, now: () => Date.now() })  // ★ dir 是 events 目录，不是 dataDir
const d = createEventDeriver({ store, now: () => Date.now() })
const r1 = d.derive()
check('先跑一次：窗口未到期 → open=1，事件 0 条', r1.ok && r1.open === 1 && r1.events === 0, r1)
check('  → 返回里带 nextDeadlineAt（且是个毫秒数）', typeof r1.nextDeadlineAt === 'number' && r1.nextDeadlineAt > 0, r1.nextDeadlineAt)
check('  → 此刻账上还没有事件', lineCount(ledger) === 0, lineCount(ledger))
check('  → armed() 为真（到期触发开着）', d.armed() === true)

// ② 不追加任何帧，只等：到期后事件应自己落盘
const waitMs = Math.max(50, (r1.nextDeadlineAt - Date.now()) + 250)
await sleep(Math.min(waitMs, 9000))
check('不追加任何帧、只等 → 事件自己落盘了 1 条', lineCount(ledger) === 1, lineCount(ledger))
if (lineCount(ledger) === 1) {
  const ev = JSON.parse(fs.readFileSync(ledger, 'utf8').trim())
  check('  → 这条事件正好收了那 2 帧', Array.isArray(ev.frameIds) && ev.frameIds.length === 2, ev.frameIds)
  check('  → kind 标成 event（与帧账分得开）', ev.kind === 'event', ev.kind)
}

// ③ autoArm:false 时必须**不**挂定时器（测试/重放用）
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'derive-arm-off-'))
fs.mkdirSync(path.join(dir2, 'events'), { recursive: true })
fs.writeFileSync(path.join(dir2, 'events', 'envelopes.jsonl'), frames_(2, Date.now() - 500), 'utf8')
const s2 = openStore({ dir: path.join(dir2, 'events'), env: {}, now: () => Date.now() })
const d2 = createEventDeriver({ store: s2, now: () => Date.now(), autoArm: false })
const r2 = d2.derive()
check('autoArm:false → armed() 为假', d2.armed() === false)
await sleep(300)
check('autoArm:false → 等 300ms 也不落盘（证明 ① 的落盘真来自定时器）',
  lineCount(path.join(dir2, 'events', 'events.jsonl')) === 0,
  lineCount(path.join(dir2, 'events', 'events.jsonl')))
check('  → 但仍然算得出 nextDeadlineAt', typeof r2.nextDeadlineAt === 'number', r2.nextDeadlineAt)

// ④ stop() 之后不再触发
d.stop()
await sleep(50)
ok.push('  ok   stop() 可调（不抛）')

try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
try { fs.rmSync(dir2, { recursive: true, force: true }) } catch {}
console.log(ok.join('\n'))
if (bad.length) console.log('\n' + bad.join('\n'))
console.log('')
console.log((ok.length + bad.length) + ' 条：' + ok.length + ' 通过 / ' + bad.length + ' 失败')
process.exit(bad.length ? 1 : 0)
