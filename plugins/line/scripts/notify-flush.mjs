// notify-flush.mjs —— 把「跑完的通知请求」变成可以直接喊人的一句话
// ────────────────────────────────────────────────────────────
// ★ 为什么是独立脚本、不写进插件：
//   发微信要过 ClawBot 的凭据，而【凭据是硬线】—— 队列内核不该碰、我也不能读。
//   所以这里只做【文件侧】：读出「还没喊过的」通知，整理成一句人话。
//   真正调 notify_wechat / 走微信的那一下，由【有权限的一方】做
//   （砚青的会话，或任务看板里的定时任务）。
//
// 用法：
//   node notify-flush.mjs            # 只列还没喊过的（不标记）
//   node notify-flush.mjs --mark     # 列出来，并标记为「已喊」（追加一条 ack）
//   node notify-flush.mjs --json     # 机器可读
//
// ★ 判据：通知请求和账本一样是【只追加】的。ack 也是一条追加行，
//   所以「已喊过没有」不靠改文件，靠「请求集合 − ack 集合」。
import { readFileSync, appendFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(HERE, '..', 'data')
const NOTIFY = join(DATA, 'notify.jsonl')
const ACK = join(DATA, 'notify.ack.jsonl')

function readLines(p) {
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    try { return JSON.parse(l) } catch (e) { return null }
  }).filter(Boolean)
}

const reqs = readLines(NOTIFY)
const acks = readLines(ACK)
const ackedIds = new Set(acks.map((a) => a.id))
const fresh = reqs.filter((r) => !ackedIds.has(r.id))

if (fresh.length === 0) {
  console.log('没有还没喊过的通知。')
  process.exit(0)
}

// 一句话人话：几条跑完、共出多少张、有没有失败
const done = fresh.filter((r) => r.ok)
const bad = fresh.filter((r) => !r.ok)
const imgs = done.reduce((n, r) => n + ((r.outputs && r.outputs.length) || 0), 0)
const secs = done.reduce((n, r) => n + (r.seconds || 0), 0)

const lines = []
lines.push(`丹房跑完了 ${fresh.length} 条`)
if (done.length) lines.push(`· 成 ${done.length} 条，共出 ${imgs} 张，用了 ${(secs / 60).toFixed(1)} 分钟`)
if (bad.length) lines.push(`· ✗ 失败 ${bad.length} 条`)
for (const r of fresh.slice(0, 6)) {
  const p = String(r.prompt || '').slice(0, 30)
  lines.push(`  ${r.ok ? '✓' : '✗'}${r.kind || ''} ${p}${p.length >= 30 ? '…' : ''}` +
             (r.outputs && r.outputs.length ? `（${r.outputs.length} 张）` : ''))
}
if (fresh.length > 6) lines.push(`  …还有 ${fresh.length - 6} 条`)
lines.push(`账本：${NOTIFY}`)

const text = lines.join('\n')

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ count: fresh.length, done: done.length, failed: bad.length,
                               images: imgs, seconds: secs, text, items: fresh }, null, 2))
} else {
  console.log(text)
}

if (process.argv.includes('--mark')) {
  const t = new Date().toISOString()
  for (const r of fresh) {
    appendFileSync(ACK, JSON.stringify({ t, id: r.id, ack: 'notified' }) + '\n', 'utf8')
  }
  console.log(`\n★ 已标记 ${fresh.length} 条为「已喊」（写进 ${ACK}）`)
  console.log('★ 下一步：由有权限的一方把上面那句发出去（notify_wechat / 微信）。')
}
