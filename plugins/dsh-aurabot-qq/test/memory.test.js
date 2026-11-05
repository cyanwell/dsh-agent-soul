// 记忆整理：一天两次、增量处理不重复、学说话方式。用假的模型和假的聊天流水。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let createMemoryStore
let normalize
const asked = []

// 假模型：按系统提示词判断是哪种请求
const dsh = {
  get: () => null,
  llm: {
    async *stream({ system, messages }) {
      const text = messages[0].content[0].text
      asked.push({ system, text })
      let out = '[]'
      if (system.includes('整理长期记忆') && text.includes('戒辣')) {
        const id = (text.match(/#(\w+) [^\n]*喜欢吃辣/) || [])[1]
        out = JSON.stringify([{ op: 'outdated', id, text: '小明戒辣了', about: '小明', importance: 0.6 }])
      } else if (system.includes('人物小档案')) out = '小明是主人，最近戒辣了，爱钓鱼'
      else if (system.includes('整理长期记忆')) out = text.includes('看海') ? '[{"text":"阿花周末去看海了","about":"阿花","about_qq":"30000003","importance":0.5}]' : text.includes('辣') ? '[{"text":"小明喜欢吃辣","about":"小明","importance":0.6}]' : '[]'
      else if (system.includes('{"insights"')) out = '{"insights":["他喜欢被吐槽"],"style":["消息很短，常一句话分几条发","爱用 hhh"]}'
      else if (system.includes('自然会被带上')) out = '["偶尔用 hhh"]'
      else if (system.includes('旧档案')) out = '[{"text":"阿强喜欢钓鱼","about":"阿强","importance":0.7},{"text":"阿花周末去看海了","about":"阿花"}]'
      yield { type: 'text-delta', text: out }
      yield { type: 'finish', reason: { kind: 'completed' } }
    },
  },
}

const logs = new Map() // day → lines
const hubState = { text: '', speakers: [] }
const hub = {
  chatLogDays: () => [...logs.keys()].sort(),
  chatLogOf: (day) => logs.get(day) || [],
  deleteChatLog: (day) => logs.delete(day),
  lastTextOf: () => hubState.text,
  speakersOf: () => hubState.speakers,
  prevTextOf: () => hubState.prev || '',
}
const line = (text, who = '小明') => ({ chatId: 'private:10000001', who, text })
const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

let cfg
let mem

before(async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-mem-'))
  ;({ createMemoryStore } = await import('../src/features/memory.js'))
  ;({ normalize } = await import('../src/core/config.js'))
  cfg = normalize({ model: { provider: 'p', model: 'm' } })
  mem = createMemoryStore({ dsh, getConfig: () => cfg, hub, log: { info() {}, warn() {}, debug() {} } })
})

test('默认一天整理两次；老配置的单个时间自动变成两个', () => {
  assert.deepEqual(normalize({}).memory.consolidateTimes, ['04:00', '16:00'])
  assert.deepEqual(normalize({ memory: { consolidateAt: '03:30' } }).memory.consolidateTimes, ['03:30', '15:30'])
})

test('整理：提炼记忆、相处经验和说话方式；同一天再整理只处理新增的聊天', async () => {
  const today = day(new Date())
  logs.set(today, [line('我超爱吃辣'), line('hhh'), line('今天好累'), line('嗯嗯', 'bot')])
  let r = await mem.consolidate({ includeToday: true })
  assert.equal(r.ok, true, r.message)
  assert.equal(r.added, 1)
  assert.equal(mem.insights()[0].list[0].text, '他喜欢被吐槽')
  assert.deepEqual(mem.styles()['qq:10000001'], ['消息很短，常一句话分几条发', '爱用 hhh'])
  assert.ok(logs.has(today), '今天的流水留着（写日记要用）')

  // 下午再整理：前面那 4 行不会再交给模型
  const n = asked.filter((a) => a.system.includes('整理长期记忆')).length
  r = await mem.consolidate({ includeToday: true })
  assert.equal(asked.filter((a) => a.system.includes('整理长期记忆')).length, n, '没有新聊天就不再提炼')

  logs.get(today).push(line('周末去爬山'), line('你去不去'), line('hhh 来嘛'))
  await mem.consolidate({ includeToday: true })
  const last = asked.filter((a) => a.system.includes('整理长期记忆')).at(-1)
  assert.ok(last.text.includes('爬山') && !last.text.includes('爱吃辣'), '只处理新的那几行')
})

test('说话方式会进到聊天上下文里', () => {
  const ctx = mem.contextFor({ kind: 'private', userId: '10000001', chatId: 'private:10000001' }, 's1')
  assert.match(ctx, /说话方式/)
  assert.match(ctx, /hhh/)
  assert.match(ctx, /别刻意模仿/)
})

test('过了一天的流水整理完删掉', async () => {
  const y = new Date(Date.now() - 86400000)
  logs.set(day(y), [line('昨天吃了火锅 好辣'), line('哈哈'), line('晚安')])
  await mem.consolidate({ includeToday: false })
  assert.equal(logs.has(day(y)), false)
})

test('检索：同时偏向好几个说话人（群里这一段谁在说）', async () => {
  const { buildIndex, search } = await import('../src/features/memory.js')
  const idx = buildIndex([
    { id: 'a', text: '阿花养了一只猫', about: '30000003', importance: 0.5, at: Date.now() },
    { id: 'b', text: '小明在学吉他', about: '30000004', importance: 0.5, at: Date.now() },
    { id: 'c', text: '天气预报说要下雨', about: '', importance: 0.5, at: Date.now() },
  ])
  const ids = search(idx, '今天干嘛呢', { about: ['30000003', '30000004'] }).map((h) => h.it.id).sort()
  assert.deepEqual(ids, ['a', 'b'])
})

test('经历：她做过的事常驻上下文；群里优先想起正在说话的人', () => {
  mem.addEvent({ text: '给主人唱了《小幸运》', about: '10000001', tags: ['唱歌'] })
  assert.equal(mem.recentEvents()[0].text, '给主人唱了《小幸运》')
  const ctx = mem.contextFor({ kind: 'private', userId: '10000001', chatId: 'private:10000001' }, 's1')
  assert.match(ctx, /你最近做过的事：刚才给主人唱了《小幸运》/)
  mem.add({ text: '阿花最近在减肥', about: '30000003', aboutName: '阿花', importance: 0.6, source: 'tool' })
  hubState.text = '今天吃什么'
  hubState.speakers = ['30000003']
  const g = mem.contextFor({ kind: 'group', groupId: '555', chatId: 'group:555' }, 's2')
  // #79：随消息变化的相关记忆不再进每轮都会追加的上下文快照，改由 recallHint 跟着当轮用户消息走
  assert.doesNotMatch(g, /阿花最近在减肥/)
  assert.doesNotMatch(g, /你记得这些事/)
  const hint = mem.recallHint({ kind: 'group', groupId: '555', chatId: 'group:555' }, '阿花最近在减肥吗')
  assert.match(hint, /阿花最近在减肥/)
  assert.doesNotMatch(hint, /小幸运/, '最近经历已经列过的不重复')
  assert.ok(hint.length <= 350, '相关记忆提示要短，实际 ' + hint.length)
  hubState.text = ''
  hubState.speakers = []
})

test('整理：群聊和空间里的事按 QQ 号记到人头上；空间动态一条也提炼', async () => {
  const today = day(new Date())
  logs.set(today, [...(logs.get(today) || []), { chatId: 'qzone', who: '阿花', uid: '30000003', text: '发了说说：周末去看海了' }])
  const n = asked.length
  await mem.consolidate({ includeToday: true })
  const qz = asked.slice(n).find((a) => a.system.includes('QQ 空间里的动态'))
  assert.ok(qz && qz.text.includes('阿花(30000003)'), '空间流水带着 QQ 号交给模型')
  assert.ok(!asked.slice(n).some((a) => a.system.includes('{"insights"') && a.text.includes('看海')), '空间不回顾相处经验')
  const hit = mem.list('看海')[0]
  assert.equal(hit.about, '30000003')
})

test('遗忘：不重要、两个月没想起过的自动记忆忘掉，自己记的和经历不忘', async () => {
  const { shouldForget } = await import('../src/features/memory.js')
  const old = Date.now() - 90 * 86400_000
  assert.equal(shouldForget({ source: 'auto', importance: 0.4, at: old }), true)
  assert.equal(shouldForget({ source: 'auto', importance: 0.4, at: old, lastHit: Date.now() }), false, '最近被想起过')
  assert.equal(shouldForget({ source: 'auto', importance: 0.8, at: old }), false, '重要的不忘')
  assert.equal(shouldForget({ source: 'tool', importance: 0.3, at: old }), false)
  assert.equal(shouldForget({ source: 'event', importance: 0.3, at: old }), false)
})

test('想起来的记忆带时间；最近想起了什么有记录（含想不起来的那次）', async () => {
  const { whenText } = await import('../src/features/memory.js')
  const now = new Date(2026, 9, 25, 12).getTime()
  assert.equal(whenText(now, now), '今天')
  assert.equal(whenText(now - 86400_000, now), '昨天')
  assert.equal(whenText(now - 3 * 86400_000, now), '3 天前')
  assert.equal(whenText(now - 400 * 86400_000, now).startsWith('去年'), true)
  hubState.text = '阿花最近怎么样'
  const hint = mem.recallHint({ kind: 'private', userId: '30000003', chatId: 'private:30000003' }, '阿花最近怎么样')
  assert.ok(hint.includes('[今天] [阿花] 阿花'), hint)
  const log = mem.recalls()[0]
  assert.equal(log.where, 'private:30000003')
  assert.ok(log.hits.length && log.hits[0].why.length)
  hubState.text = '完全无关的量子力学'
  mem.recallHint({ kind: 'group', groupId: '9', chatId: 'group:9' }, '完全无关的量子力学')
  assert.equal(mem.recalls()[0].hits.length, 0)
  hubState.text = ''
})

test('导入旧档案：挑出候选、去掉已经记过的，勾选后存进去', async () => {
  const c = await mem.importCandidates('一大段旧档案：阿强喜欢钓鱼。阿花周末去看海了。')
  assert.deepEqual(c.map((x) => x.text), ['阿强喜欢钓鱼'], '阿花看海已经记过，去掉')
  assert.equal(mem.importCommit(c), 1)
  assert.equal(mem.list('钓鱼')[0].source, 'import')
})

test('遗忘曲线：没被想起的两个月左右淡掉；隔几天就被想起的记得久', async () => {
  const { retention, shouldForget } = await import('../src/features/memory.js')
  const now = Date.now()
  const base = { source: 'auto', importance: 0.5, at: now - 60 * 86400_000 }
  assert.ok(retention(base, now) < 0.06)
  assert.equal(shouldForget(base, now), true)
  const often = { ...base, hitDays: 5, lastHit: now - 30 * 86400_000 }
  assert.ok(retention(often, now) > 0.7)
  assert.equal(shouldForget(often, now), false)
  assert.equal(shouldForget({ ...base, invalidAt: now - 10 * 86400_000 }, now), false, '过时的先留着')
  assert.equal(shouldForget({ ...base, invalidAt: now - 200 * 86400_000 }, now), true)
})

test('整理时比对旧记忆：新事实说明旧的过时了，旧的标过时（不删），想起来的是新的', async () => {
  const old = mem.list('喜欢吃辣').find((m) => m.text === '小明喜欢吃辣')
  assert.ok(old)
  const today = day(new Date())
  logs.get(today).push(line('我最近戒辣了'), line('胃不好'), line('医生让我少吃'))
  await mem.consolidate({ includeToday: true })
  const asked1 = asked.filter((a) => a.system.includes('整理长期记忆')).at(-1)
  assert.ok(asked1.text.includes('#' + old.id), '旧记忆带着编号交给模型比对')
  const all = mem.list('')
  const was = all.find((m) => m.id === old.id)
  assert.ok(was.invalidAt, '旧的标成过时')
  const now = all.find((m) => m.text === '小明戒辣了')
  assert.ok(now && !now.invalidAt)
  assert.equal(was.supersededBy, now.id)
  assert.equal(was.supersededText, '小明戒辣了')
  assert.equal(all.at(-1).id, old.id, '过时的排在最后')
  hubState.text = '吃辣'
  const ctx = mem.recallHint({ kind: 'private', userId: '10000001', chatId: 'private:10000001' }, '吃辣')
  assert.ok(ctx.includes('小明戒辣了') && !ctx.includes('小明喜欢吃辣'), ctx)
  assert.equal(mem.stats().outdated, 1)
  assert.equal(mem.restore(old.id).ok, true)
  assert.ok(!mem.list('').find((m) => m.id === old.id).invalidAt)
  mem.remove(old.id)
  hubState.text = ''
})

test('人物小档案：按这个人的记忆写，聊天时常驻；群里带上正在说话的人', async () => {
  mem.add({ text: '小明爱钓鱼', about: '10000001', aboutName: '小明', source: 'tool' })
  mem.add({ text: '小明是程序员', about: '10000001', aboutName: '小明', source: 'tool' })
  mem.add({ text: '小明养了一只狗', about: '10000001', aboutName: '小明', source: 'tool' })
  assert.equal(await mem.buildProfile('10000001'), true)
  assert.equal(mem.profiles()[0].qq, '10000001')
  hubState.text = '在干嘛'
  const p = mem.contextFor({ kind: 'private', userId: '10000001', chatId: 'private:10000001' }, 's6')
  assert.match(p, /你对对方的印象：小明是主人/)
  hubState.speakers = ['10000001']
  const g = mem.contextFor({ kind: 'group', groupId: '7', chatId: 'group:7' }, 's7')
  assert.match(g, /你对正在说话的人的印象：小明——小明是主人/)
  assert.equal(await mem.buildProfile('99999999'), false, '记忆太少不写')
  hubState.speakers = []
  hubState.text = ''
})

test('短句（「嗯嗯」）想不起东西时，连上一句一起找', () => {
  hubState.text = '嗯嗯'
  hubState.prev = '你还记得阿强喜欢干啥吗 钓鱼'
  const ctx = mem.recallHint({ kind: 'group', groupId: '8', chatId: 'group:8' }, '嗯嗯', '你还记得阿强喜欢干啥吗 钓鱼')
  assert.match(ctx, /阿强喜欢钓鱼/)
  assert.ok(mem.recalls()[0].hits.some((h) => h.why.includes('（上一句）')))
  hubState.text = ''
  hubState.prev = ''
})

test('相关记忆提示有长度上限（#79：上下文增长优化）', () => {
  for (let i = 0; i < 20; i++) mem.add({ text: '测试记忆第' + i + '条，内容是阿花喜欢的东西和周末计划', about: '30000003', aboutName: '阿花', importance: 0.5, source: 'tool' })
  const hint = mem.recallHint({ kind: 'group', groupId: '555', chatId: 'group:555' }, '阿花喜欢什么 周末计划')
  assert.ok(hint.length > 0 && hint.length <= 350, 'hint 长度 ' + hint.length)
})
