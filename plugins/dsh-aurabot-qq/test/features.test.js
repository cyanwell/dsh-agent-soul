import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planDiaryTimes } from '../src/features/qzone.js'
import { moodLabel, scoreText, decayed } from '../src/features/companion.js'
import { matchSticker, pickForReply } from '../src/features/stickers.js'
import { pickBotProcess, readOneBotEndpoint } from '../src/snowluma/manager.js'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('日记排期：窗口内、间隔够、按时间排序', () => {
  let seed = 1
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  for (let i = 0; i < 50; i++) {
    const t = planDiaryTimes({ timesPerDay: 2, windowStart: '10:00', windowEnd: '23:30', minGapMinutes: 180 }, rand)
    assert.equal(t.length, 2)
    assert.ok(t[0] >= 600 && t[1] < 1410)
    assert.ok(t[1] - t[0] >= 180)
  }
  assert.deepEqual(planDiaryTimes({ timesPerDay: 0, windowStart: '10:00', windowEnd: '23:30', minGapMinutes: 180 }), [])
})

test('心情：关键词推动、半衰期回落', () => {
  assert.ok(scoreText('你好可爱 爱你') > 0)
  assert.ok(scoreText('滚 烦死了') < 0)
  assert.equal(scoreText('今天下雨'), 0)
  assert.equal(Math.round(decayed(100, 0, 3, 3 * 3600_000)), 80)
  assert.equal(moodLabel(90), '超开心')
  assert.equal(moodLabel(20), '不太开心')
})

test('表情匹配：按名字和标签', () => {
  const items = [{ md5: 'a', name: '委屈巴巴的小猫', tags: ['委屈'] }, { md5: 'b', name: '得意叉腰', tags: ['开心'] }]
  assert.equal(matchSticker(items, '委屈').md5, 'a')
  assert.equal(matchSticker(items, '开心').md5, 'b')
  assert.equal(matchSticker(items, '完全无关xyz'), null)
  assert.equal(pickForReply(items, '哼 好委屈').md5, 'a')
})

test('只挑机器人号的 QQ 进程，识别不了就不注入', () => {
  const list = [{ pid: 1, account: { uin: 10000001 } }, { pid: 2, account: { uin: 20000002 } }]
  assert.equal(pickBotProcess(list, '20000002').proc.pid, 2)
  assert.equal(pickBotProcess([{ pid: 1, account: { uin: 10000001 } }], '20000002').proc, null)
  assert.equal(pickBotProcess([{ pid: 1, account: null }, { pid: 3, account: null }], '20000002').proc, null)
  assert.equal(pickBotProcess([...list, { pid: 5, account: { uin: 20000002 } }], '20000002').proc, null, '两个进程都声称是机器人号时不注入')
})

test('SnowLuma 认不出号（account: null）：只有一个这样的进程才当候选，且标记要核对', () => {
  const r = pickBotProcess([{ pid: 19224, account: null }], '20000002')
  assert.equal(r.proc.pid, 19224)
  assert.equal(r.unverified, true)
  // 认出是别的号的进程永远不碰
  const r2 = pickBotProcess([{ pid: 1, account: { uin: 10000001 } }, { pid: 2, account: null }], '20000002')
  assert.equal(r2.proc.pid, 2)
  assert.equal(r2.unverified, true)
  // 认出了机器人号就不用核对
  const r3 = pickBotProcess([{ pid: 1, account: null }, { pid: 2, account: { uin: 20000002 } }], '20000002')
  assert.equal(r3.proc.pid, 2)
  assert.ok(!r3.unverified)
  // 重登 QQ 后 SnowLuma 报 uin: "0"（issue #2），也当认不出
  const r4 = pickBotProcess([{ pid: 12345, uin: '0', account: null }], '20000002')
  assert.equal(r4.proc.pid, 12345)
  assert.equal(r4.unverified, true)
  // 核对失败过的进程不再试
  assert.equal(pickBotProcess([{ pid: 19224, account: null }], '20000002', { exclude: [19224] }).proc, null)
})

test('从 SnowLuma 配置读出 OneBot 地址和令牌（单号覆盖全局）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sl-'))
  mkdirSync(join(dir, 'config'))
  writeFileSync(join(dir, 'config', 'onebot.json'), JSON.stringify({ networks: { httpServers: [{ host: '127.0.0.1', port: 3000, accessToken: 'g1' }], wsServers: [{ host: '0.0.0.0', port: 3001, accessToken: 'g2' }] } }))
  writeFileSync(join(dir, 'config', 'onebot_20000002.json'), JSON.stringify({ mode: 'overlay', networks: { httpServers: [{ host: '127.0.0.1', port: 3100, accessToken: 'u1' }] } }))
  const ep = readOneBotEndpoint(dir, '20000002')
  assert.equal(ep.httpUrl, 'http://127.0.0.1:3100')
  assert.equal(ep.httpToken, 'u1')
  assert.equal(ep.wsUrl, 'ws://127.0.0.1:3001')
  assert.equal(ep.wsToken, 'g2')
})

test('WAV 转 16kHz 单声道（给 DSH 语音识别）', async () => {
  const { buildWav, parseWav, toMono16k } = await import('../src/voice/wav.js')
  // 48kHz 立体声 0.5 秒
  const frames = 24000
  const pcm = Buffer.alloc(frames * 4)
  for (let i = 0; i < frames; i++) { const v = Math.round(Math.sin(i / 10) * 8000); pcm.writeInt16LE(v, i * 4); pcm.writeInt16LE(v, i * 4 + 2) }
  const head = buildWav(new Int16Array(0), 48000)
  head.writeUInt16LE(2, 22); head.writeUInt32LE(48000 * 4, 28); head.writeUInt16LE(4, 32); head.writeUInt32LE(pcm.length, 40); head.writeUInt32LE(36 + pcm.length, 4)
  const out = parseWav(toMono16k(Buffer.concat([head, pcm])))
  assert.equal(out.rate, 16000)
  assert.equal(out.channels, 1)
  assert.equal(out.bits, 16)
  assert.equal(out.data.length / 2, 8000)
})

test('记忆检索：切词、相关度、去重', async () => {
  const { tokenize, buildIndex, search, similarity } = await import('../src/features/memory.js')
  assert.deepEqual(tokenize('喜欢吃白米饭'), ['喜欢', '欢吃', '吃白', '白米', '米饭'])
  const items = [
    { id: 'a', text: '主人最爱吃白米饭', importance: 0.8, at: Date.now() },
    { id: 'b', text: '主人周末喜欢打游戏', importance: 0.5, at: Date.now() },
    { id: 'c', text: '小明养了一只橘猫', importance: 0.5, at: Date.now(), about: '123' },
  ]
  const idx = buildIndex(items)
  assert.equal(search(idx, '中午吃米饭吗')[0].it.id, 'a')
  assert.equal(search(idx, '今天打游戏')[0].it.id, 'b')
  assert.equal(search(idx, '你好', { about: '123' })[0].it.id, 'c', '关于当前说话人的记忆有加权')
  assert.equal(search(idx, '量子力学').length, 0)
  assert.ok(similarity('主人最爱吃白米饭', '主人最爱吃白米饭了') > 0.6)
})

test('心情：对她说的话、主人的话影响更大；心情明显时每轮都带上说话方式；影响表情和插话', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const prev = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-mood-'))
  try {
    const { createMood, moodEffects } = await import('../src/features/companion.js')
    const { normalize } = await import('../src/core/config.js')
    const m = createMood({ getConfig: () => normalize({}) })
    const v0 = m.current()
    m.observe('你好可爱', '路人', { direct: false })
    const vIndirect = m.current() - v0
    m.observe('你好可爱', '主人', { direct: true, owner: true })
    const vOwner = m.current() - v0 - vIndirect
    assert.ok(vOwner > vIndirect * 3, '主人对她说的比群里顺带的影响大得多')
    for (let i = 0; i < 4; i++) m.observe('好可爱 爱你 抱抱', '主人', { direct: true, owner: true })
    assert.equal(m.label(), '超开心')
    const line = m.contextLine()
    assert.match(line, /超开心/)
    assert.match(line, /话多/)
    assert.equal(m.contextLine(), line, '不是只提醒一次，每轮都在')
    assert.ok(m.effects().sticker > 1 && m.effects().chatty > 1)
    assert.equal(m.state().history.length, 6)
    m.nudge(-80, '被凶了')
    assert.match(m.contextLine(), /小脾气/)
    assert.ok(m.effects().sticker < 1 && m.effects().delay > 1)
    // 平平常常时什么都不说
    assert.equal(moodEffects(60).sticker, 1)
    const m2 = createMood({ getConfig: () => normalize({ mood: { enabled: false } }) })
    assert.equal(m2.contextLine(), '')
  } finally {
    process.env.AURABOT_DATA_DIR = prev
  }
})

test('表情库上限：只清偷来的、最少用的、最老的', async () => {
  const { pickEvict } = await import('../src/features/stickers.js')
  const items = [
    { md5: 'a', from: 'group:1', uses: 3, at: 1 },
    { md5: 'b', from: 'group:1', uses: 0, at: 5 },
    { md5: 'c', from: 'group:1', uses: 0, at: 2 },
    { md5: 'd', from: 'manual', uses: 0, at: 0 },
  ]
  assert.equal(pickEvict(items).md5, 'c')
  assert.equal(pickEvict([{ md5: 'd', from: 'manual' }]), null, '你自己加的不清')
})

test('模型判心情：解析结果，没把握的不算，开了就不再按关键词', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const prev = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-judge-'))
  try {
    const { createMood, parseMoodJudge } = await import('../src/features/companion.js')
    const { normalize } = await import('../src/core/config.js')
    assert.deepEqual(parseMoodJudge('好的 {"delta": 30, "reason": "被夸了", "confidence": 0.9}'), { delta: 15, reason: '被夸了', confidence: 0.9 })
    assert.equal(parseMoodJudge('不是 JSON'), null)
    let answer = '{"delta": 8, "reason": "主人惦记她", "confidence": 0.9}'
    const asked = []
    const dsh = { get: () => null, llm: { async *stream({ system }) { asked.push(system); yield { type: 'text-delta', text: answer }; yield { type: 'finish', reason: { kind: 'completed' } } } } }
    const cfg = normalize({ mood: { judge: true }, model: { provider: 'p', model: 'm' } })
    const m = createMood({ getConfig: () => cfg, dsh })
    const v0 = m.current()
    m.observe('讨厌 滚', '路人', { direct: true })
    assert.equal(m.current(), v0, '开了模型判断，关键词不再起作用')
    await m.judge({ userText: '想你了', reply: '我也想你', who: '主人', origin: 'speak-up' })
    assert.equal(m.current(), v0 + 8)
    assert.match(asked[0], /主动去找/)
    answer = '{"delta": -10, "reason": "猜的", "confidence": 0.3}'
    await m.judge({ userText: '嗯', reply: '哦' })
    assert.equal(m.current(), v0 + 8, '没把握的不算')
  } finally {
    process.env.AURABOT_DATA_DIR = prev
  }
})

test('语音：语速 / 音调只认 ±N% 和 ±NHz，写着玩的和超范围的都回落/夹回来', async () => {
  const { normalize } = await import('../src/core/config.js')
  const v = (voice) => normalize({ voice }).voice
  // 音调（edge-tts 的 --pitch）
  assert.equal(v({ pitch: '+20Hz' }).pitch, '+20Hz')
  assert.equal(v({ pitch: '20Hz' }).pitch, '+20Hz', '没写正负号也当正')
  assert.equal(v({ pitch: '-10hz' }).pitch, '-10Hz', '大小写不敏感')
  assert.equal(v({ pitch: '999Hz' }).pitch, '+80Hz', '超范围夹到 ±80Hz（滑条上限）')
  assert.equal(v({ pitch: '-999Hz' }).pitch, '-80Hz')
  assert.equal(v({ pitch: '+0Hz' }).pitch, '+0Hz', '0 也要带正号，否则滑条/下拉框对不上')
  assert.equal(v({ pitch: '0Hz' }).pitch, '+0Hz', '缺正号的补上')
  assert.equal(v({ pitch: '大声点' }).pitch, '+0Hz', '乱写的回落默认')
  assert.equal(v({ pitch: '' }).pitch, '+0Hz')
  // 语速（edge-tts 的 --rate）
  assert.equal(v({ rate: '+10%' }).rate, '+10%')
  assert.equal(v({ rate: '-5%' }).rate, '-5%')
  assert.equal(v({ rate: '999%' }).rate, '+50%')
  assert.equal(v({ rate: '+0%' }).rate, '+0%', '正常语速也要带正号')
  assert.equal(v({ rate: '0%' }).rate, '+0%')
  assert.equal(v({ rate: '快一点' }).rate, '+0%')
})
