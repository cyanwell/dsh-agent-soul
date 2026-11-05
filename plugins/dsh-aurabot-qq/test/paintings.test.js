// 「她的画作」图库：存图、扫描目录、排序/限量、删单张、开文件夹、路径安全
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'aurabot-paint-'))
process.env.AURABOT_DATA_DIR = dataDir
const paintDir = join(dataDir, 'imagegen')
mkdirSync(paintDir, { recursive: true })

const { listPaintings, paintingPath, removePainting, safeName, metaOf, openPaintFolder, savePainting } = await import('../src/features/paintings.js')

// 最小 PNG 头（只要扩展名/媒体类型判断用得上）
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)])
const mk = (name) => writeFileSync(join(paintDir, name), PNG)

test('存一份：文件名带时间和提示词，扩展名按图片类型', () => {
  const file = savePainting(PNG, '一只橘猫', { now: new Date(2026, 9, 27, 1, 45, 1) })
  assert.equal(paintingPath.safeName, undefined) // 只是提醒：下面的断言看内容
  assert.match(file, /20261027-014501-一只橘猫\.png$/)
  const jpg = savePainting(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16)]), '猫/狗 混排', { now: new Date(2026, 9, 27, 2, 0, 0) })
  assert.match(jpg, /20261027-020000-猫-狗-混排\.jpg$/, '提示词里的斜杠/空格会被换成横线')
  assert.equal(listPaintings({ limit: 50 }).total >= 2, true)
})

test('按时间倒序、只给最近 N 张，N 夹在 1~50', () => {
  mk('20261028-010000-第一张.png')
  mk('20261028-020000-第二张.png')
  mk('20261028-030000-第三张.jpg')
  const all = listPaintings({ limit: 10 })
  assert.deepEqual(all.items.map((x) => x.prompt).slice(0, 3), ['第三张', '第二张', '第一张'])
  assert.equal(all.items[0].file, '20261028-030000-第三张.jpg')

  const two = listPaintings({ limit: 2 })
  assert.equal(two.items.length, 2)
  assert.equal(two.total, all.total, '总数不受显示数量影响')

  assert.equal(listPaintings({ limit: 0 }).limit, 1, '0 会被夹到 1')
  assert.equal(listPaintings({ limit: 999 }).limit, 50, '超过 50 夹到 50')
  assert.equal(listPaintings({}).limit, 20, '默认 20')
})

test('文件名里的时间和提示词能解析出来', () => {
  const m = metaOf('20261028-014501-一只橘猫.png')
  assert.equal(m.prompt, '一只橘猫')
  assert.equal(new Date(m.at).getFullYear(), 2026)
  assert.equal(new Date(m.at).getMonth(), 9) // 10 月
  assert.equal(new Date(m.at).getDate(), 28)
})

test('路径安全：挡住 ../、绝对路径和非图片', () => {
  assert.equal(safeName('../secret.png'), '')
  assert.equal(safeName('..\\secret.png'), '')
  assert.equal(safeName('C:\\Windows\\x.png'), '')
  assert.equal(safeName('notes.txt'), '')
  assert.equal(safeName('ok.png'), 'ok.png')
  assert.equal(paintingPath('不存在.png'), '')
  assert.equal(paintingPath('20261028-010000-第一张.png') !== '', true)
})

test('删单张：只删目录里那张，并且能从列表里消失', () => {
  const before = listPaintings({ limit: 50 }).total
  const r = removePainting('20261028-010000-第一张.png')
  assert.equal(r.ok, true)
  assert.equal(listPaintings({ limit: 50 }).total, before - 1)
  assert.equal(removePainting('20261028-010000-第一张.png').ok, false, '再删一次会说已经不在了')
  assert.equal(removePainting('../x.png').ok, false, '非法文件名直接拒')
})

test('打开文件夹：Windows 用 explorer，路径是存图目录', () => {
  const calls = []
  const run = (bin, args) => ({ unref () { calls.push({ bin, args }) } })
  const r = openPaintFolder({ run, platform: 'win32' })
  assert.equal(r.ok, true)
  assert.equal(calls[0].bin, 'explorer.exe')
  assert.equal(calls[0].args[0], paintDir)
  assert.ok(r.path.endsWith('imagegen'))
  openPaintFolder({ run, platform: 'darwin' })
  assert.equal(calls[1].bin, 'open')
  openPaintFolder({ run, platform: 'linux' })
  assert.equal(calls[2].bin, 'xdg-open')
})

test('目录不存在时返回空列表而不是报错，也不顺手建目录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-paint-empty-'))
  process.env.AURABOT_DATA_DIR = dir
  const r = listPaintings({ limit: 10 })
  assert.deepEqual(r.items, [])
  assert.equal(r.total, 0)
  assert.equal(readdirSync(dir).length, 0)
  process.env.AURABOT_DATA_DIR = dataDir
})

test('画作引用：记住后能按编号 / 别名 / 文件名解析；不认识的编号不行', async () => {
  const { rememberPainting, resolvePainting, recentPaintings } = await import('../src/features/paintings.js')
  const { basename } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'aurabot-paint-ref-'))
  process.env.AURABOT_DATA_DIR = root
  mkdirSync(join(root, 'imagegen'), { recursive: true })
  try {
    const a = savePainting(PNG, '第一张', { now: new Date(2026, 9, 28, 1, 0, 0) })
    assert.equal(rememberPainting('private:1', a), 1)
    const b = savePainting(PNG, '第二张', { now: new Date(2026, 9, 28, 2, 0, 0) })
    assert.equal(rememberPainting('private:1', b), 1, '#1 永远是最新那张')
    assert.equal(resolvePainting('private:1', '#1').file, basename(b))
    assert.equal(resolvePainting('private:1', '1').file, basename(b))
    assert.equal(resolvePainting('private:1', '最新').file, basename(b))
    assert.equal(resolvePainting('private:1', '#2').file, basename(a))
    assert.equal(resolvePainting('private:1', basename(a)).file, basename(a))
    assert.equal(resolvePainting('private:1', '#999'), null, '不认识的编号不给')
    assert.equal(resolvePainting('private:2', '#1'), null, '别的聊天里没有这个编号')
    assert.equal(resolvePainting('private:1', '../x.png'), null, '非法文件名不给')
    assert.deepEqual(recentPaintings('private:1', 2).map((x) => x.prompt), ['第二张', '第一张'])
  } finally {
    process.env.AURABOT_DATA_DIR = dataDir
  }
})

test('面板：图库要拿到 toast，删完才会自动刷新', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.match(src, /function PaintGallery\(\{ draft, setDraft, toast \}\)/, 'PaintGallery 要接收 toast')
  assert.match(src, /h\(PaintGallery, \{ draft, setDraft, toast \}\)/, '渲染时要传 toast')
  // 删完要重新拉列表
  assert.match(src, /const del = async \(file\) => \{[\s\S]{0,400}?load\(\)/, '删除后要调用 load()')
})
