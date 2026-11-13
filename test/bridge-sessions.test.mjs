// 单测：bridge-sessions —— 通过 bridge 读会话，失败必须外显
import { listSessionsViaBridge, readSessionViaBridge, readAllSessionViaBridge } from '../src/adapters/bridge-sessions.mjs'

const out = []
let failed = 0
const check = (label, ok, extra) => {
  out.push((ok ? '  ✓ ' : '  ✗ ') + label + (extra === undefined ? '' : '   [' + extra + ']'))
  if (!ok) failed += 1
}

const fakeControl = (opts = {}) => ({
  whoHas: (cap) => (opts.noHost ? [] : [{ id: 'host-1', host: 'dsh', caps: new Set(['sessions']), conn: { open: true } }]),
  exec: async (hostId, cap, action, args) => {
    if (opts.execThrows) throw new Error('宿主不在: ' + hostId)
    if (opts.badShape) return { ok: true }
    if (action === 'list') return { ok: true, root: '/x', total: 2, items: [{ id: 'a', workspace: 'w' }, { id: 'b', workspace: 'w' }] }
    if (action === 'read') {
      const from = Number(args.fromSeq || 0)
      const all = [{ seq: 1 }, { seq: 2 }, { seq: 3 }]
      const page = all.slice(from, from + (args.limit || 400))
      const next = from + page.length < all.length ? from + page.length : null
      return { ok: true, sessionId: args.sessionId, frames: page, count: page.length, total: all.length, nextFromSeq: next, badLines: 0 }
    }
    return { ok: false, error: 'unknown action' }
  },
})

{
  const r = await listSessionsViaBridge(fakeControl())
  check('list 返回 items', Array.isArray(r.items) && r.items.length === 2)
}
{
  let err = null
  try { await listSessionsViaBridge(fakeControl({ noHost: true })) } catch (e) { err = e }
  check('没有宿主时抛错（不是回空表）', err !== null && /没有任何宿主声明/.test(err.message), err && err.message.slice(0, 60))
}
{
  let err = null
  try { await listSessionsViaBridge(fakeControl({ execThrows: true })) } catch (e) { err = e }
  check('exec 失败会抛', err !== null && /sessions.list 失败/.test(err.message), err && err.message.slice(0, 60))
}
{
  let err = null
  try { await listSessionsViaBridge(fakeControl({ badShape: true })) } catch (e) { err = e }
  check('回执缺 items 时抛错', err !== null && /缺 items/.test(err.message), err && err.message.slice(0, 60))
}
{
  const r = await readAllSessionViaBridge(fakeControl(), 'sess-1', { pageSize: 1 })
  check('自动翻页读全 3 帧', r.frames.length === 3, 'got=' + r.frames.length)
  check('帧顺序正确', r.frames.map((f) => f.seq).join(',') === '1,2,3')
}
{
  let err = null
  try { await readAllSessionViaBridge(fakeControl(), 'sess-1', { pageSize: 1, maxFrames: 2 }) } catch (e) { err = e }
  check('超过 maxFrames 时抛错（不截断）', err !== null && /超过上限/.test(err.message), err && err.message.slice(0, 60))
}
{
  let err = null
  try { await listSessionsViaBridge(null) } catch (e) { err = e }
  check('control 缺失时抛错', err !== null && /控制通道/.test(err.message), err && err.message.slice(0, 60))
}

console.log(out.join('\n'))
console.log(failed === 0 ? '\n★ 全部通过' : '\n★ 失败 ' + failed + ' 项')
process.exit(failed === 0 ? 0 : 1)
