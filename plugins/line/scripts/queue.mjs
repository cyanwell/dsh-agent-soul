// queue.mjs —— 丹房任务队列 · 内核
//
// ★ 为什么必须有这个东西（2026-10-06 爀曦拍板）：
//   视频线一条 13.70 分钟。人不可能盯着。队列如果活在浏览器里，
//   一刷新就全没了、正在跑的也回不来 —— 那比没有队列更糟。
//   ⇒ 这份账是【服务端权威】，界面只是看客。
//
// ★★ 为什么是【只追加】的 JSONL：
//   和《墨》同一个道理 —— 多写者环境里共享可变文件是万恶之源。
//   每次状态变化只追加一行；读的时候按 id 归并、最后一行说了算。
//   这样：① 不用锁 ② 崩在中间也不丢历史 ③ 出问题能看出它是什么时候变的
//
// ★★★ 账本放哪：<插件目录>/data/queue.jsonl
//   ★ 故意不放 WanGP 的 install-logs（那是别人的地盘）
//   ★ 也故意不放源目录 —— deploy 只复制 index.js/client.js/package.json/
//     cordis.patch.yml/scripts/*.mjs，【不碰 data/】，所以队列账本能跨部署活下来。
//
// 用法（宿主半）：
//   import { createQueue } from './scripts/queue.mjs'
//   const q = createQueue({ run: async (job) => { ...跑完了 return {outputs, seconds} } })
//   q.start()                     // 开始串行消费
//   q.add('anchor', {...})        // 排一个

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(HERE, '..', 'data')
const LEDGER = join(DATA_DIR, 'queue.jsonl')

// 状态机：pending → running → done | error ；pending → cancelled
const OPEN = new Set(['pending', 'running'])

function nowIso() {
  // 本地时间的 ISO（带时区偏移），和《墨》一个口径 —— 看账的人不换算
  const d = new Date()
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const pad = (n) => String(Math.abs(n)).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) +
    sign + pad(Math.floor(Math.abs(off) / 60)) + ':' + pad(Math.abs(off) % 60)
}

function ensureDir(p) {
  try {
    const d = dirname(p || LEDGER)
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
  } catch (e) { /* 下面 append 会再报 */ }
}

// ── 归并：把只追加的行折成「每个 id 一条现状」──────────────────
//   ★ params / kind / 创建时间取【第一行】；status / outputs / 结束时间取【最后一行】。
//   ★ ledgerPath 可覆盖 —— 离线测试要用临时账本，不能拿真账本试。
export function readLedger(ledgerPath) {
  const p = ledgerPath || LEDGER
  let raw = ''
  try { raw = existsSync(p) ? readFileSync(p, 'utf8') : '' } catch (e) { return [] }
  const byId = new Map()
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    let row
    try { row = JSON.parse(s) } catch (e) { continue }   // 半行/坏行直接跳过，不让它毒死整本账
    if (!row || !row.id) continue
    const cur = byId.get(row.id)
    if (!cur) {
      byId.set(row.id, Object.assign({}, row))
    } else {
      // 第一行的身份字段留着，其余被后面的盖掉
      byId.set(row.id, Object.assign({}, cur, row, {
        kind: cur.kind || row.kind,
        params: cur.params || row.params,
        createdAt: cur.createdAt || row.createdAt,
        seq: (cur.seq || 0) + 1,
      }))
    }
  }
  return Array.from(byId.values()).sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
}

// ★ 2026-10-08：跑完要「喊一声」，但发微信要 ClawBot 的凭据 —— 硬线不碰。
//   ⇒ 用【分离】：这里只把「该通知了」写成一条请求，谁有权限谁去发。
//   ★ 判据：队列内核不认识微信，只认识「通知请求」这件事。换通道不用改这里。
export function queueNotifyFile(ledgerPath) {
  // 通知请求写在【账本旁边】—— 同一个 data/ 目录，同样跨 deploy 活下来
  const p = ledgerPath || LEDGER
  return p.replace(/queue\.jsonl$/, 'notify.jsonl')
}

export function createQueue(opts) {
  const runFn = (opts && opts.run) || null
  const notify = (opts && opts.onChange) || (() => {})
  const ledger = (opts && opts.ledger) || LEDGER
  let runningId = null
  let stopping = false

  function append(row) {
    ensureDir(ledger)
    try {
      appendFileSync(ledger, JSON.stringify(row) + '\n', 'utf8')
    } catch (e) {
      // 账本写不进去是致命的 —— 但不要静默：把它喊出来
      console.error('[queue] 账本写失败：' + String((e && e.message) || e))
    }
    try { notify(row) } catch (e) { /* 通知回调不许把队列搞挂 */ }
  }

  // ★ 通知请求也是【只追加】—— 和账本同一个理由：不用锁、崩了不丢。
  //   ★ 外部读法：按时间顺序读，最后一条之后的新请求就是「还没喊过的」。
  function notifyOut(rec) {
    try {
      const f = queueNotifyFile(ledger)
      ensureDir(f)
      appendFileSync(f, JSON.stringify(Object.assign({ t: nowIso() }, rec)) + '\n', 'utf8')
    } catch (e) { /* 通知失败不影响队列本身 —— 这是纪律 */ }
  }

  function add(kind, params, note) {
    const id = 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    append({
      t: nowIso(), id, kind, params: params || {}, note: note || '',
      status: 'pending', createdAt: nowIso(), outputs: [],
    })
    return id
  }

  function byId(id) {
    return readLedger(ledger).find((x) => x.id === id) || null
  }

  function list(limit) {
    const all = readLedger(ledger)
    return limit ? all.slice(-limit) : all
  }

  function counts() {
    const all = readLedger(ledger)
    return {
      pending: all.filter((x) => x.status === 'pending').length,
      running: all.filter((x) => x.status === 'running').length,
      done: all.filter((x) => x.status === 'done').length,
      error: all.filter((x) => x.status === 'error').length,
      cancelled: all.filter((x) => x.status === 'cancelled').length,
      total: all.length,
    }
  }

  function nextPending() {
    return readLedger(ledger).find((x) => x.status === 'pending') || null
  }

  function cancel(id) {
    const j = byId(id)
    if (!j) return { ok: false, message: '没有这个任务' }
    if (!OPEN.has(j.status)) return { ok: false, message: '它已经结束了（' + j.status + '）' }
    if (j.status === 'running') {
      // 正在跑的：交给外面 kill 子进程，再由 worker 收尾；这里只打标记
      append({ t: nowIso(), id, status: 'cancelling' })
      if (typeof opts.onCancelRunning === 'function') {
        try { opts.onCancelRunning(j) } catch (e) { /* 杀不掉就让 worker 自己发现 */ }
      }
      return { ok: true, message: '正在停' }
    }
    append({ t: nowIso(), id, status: 'cancelled', endedAt: nowIso() })
    return { ok: true, message: '已取消' }
  }

  function retry(id) {
    const j = byId(id)
    if (!j) return { ok: false, message: '没有这个任务' }
    if (OPEN.has(j.status)) return { ok: false, message: '它还在队列里' }
    append({ t: nowIso(), id, status: 'pending', retriedAt: nowIso(), outputs: [] })
    return { ok: true }
  }

  // ── 串行消费：一次只跑一个 ────────────────────────────────
  //   ★ 这不是偷懒，是纪律：这些活都连同一个 ComfyUI / 同一块 GPU，
  //     并发只会互相打架（爀曦 2026-09-29 定的「一次只推一个 GPU 重活」）。
  async function tick() {
    if (runningId || stopping) return
    const job = nextPending()
    if (!job) return
    if (!runFn) return
    runningId = job.id
    append({ t: nowIso(), id: job.id, status: 'running', startedAt: nowIso() })
    try {
      const r = await runFn(job)
      const cur = byId(job.id)
      if (cur && cur.status === 'cancelling') {
        append({ t: nowIso(), id: job.id, status: 'cancelled', endedAt: nowIso() })
      } else if (r && r.ok === false) {
        append({ t: nowIso(), id: job.id, status: 'error', endedAt: nowIso(),
                 error: String(r.message || '失败'), seconds: r.seconds })
      } else {
        append({ t: nowIso(), id: job.id, status: 'done', endedAt: nowIso(),
                 outputs: (r && r.outputs) || [], seconds: (r && r.seconds) })
        // ★ 跑完一条 → 写一条通知请求（谁去喊人由外部决定，这里只记账）
        notifyOut({ id: job.id, kind: job.kind, ok: true,
                    outputs: (r && r.outputs) || [], seconds: (r && r.seconds),
                    prompt: (job.params && job.params.prompt) || '' })
      }
    } catch (e) {
      append({ t: nowIso(), id: job.id, status: 'error', endedAt: nowIso(),
               error: String((e && e.message) || e) })
    } finally {
      runningId = null
      // 跑完一个立刻看下一个 —— 不用定时器等
      setTimeout(() => { tick().catch(() => {}) }, 50)
    }
  }

  let timer = null
  function start(intervalMs) {
    stopping = false
    if (timer) clearInterval(timer)
    // 双保险：正常路径靠 finally 里递归调，这个定时器兜住「进程重启后有待跑任务」
    timer = setInterval(() => { tick().catch(() => {}) }, intervalMs || 4000)
    if (timer.unref) timer.unref()
    tick().catch(() => {})
    return { ok: true, ledger: LEDGER }
  }
  function stop() {
    stopping = true
    if (timer) clearInterval(timer)
    timer = null
  }

  return { add, list, byId, counts, cancel, retry, nextPending, start, stop, ledgerPath: LEDGER,
           notifyPath: queueNotifyFile(ledger),
           isRunning: () => runningId }
}

export const QUEUE_LEDGER = LEDGER
