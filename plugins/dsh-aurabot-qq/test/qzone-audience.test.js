import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-audience-'))

const { resolveAudience, parseAudienceQQs, AUDIENCE_RIGHTS } = await import('../src/features/qzone-audience.js')
const { createQzone } = await import('../src/features/qzone.js')
const { normalize } = await import('../src/core/config.js')

const cfg = (visibility, audienceQQs = '') => ({ enabled: true, dryRun: false, diary: { visibility, audienceQQs, minChars: 10, maxChars: 140 } })

test('五种可见范围映射到 QQ 空间的权限位', () => {
  assert.deepEqual(AUDIENCE_RIGHTS, { all: 1, friends: 4, selected: 16, self: 64, excluded: 128 })
  for (const [mode, right] of Object.entries(AUDIENCE_RIGHTS)) {
    const list = mode === 'selected' || mode === 'excluded' ? '10001\n10002' : ''
    const r = resolveAudience(cfg(mode, list))
    assert.equal(r.visibility, mode)
    assert.equal(r.ugc_right, right)
    assert.ok(r.label)
  }
})

test('没配可见范围时按「所有人」发', () => {
  const r = resolveAudience({ diary: {} })
  assert.equal(r.visibility, 'all')
  assert.equal(r.ugc_right, 1)
})

test('配置里写了不认识的范围就报错，不猜', () => {
  assert.throws(() => resolveAudience(cfg('everyone')), /配置无效/)
})

test('单次请求可以收窄到「仅自己」', () => {
  const r = resolveAudience(cfg('all'), 'self')
  assert.equal(r.visibility, 'self')
  assert.equal(r.ugc_right, 64)
})

test('单次请求不能把范围放大', () => {
  assert.equal(resolveAudience(cfg('self'), 'all').visibility, 'self')
  assert.equal(resolveAudience(cfg('self'), 'friends').visibility, 'self')
  assert.equal(resolveAudience(cfg('selected', '10001'), 'all').visibility, 'selected')
})

test('部分好友可见：名单进 target_uins', () => {
  const r = resolveAudience(cfg('selected', '10001, 10002；10003\n10002'))
  assert.equal(r.ugc_right, 16)
  assert.deepEqual(r.target_uins, [10001, 10002, 10003])
})

test('部分好友不可见：同样带名单和权限位', () => {
  const r = resolveAudience(cfg('excluded', '10001'))
  assert.equal(r.ugc_right, 128)
  assert.deepEqual(r.target_uins, [10001])
})

test('部分好友范围但名单为空：报错，不退回公开', () => {
  assert.throws(() => resolveAudience(cfg('selected', '')), /名单为空/)
  assert.throws(() => resolveAudience(cfg('excluded', '   ')), /名单为空/)
})

test('名单校验：非法 QQ、超长都拒绝', () => {
  assert.throws(() => parseAudienceQQs('abc'), /合法 QQ/)
  assert.throws(() => parseAudienceQQs('123'), /合法 QQ/)
  assert.throws(() => parseAudienceQQs('010001'), /合法 QQ/)
  const over = Array.from({ length: 201 }, (_, i) => String(10000 + i)).join('\n')
  assert.throws(() => parseAudienceQQs(over), /最多填写 200/)
})

test('名单解析：去重、支持中英文逗号分号和空白', () => {
  assert.deepEqual(parseAudienceQQs('10001,10002，10003;10004 10001'), [10001, 10002, 10003, 10004])
  assert.deepEqual(parseAudienceQQs(['10001', '10001', ' 10002 ']), [10001, 10002])
})

test('配置归一化：保留五种范围，其余回落 all，并清洗名单', () => {
  assert.equal(normalize({ diary: { visibility: 'excluded' } }).diary.visibility, 'excluded')
  assert.equal(normalize({ diary: { visibility: 'friends' } }).diary.visibility, 'friends')
  assert.equal(normalize({ diary: { visibility: 'nonsense' } }).diary.visibility, 'all')
  const c = normalize({ diary: { visibility: 'selected', audienceQQs: '10001，10002\n10001' } })
  assert.equal(c.diary.audienceQQs, '10001\n10002')
})

test('post()：部分好友可见时把 ugc_right 和 target_uins 一起发出去', async () => {
  const calls = []
  const qzone = createQzone({
    getConfig: () => cfg('selected', '10001\n10002'),
    onebot: { async call(action, params) { calls.push({ action, params }); return { tid: 't9' } } },
    hub: { chatLogOf: () => [] },
    log: { info() {}, warn() {} },
  })
  const r = await qzone.post('今天想吃白米饭')
  assert.equal(r.ok, true)
  assert.equal(r.visibility, 'selected')
  assert.equal(calls[0].params.ugc_right, 16)
  assert.deepEqual(calls[0].params.target_uins, [10001, 10002])
})

test('post()：名单为空时一条都不发', async () => {
  const calls = []
  const qzone = createQzone({
    getConfig: () => cfg('selected', ''),
    onebot: { async call(action, params) { calls.push({ action, params }) } },
    hub: { chatLogOf: () => [] },
    log: { info() {}, warn() {} },
  })
  const r = await qzone.post('今天想吃白米饭')
  assert.equal(r.ok, false)
  assert.match(r.message, /名单为空/)
  assert.equal(calls.length, 0)
})
