// 生图工具结果：能看图的模型拿原图（image 块），纯文本模型只拿文字
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { drawResultBlocks, imageToolBlock, drawToolMessage } = await import('../src/features/imagegen.js')
const { shrinkImage, shrinkWithSharp, findSharp } = await import('../src/core/img.js')
const { defineTool } = await import('../src/tools/tools.js')

test('drawResultBlocks：有图时文字 + image 块，没图时只有文字', () => {
  // 正常走的是 DSH 附件块（imageToolBlock() 登记过），要原样透传
  const attachment = { type: 'image', attachment: { attachmentId: 'att-1' }, mediaType: 'image/png' }
  const withImg = drawResultBlocks({}, { ok: true, message: '画好发出去了', image: attachment })
  assert.equal(withImg.length, 2)
  assert.deepEqual(withImg[0], { type: 'text', text: '画好发出去了' })
  assert.deepEqual(withImg[1], attachment, '附件块原样进工具结果')

  const noImg = drawResultBlocks({}, { ok: true, message: '画好发出去了' })
  assert.deepEqual(noImg, [{ type: 'text', text: '画好发出去了' }], '纯文本模型只有文字，不能出现 image 块')

  // 形状不对（既没 attachment 也没 data）别硬塞 image 块
  assert.deepEqual(drawResultBlocks({}, { ok: true, message: 'x', image: { mediaType: 'image/png' } }), [{ type: 'text', text: 'x' }])
  assert.deepEqual(drawResultBlocks({}, { ok: true, message: 'x', image: { type: 'image', data: 'AA', mediaType: 'image/png' } }), [{ type: 'text', text: 'x' }], '裸 base64 不能交给 DSH')

  const bad = drawResultBlocks({}, { ok: false, message: '生图服务没配' })
  assert.deepEqual(bad, [{ type: 'text', text: '✗ 生图服务没配' }])
})

test('drawToolMessage：给看了 / 开关关着 / 看不了图，这三种说清楚；不带路径', () => {
  assert.equal(drawToolMessage({ visual: true, seeOwn: true }), '画好发出去了')
  const off = drawToolMessage({ visual: true, seeOwn: false })
  assert.match(off, /没把图给你看/, '「让她画完自己看一眼」关着时如实说')
  const blind = drawToolMessage({ visual: false })
  assert.match(blind, /没能把图片交给你看/)
  for (const msg of [off, blind]) {
    assert.doesNotMatch(msg, /存在\s*[A-Za-z]:[\\\\/]|\.png|读它/, '不能给文件路径')
  }
})

test('imageToolBlock：小图登记成附件块；没附件服务 / 登记失败 → null', async () => {
  const buf = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  const admit = (block) => ({ admitPromptContent: async ([b]) => [{ ...block, mediaType: b.mediaType }] })

  assert.deepEqual(
    await imageToolBlock({ attachments: admit({ type: 'image', attachment: { attachmentId: 'att-9' } }) }, buf),
    { type: 'image', attachment: { attachmentId: 'att-9' }, mediaType: 'image/png' },
  )
  assert.equal(await imageToolBlock({ attachments: admit({ type: 'image', data: 'AA' }) }, buf), null, '宿主没登记附件 → 不带图')
  assert.equal(await imageToolBlock({}, buf), null, '没有附件服务 → 不带图')
  assert.equal(await imageToolBlock({ attachments: { admitPromptContent: async () => { throw new Error('nope') } } }, buf), null, '登记失败 → 不带图')
  assert.equal(await imageToolBlock(null, buf), null, '没有 dsh → 不带图')
  const registered = await imageToolBlock({ attachments: admit({ type: 'image', attachment: { attachmentId: 'att-clean' }, data: 'raw-base64' }) }, buf)
  assert.equal(registered.attachment.attachmentId, 'att-clean')
  assert.equal(registered.data, undefined, '有附件时也不能把原始 base64 留在结果里')
})

test('shrinkImage：没有 ffmpeg 时安静返回 null', async () => {
  const buf = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  assert.equal(await shrinkImage(buf, 512, 'definitely-not-a-real-ffmpeg', { timeoutMs: 800 }), null)
})

test('sharp 缩图：可用时输出 JPEG，不可用或出错返回 null', async () => {
  const calls = []
  const fake = (input) => ({
    rotate: () => calls.push(['rotate', input.length]) && fake(input),
    resize: (o) => { calls.push(['resize', o.width, o.fit]); return fake(input) },
    jpeg: (o) => { calls.push(['jpeg', o.quality]); return fake(input) },
    toBuffer: async () => Buffer.from('small-jpeg'),
  })
  assert.deepEqual(await shrinkWithSharp(fake, Buffer.alloc(2048), 1024), Buffer.from('small-jpeg'))
  assert.ok(calls.some((c) => c[0] === 'resize' && c[1] === 1024))
  assert.equal(await shrinkWithSharp(null, Buffer.alloc(2048), 1024), null, '没有 sharp 就返回 null')
  const broken = () => ({ rotate: () => broken(), resize: () => broken(), jpeg: () => broken(), toBuffer: async () => { throw new Error('坏图') } })
  assert.equal(await shrinkWithSharp(broken, Buffer.alloc(2048), 1024), null, '缩图报错不抛给调用方')
})

test('findSharp：从宿主 asar 目录找 sharp，找不到返回 null', async () => {
  const seen = []
  const importer = async (u) => { seen.push(u); throw new Error('nope') }
  assert.equal(await findSharp({ resourcesPath: 'C:/nope/resources', importer }), null)
  assert.ok(seen[0] === 'sharp')
})

test('缩图进程提前退出时不让 stdin 错误终止宿主', async () => {
  const result = await shrinkImage(Buffer.alloc(16 * 1024 * 1024, 1), 512, process.execPath, { timeoutMs: 3000 })
  assert.equal(result, null)
})

test('defineTool：自定义 render 生效，默认 render 不变', () => {
  const custom = defineTool({
    name: 't1',
    description: 'd',
    execute: async () => ({ ok: true }),
    render: () => [{ type: 'image', data: 'AA', mediaType: 'image/png' }],
  })
  assert.deepEqual(custom.output.render({}, { ok: true }), [{ type: 'image', data: 'AA', mediaType: 'image/png' }])

  const plain = defineTool({ name: 't2', description: 'd', execute: async () => ({ ok: true }) })
  assert.deepEqual(plain.output.render({}, { ok: true, message: '好了' }), [{ type: 'text', text: '好了' }])
  assert.deepEqual(plain.output.render({}, { ok: false, message: '坏了' }), [{ type: 'text', text: '✗ 坏了' }])
})
