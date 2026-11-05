// 表情包（#31）：关掉以后提示词不教她发、发送一律不发；商城表情收进来记住身份、发出去按商城表情原样发；面板改标签会清洗。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let createStickerStore
let rulesText
let normalize

before(async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-stickers-'))
  ;({ createStickerStore } = await import('../src/features/stickers.js'))
  ;({ rulesText } = await import('../src/persona/personas.js'))
  ;({ normalize } = await import('../src/core/config.js'))
})

// 120x120 的 GIF 头 + 两个图形控制扩展（算两帧），够 imageSize / mimeOf 认出来
function gif(seed) {
  const head = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 120, 0, 120, 0, 0, 0, 0])
  const frame = Buffer.from([0x21, 0xf9, 4, 0, 10, 0, 0, 0])
  return Buffer.concat([head, frame, frame, Buffer.from([seed, 0x3b]), Buffer.alloc(40, seed)])
}

const log = { info() {}, warn() {}, debug() {} }

test('#31 关掉表情包：提示词里不再教她写 <sticker:…>', () => {
  const on = rulesText('private', normalize({ ownerQQ: '10001' }))
  assert.match(on, /<sticker:标签>/)
  const off = rulesText('private', normalize({ ownerQQ: '10001', stickers: { enabled: false } }))
  assert.doesNotMatch(off, /<sticker:/)
  const moduleOff = rulesText('private', normalize({ ownerQQ: '10001' }), { off: new Set(['stickers']) })
  assert.doesNotMatch(moduleOff, /<sticker:/)
})

test('#31 商城表情：收进来记住 emoji_id / 包 id / key，发出去按商城表情原样发；普通表情照旧按图片发', async () => {
  const cfg = normalize({ dryRun: true, stickers: { caption: false } })
  const store = createStickerStore({ dsh: {}, getConfig: () => cfg, onebot: { call: async () => ({}) }, log })
  const market = { type: 'image', data: { url: 'base64://' + gif(1).toString('base64'), summary: '[开心]', sub_type: 0, emoji_id: 'abcdef0123456789abcdef0123456789', emoji_package_id: 23456, key: 'k3y' } }
  const r = await store.collect(market, 'group:1')
  assert.equal(r.ok, true, r.reason)
  const item = store.library().items.find((i) => i.market)
  assert.deepEqual(item.market, { emojiId: 'abcdef0123456789abcdef0123456789', packageId: 23456, key: 'k3y' })
  const seg = store.segmentFor({ ...item, name: '开心' })
  assert.deepEqual(seg, { type: 'image', data: { emoji_id: 'abcdef0123456789abcdef0123456789', emoji_package_id: 23456, key: 'k3y', summary: '[开心]' } })

  const plain = { type: 'image', data: { url: 'base64://' + gif(2).toString('base64'), sub_type: 1 } }
  assert.equal((await store.collect(plain, 'group:1')).ok, true)
  const p = store.library().items.find((i) => !i.market)
  const ps = store.segmentFor(p)
  assert.equal(ps.data.sub_type, 1)
  assert.match(ps.data.file, /^base64:\/\/R0lGOD/, '动图原样发（GIF 字节不改）')
})

test('#31 面板改名字 / 标签：去掉 #、去重、最多 5 个，名字最多 12 字', async () => {
  const cfg = normalize({ dryRun: true, stickers: { caption: false } })
  const store = createStickerStore({ dsh: {}, getConfig: () => cfg, onebot: { call: async () => ({}) }, log })
  await store.collect({ type: 'image', data: { url: 'base64://' + gif(3).toString('base64'), sub_type: 1 } }, 'private:1')
  const md5 = store.library().items[0].md5
  const r = store.rename(md5, '  一个特别特别长的表情名字超过十二个字  ', ['#开心', '开心', '卖萌', '', '一二三四五六七八九', 'a', 'b', 'c'])
  assert.equal(r.ok, true)
  assert.equal(r.item.name, '一个特别特别长的表情名字')
  assert.deepEqual(r.item.tags, ['开心', '卖萌', '一二三四五六七八', 'a', 'b'])
  assert.equal(store.rename('nope', 'x').ok, false)
})
