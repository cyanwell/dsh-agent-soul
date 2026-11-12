// wake.mjs 自检 —— 事件 → 投递请求 的翻译层
// 判据：喂假帧、验拼出来的正文和拒绝码。不需要网关、不需要 DSH、不需要磁盘。

import { createEventWaker, composeWake, lineOfFrame, textOfMessage } from '../src/events/wake.mjs'

let pass = 0
let fail = 0
const bad = []
function ok (name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail === undefined ? '' : '  ' + detail)) }
  else { fail++; bad.push(name); console.log('  ✗ ' + name + (detail === undefined ? '' : '  ' + detail)) }
}
function eq (name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got)) }

// ---------- 造帧 ----------
const mkEnv = (id, chatId, at, payload) => ({
  event_id: id, source: 'onebot', type: 'message', chatId,
  created_at: new Date(at).toISOString(), payload,
})
const msg = (nick, text, extra) => ({
  post_type: 'message', message_type: 'group', group_id: 661580035,
  user_id: 1001, sender: { nickname: nick }, message: [{ type: 'text', data: { text } }],
  ...(extra || {}),
})

console.log('=== 一、textOfMessage ===')
eq('纯字符串原样返回', textOfMessage('你好'), '你好')
eq('单段文本', textOfMessage([{ type: 'text', data: { text: 'abc' } }]), 'abc')
eq('多段拼接', textOfMessage([
  { type: 'text', data: { text: '看这个 ' } },
  { type: 'image', data: { file: 'x.jpg' } },
]), '看这个 [图片]')
eq('at 段', textOfMessage([{ type: 'at', data: { qq: '123' } }, { type: 'text', data: { text: ' hi' } }]), '@123 hi')
eq('未知段保留壳', textOfMessage([{ type: 'mface', data: {} }]), '[mface]')
// ★ 2026-11-12 实测补的一条：群里真出现过 markdown 段，只给壳会把话吞掉一半
eq('markdown 取 content 并剥链接', textOfMessage([{ type: 'markdown', data: { content: '[@板栗丶](mqqapi://x/at) 哟，还惦记着回房间呀' } }]), '@板栗丶 哟，还惦记着回房间呀')
eq('markdown 没有 content 时给空', textOfMessage([{ type: 'markdown', data: {} }]), '')
eq('非数组返回空串', textOfMessage(null), '')
eq('空数组', textOfMessage([]), '')

console.log('=== 二、lineOfFrame ===')
eq('正常一帧', lineOfFrame(mkEnv('e1', 'group:1', 1000, msg('张三', '早'))), { nick: '张三', text: '早' })
eq('群名片优先于昵称', lineOfFrame(mkEnv('e2', 'group:1', 1000, { sender: { card: '名片', nickname: '昵称' }, message: [{ type: 'text', data: { text: 'x' } }] })).nick, '名片')
eq('没有 payload → null', lineOfFrame({ event_id: 'x' }), null)
eq('只有图片 → 仍有正文（有壳）', lineOfFrame(mkEnv('e3', 'group:1', 1000, { sender: { nickname: 'n' }, message: [{ type: 'image', data: {} }] })).text, '[图片]')
eq('空正文 → null', lineOfFrame(mkEnv('e4', 'group:1', 1000, { sender: { nickname: 'n' }, message: [] })), null)
eq('没有 sender 也能出（用 user_id 兜底）', lineOfFrame(mkEnv('e5', 'group:1', 1000, { user_id: 42, message: [{ type: 'text', data: { text: 'y' } }] })).nick, '42')

console.log('=== 三、composeWake — 默认白名单 none ===')
const byId = new Map()
byId.set('e1', mkEnv('e1', 'group:661580035', 1000, msg('张三', '在吗')))
byId.set('e2', mkEnv('e2', 'group:661580035', 2000, msg('李四', '在')))
const ev1 = { id: 'evt_1', chatId: 'group:661580035', frameIds: ['e1', 'e2'], openedAt: 1000, closedAt: 5000, windowMs: 4000, rule: 'group' }

let r = composeWake(ev1, byId, {})
eq('默认不叫醒（白名单空）', r.code, 'NOT_ALLOWED')

console.log('=== 四、composeWake — 放行之后 ===')
r = composeWake(ev1, byId, { allow: { all: true } })
ok('成功', r.ok === true)
eq('正文按帧顺序拼', r.text, '张三：在吗\n李四：在')
eq('带出 eventId', r.eventId, 'evt_1')
eq('帧数', r.frames, 2)
eq('没截断', r.truncated, false)

console.log('=== 五、composeWake — 拒绝路径 ===')
eq('空 chatId', composeWake({ id: 'x', frameIds: ['e1'] }, byId, { allow: { all: true } }).code, 'NO_CHAT')
eq('没有 frameIds', composeWake({ id: 'x', chatId: 'group:1' }, byId, { allow: { all: true } }).code, 'NO_FRAMES')
eq('帧在账里找不到', composeWake({ id: 'x', chatId: 'group:661580035', frameIds: ['nope'] }, byId, { allow: { all: true } }).code, 'FRAME_MISSING')
eq('只有图片帧仍能拼', composeWake({ id: 'x', chatId: 'c', frameIds: ['eimg'] }, new Map([['eimg', mkEnv('eimg', 'c', 1, { sender: { nickname: 'n' }, message: [{ type: 'image', data: {} }] })]]), { allow: { all: true } }).text, 'n：[图片]')
eq('无名片无昵称无user_id → 昵称是 ?', composeWake({ id: 'x', chatId: 'c', frameIds: ['e9'] }, new Map([['e9', mkEnv('e9', 'c', 1, { message: [{ type: 'text', data: { text: 'a' } }] })]]), { allow: { all: true } }).text, '?：a')

console.log('=== 六、截断 ===')
const longEv = { id: 'evt_long', chatId: 'group:661580035', frameIds: ['e1'], openedAt: 1, closedAt: 2, windowMs: 1 }
const rt = composeWake(longEv, byId, { allow: { all: true }, maxChars: 3 })
ok('按 maxChars 截断', rt.text.length <= 3 + '…（截断）'.length, rt.text.length)
ok('标记了 truncated', rt.truncated === true)

console.log('=== 七、createEventWaker ===')
const fakeStore = { readAll: () => [...byId.values()] }
const w = createEventWaker({ store: fakeStore, allow: { all: true } })
const out = w.compose([ev1, { id: 'evt_2', chatId: 'group:999', frameIds: ['e1'] }])
ok('compose 返回 ok', out.ok === true)
eq('两条都拼出来', out.asks.length, 2)
eq('统计 ok=2', w.view().ok, 2)
ok('view() 不含正文', !JSON.stringify(w.view()).includes('在吗'))
ok('view() 不含 canary 文本', !JSON.stringify(w.view()).includes('张三'))
eq('没 store 时明确拒绝', createEventWaker({}).compose([ev1]).code, 'NO_STORE')

console.log('=== 八、白名单精确匹配 ===')
const w2 = createEventWaker({ store: fakeStore, allow: { all: false, chats: ['group:661580035'] } })
const o2 = w2.compose([ev1, { id: 'evt_3', chatId: 'group:000', frameIds: ['e1'] }])
eq('只有白名单那个通过', o2.asks.length, 1)
eq('另一个被 NOT_ALLOWED 拦下', o2.skipped.NOT_ALLOWED, 1)

console.log('\n────────────────────────────────────────────')
console.log((fail === 0 ? '通过 ' : '失败 ') + pass + ' 项 · 失败 ' + fail + ' 项')
if (fail) { console.log('失败项：\n  - ' + bad.join('\n  - ')); process.exit(1) }
