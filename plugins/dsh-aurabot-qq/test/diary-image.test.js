// 空间日记配图：优先今天她画的图，其次今天收的表情包；都没有就只发文字。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const setDataDir = () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-diaryimg-'))
  return process.env.AURABOT_DATA_DIR
}

test('空间日记配图：优先今天她画的最新一张，昨天的不算', async () => {
  const root = setDataDir()
  const { pickDiaryImage } = await import('../src/features/diary-image.js')
  const { savePainting } = await import('../src/features/paintings.js')
  const now = new Date(2026, 9, 29, 16, 0)
  assert.equal(pickDiaryImage({ now }), '', '空数据目录时没有配图')
  savePainting(PNG, '昨天的画', { now: new Date(2026, 9, 28, 12, 0) })
  assert.equal(pickDiaryImage({ now }), '', '昨天的画不配今天的日记')
  const today = savePainting(PNG, '今天的画', { now: new Date(2026, 9, 29, 9, 30) })
  assert.equal(pickDiaryImage({ now }), today, '用今天画的那张')
  const newer = savePainting(PNG, '下午画的', { now: new Date(2026, 9, 29, 15, 0) })
  assert.equal(pickDiaryImage({ now }), newer, '多张时用最新那张')
  assert.ok(today)
  assert.ok(root)
})

test('空间日记配图：今天没画图就用今天收的表情包；都没有就空', async () => {
  const root = setDataDir()
  const { pickDiaryImage } = await import('../src/features/diary-image.js')
  const now = new Date(2026, 9, 29, 16, 0)
  const sdir = join(root, 'stickers')
  mkdirSync(sdir, { recursive: true })
  writeFileSync(join(sdir, 'old.png'), PNG)
  writeFileSync(join(sdir, 'new.png'), PNG)
  const item = (file, at, md5) => ({ md5, file, at, name: '', tags: [], from: 'collect' })
  writeFileSync(join(sdir, 'index.json'), JSON.stringify({ items: [item('old.png', new Date(2026, 9, 28, 10, 0).getTime(), 'a')] }))
  assert.equal(pickDiaryImage({ now }), '', '昨天收的表情不配今天的日记')
  writeFileSync(join(sdir, 'index.json'), JSON.stringify({ items: [
    item('old.png', new Date(2026, 9, 28, 10, 0).getTime(), 'a'),
    item('new.png', new Date(2026, 9, 29, 11, 0).getTime(), 'b'),
  ] }))
  assert.equal(pickDiaryImage({ now }), join(sdir, 'new.png'), '用今天最新收的表情')
})
