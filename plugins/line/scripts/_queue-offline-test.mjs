// 队列离线验证 —— 用临时账本，不碰真服务、不调 ComfyUI
// 验的是：入队 → 串行消费 → 状态落账 → 取消/重试 → 崩溃后能否恢复
import { readLedger, createQueue } from './queue.mjs'   // ★ ESM 不吃 Windows 绝对路径，用相对
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'dq-test-'))
const ledger = join(dir, 'queue.jsonl')
const log = []
const ok = (b, m) => { log.push((b ? '  ✓ ' : '  ✗ ') + m); return b }

let ran = []
const q = createQueue({
  ledger,
  run: async (job) => {
    ran.push(job.id)
    await new Promise((r) => setTimeout(r, 80))
    return { ok: true, outputs: ['a.png', 'b.png'], seconds: 0.08 }
  },
})

// ① 空账本
let all = readLedger(ledger)
ok(Array.isArray(all) && all.length === 0, `空账本可读（0 条）`)

// ② 入队三个
const ids = [q.add('anchor', { prompt: 'p1' }), q.add('anchor', { prompt: 'p2' }), q.add('anchor', { prompt: 'p3' })]   // ★ add() 直接返回 id
ok(ids.every(Boolean), `入队 3 个，id 都不空：${ids.join(', ')}`)

// ③ 账本是【只追加】的 JSONL（此刻应是 3 行 pending）
let raw = readFileSync(ledger, 'utf8').trim().split('\n')
ok(raw.length === 3, `入队后账本 3 行（只追加）`)

// ④ 串行消费 —— start() 后三个依次跑完
q.start(30)
await new Promise((r) => setTimeout(r, 900))
const jobs = q.list(50)
const done = jobs.filter((j) => j.status === 'done')
ok(done.length === 3, `3 个都跑完（done=${done.length}）`)
ok(ran.length === 3, `run 被调用 3 次（串行，不是并发）`)
ok(done.every((j) => (j.outputs || []).length === 2), `每个 job 的 outputs 都已落账（2 张图）`)

// ⑤ 只追加：跑完后行数应 > 3（每次状态变化追加一行）
raw = readFileSync(ledger, 'utf8').trim().split('\n')
ok(raw.length >= 9, `账本追加到 ${raw.length} 行（3 入队 + 3 running + 3 done）`)

// ⑥ counts
const c = q.counts()
ok(c.done === 3, `counts.done = ${c.done}`)

// ⑦ 取消一个 pending
const id4 = q.add('anchor', { prompt: 'p4' })
const cr = q.cancel(id4)
ok(cr.ok === true, `cancel 返回 ok：${cr.message}`)

// ⑧ 重试一个已完成的
const rr = q.retry(ids[0])
ok(rr.ok === true, `retry 一个 done 的返回 ok`)

// ⑧b ★ 通知请求：跑完的每条都应留下一条（这是「喊人」的对接点）
const notifyPath = q.notifyPath
let nRaw = []
try { nRaw = readFileSync(notifyPath, 'utf8').trim().split('\n').filter(Boolean) } catch (e) { nRaw = [] }
const nOk = ok(nRaw.length === 3, `通知请求写了 3 条（喊人的对接点）：${notifyPath}`)
if (nOk) {
  const first = JSON.parse(nRaw[0])
  ok(first.ok === true && Array.isArray(first.outputs) && first.outputs.length === 2,
     `通知里带 outputs（${first.outputs ? first.outputs.length : 0} 张）与 ok 标志`)
  ok(typeof first.t === 'string' && first.t.length > 10, `通知带时间戳 t=${first.t}`)
}
// ⑨ 崩溃恢复：新建一个队列读同一个账本，应看得见历史
q.stop()
const q2 = createQueue({ ledger, run: async () => ({ ok: true, outputs: [] }) })
const seen = q2.list(50)
ok(seen.length === 4, `重开队列仍读到 4 个 job（崩溃不丢历史）`)

console.log(log.join('\n'))
console.log(`\n账本路径（临时）: ${ledger}`)
console.log(`最终账本行数: ${readFileSync(ledger, 'utf8').trim().split('\n').length}`)
const bad = log.filter((l) => l.includes('✗')).length
console.log(bad === 0 ? '\n★ 全部通过' : `\n★ 有 ${bad} 项失败`)
rmSync(dir, { recursive: true, force: true })
process.exit(bad === 0 ? 0 : 1)
