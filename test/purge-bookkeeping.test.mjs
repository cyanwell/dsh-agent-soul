// 单测：purge 记账（「清过的别再列出来」那一半）
//
// ★ 为什么要有它（2026-11-16 · 架构收敛第 3 批）：
//   两处真 bug 一起修：
//     ① dispatch.purge 回执里 purged[] 的键是 **start**，而记账读的是 **seq**
//        → 一条都记不上，candidates 会把已经清过的 seq 反复列出来；
//     ② 自动巡视/手动干预走的 index.mjs purge 分支**根本没有记账**，
//        只有 /api/huanqi/context/purge 那个 HTTP 入口记。
//
// ★ 不碰任何真实文件：setPurgedFile(null) 之后写入是 no-op，纯内存。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setPurgedFile, markPurgedFromReceipt } from '../src/adapters/context-http.mjs'

const out = []
let failed = 0
const check = (label, ok, extra) => {
  out.push((ok ? '  ✓ ' : '  ✗ ') + label + (extra === undefined ? '' : '   [' + extra + ']'))
  if (!ok) failed += 1
}

// 隔离：先断掉落盘，确认纯内存路径不会抛
setPurgedFile(null)

// 1) 宿主回执的真实形状：{ purged: [{ start, end, newSeq }], failed: [] }
{
  const r = markPurgedFromReceipt('sess-A', { ok: true, purged: [{ start: 19208, end: 19208, newSeq: 19264 }], failed: [] })
  check('回执只有 start 时也记得上', r.marked.length === 1 && r.marked[0] === 19208, JSON.stringify(r))
  check('没有跳过项', r.skipped === 0, 'skipped=' + r.skipped)
}
// 2) 兼容旧形状（seq）
{
  const r = markPurgedFromReceipt('sess-B', { ok: true, purged: [{ seq: 42 }] })
  check('回执用 seq 时也认', r.marked.length === 1 && r.marked[0] === 42, JSON.stringify(r))
}
// 3) start 与 seq 同时存在 → 取 start（真回执的字段优先）
{
  const r = markPurgedFromReceipt('sess-C', { ok: true, purged: [{ start: 7, seq: 999 }] })
  check('两个键都在时取 start', r.marked.length === 1 && r.marked[0] === 7, JSON.stringify(r.marked))
}
// 4) 没有可用 seq → 跳过并计数，**不猜**
{
  const r = markPurgedFromReceipt('sess-D', { ok: true, purged: [{}, { start: 'abc' }, { start: null }] })
  check('没有可用 seq 时一条都不记', r.marked.length === 0, JSON.stringify(r.marked))
  check('跳过条数如实报出来', r.skipped === 3, 'skipped=' + r.skipped)
}
// 5) 回执形状不对 → 不抛（记账失败不许把清理本身带下去）
{
  let threw = null
  let r = null
  try {
    r = markPurgedFromReceipt('sess-E', { ok: true })
    r = markPurgedFromReceipt('sess-E', null)
    r = markPurgedFromReceipt('sess-E', { ok: true, purged: 'not-array' })
  } catch (e) { threw = e }
  check('回执缺 purged / 为 null / 不是数组都不抛', threw === null, threw && threw.message)
  check('这种情况下记 0 条', r && r.marked.length === 0 && r.skipped === 0, JSON.stringify(r))
}
// 6) 数字字符串也算数（宿主可能把 seq 序列化成字符串）
{
  const r = markPurgedFromReceipt('sess-F', { ok: true, purged: [{ start: '123' }] })
  check('数字字符串被归一成数', r.marked.length === 1 && r.marked[0] === 123, JSON.stringify(r.marked))
}
// 7) 落盘这条腿：写到临时文件再读回来（只用 os.tmpdir()，测完删除）
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-purged-'))
  const file = path.join(dir, 'huanqi-purged.json')
  try {
    setPurgedFile(file)
    markPurgedFromReceipt('sess-G', { ok: true, purged: [{ start: 5 }, { start: 6 }] })
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    check('写盘后的键是会话 id', Array.isArray(saved['sess-G']), JSON.stringify(saved))
    check('写盘后的内容是 start 值', JSON.stringify(saved['sess-G']) === '[5,6]', JSON.stringify(saved['sess-G']))
  } finally {
    setPurgedFile(null)
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响判定 */ }
  }
  check('临时目录已清理', !fs.existsSync(dir))
}

console.log(out.join('\n'))
console.log(failed === 0 ? '\n★ 全部通过' : '\n★ 失败 ' + failed + ' 项')
process.exit(failed === 0 ? 0 : 1)
